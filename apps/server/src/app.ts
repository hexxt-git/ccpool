import { Hono, type Context } from "hono";
import {
  AccountConflictError,
  CAP_KINDS,
  RegistryConflictError,
  type ApiError,
  type ApiErrorCode,
  type CapKind,
} from "@ccshare/core";
import { FailureDamper, hashPassword, hashToken, mintToken, verifyPassword } from "./auth.js";
import type { GroupRow, MemberRow, ServerDeps } from "./deps.js";
import { parseCreateGroup, parseIngest, parseJoinGroup, parseLogin } from "./validate.js";

export type { ServerDeps } from "./deps.js";
export { makeMemoryDeps } from "./memory-deps.js";

/** Ingest bodies above this are refused outright (a tick is a few KB). */
const MAX_INGEST_BYTES = 1024 * 1024;
/** lastUsedAt is bookkeeping — write it at most once a minute per token. */
const TOKEN_TOUCH_INTERVAL_MS = 60_000;
/**
 * In-process token→identity cache (ADR-0006 §1). Steady-state ingest/view under
 * thousands of daemons would otherwise do a `resolveToken` DB read every request;
 * this serves the hot path from RAM. A short TTL bounds staleness — a rebind
 * (`accountId` null→uuid) or a rotated/revoked token self-heals within it — so no
 * explicit invalidation is needed. Bounded in size (LRU-ish: oldest evicted).
 */
const TOKEN_CACHE_TTL_MS = 60_000;
const TOKEN_CACHE_MAX = 20_000;

type Vars = { Variables: { member: MemberRow; group: GroupRow } };

function err(
  c: Context,
  status: 400 | 401 | 404 | 409 | 413 | 429 | 500,
  code: ApiErrorCode,
  error: string
) {
  return c.json({ error, code } satisfies ApiError, status);
}

/**
 * Read a request body as text, aborting the moment more than `max` bytes have
 * arrived (returns null). Unlike a Content-Length check this bounds the bytes
 * ACTUALLY buffered, so a chunked or header-less request can't slip a
 * multi-hundred-MB payload past the guard and exhaust memory. Streams via the
 * web ReadableStream API — runtime-agnostic (Node + Bun).
 */
async function readCappedText(req: Request, max: number): Promise<string | null> {
  const body = req.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/** The whole HTTP surface, deps injected — tests run it against memory deps. */
export function makeApp(deps: ServerDeps): Hono<Vars> {
  const { registry, tenants } = deps;
  const app = new Hono<Vars>();

  // Dev server testing
  // app.use("*", async (c, next) => {
  //   const delay = Math.random() * 300 + 200;
  //   await new Promise((resolve) => setTimeout(resolve, delay));
  //   await next();
  // });

  const damper = new FailureDamper();
  const lastTouch = new Map<string, number>();
  const tokenCache = new Map<string, { member: MemberRow; group: GroupRow; exp: number }>();

  // Rate-limit password guessing per Claude account — the resource under attack —
  // NOT per client-supplied X-Forwarded-For. Keying on a spoofable header let an
  // attacker rotate it to land every guess in a fresh bucket, defeating the
  // lockout entirely. Per-account keying means the failure budget is global for a
  // target account no matter how many source IPs the attacker uses. (An attacker
  // can at most briefly delay a legitimate join for that one account — a far
  // smaller harm than unbounded offline-speed guessing, and the block window is
  // capped at 15 minutes.)
  const damperKey = (accountId: string): string => accountId;

  app.get("/healthz", (c) => c.json({ ok: true }));

  // ── auth middleware for the ledger endpoints ──────────────────────────────
  app.use("/v1/ingest", bearer);
  app.use("/v1/bootstrap", bearer);
  app.use("/v1/view", bearer);
  app.use("/v1/history", bearer);

  async function bearer(c: Context<Vars>, next: () => Promise<void>): Promise<void | Response> {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (!token) return err(c, 401, "auth", "missing bearer token");
    const tokenHash = hashToken(token);
    const now = Date.now();

    let hit = tokenCache.get(tokenHash);
    if (hit && hit.exp <= now) {
      tokenCache.delete(tokenHash);
      hit = undefined;
    }
    if (!hit) {
      const resolved = await registry.resolveToken(tokenHash);
      if (!resolved) return err(c, 401, "auth", "unknown or revoked token");
      hit = { member: resolved.member, group: resolved.group, exp: now + TOKEN_CACHE_TTL_MS };
      if (tokenCache.size >= TOKEN_CACHE_MAX) {
        const oldest = tokenCache.keys().next().value;
        if (oldest !== undefined) tokenCache.delete(oldest);
      }
      tokenCache.set(tokenHash, hit);
    }

    if (now - (lastTouch.get(tokenHash) ?? 0) >= TOKEN_TOUCH_INTERVAL_MS) {
      lastTouch.set(tokenHash, now);
      await registry.touchToken(tokenHash).catch(() => {});
    }
    c.set("member", hit.member);
    c.set("group", hit.group);
    await next();
  }

  // ── group / member auth ───────────────────────────────────────────────────

  // Pre-join existence check (unauthenticated): lets the CLI say "you're
  // creating a group" vs "you're joining your team's group" and word the
  // password prompt accordingly, before it asks for anything.
  app.get("/v1/groups/lookup", async (c) => {
    const accountId = c.req.query("accountId");
    if (!accountId) return err(c, 400, "invalid", "accountId is required");
    const group = await registry.getGroupByAccount(accountId);
    if (!group) return c.json({ exists: false });
    const memberName = c.req.query("memberName");
    if (memberName) {
      const member = await registry.getMember(group.id, memberName);
      return c.json({ exists: true, memberExists: !!member });
    }
    return c.json({ exists: true });
  });

  app.post("/v1/groups", async (c) => {
    const parsed = parseCreateGroup(await c.req.json().catch(() => null));
    if (!parsed.ok) return err(c, 400, "invalid", parsed.error);
    const body = parsed.value;
    if (damper.isBlocked(damperKey(body.accountId))) {
      return err(c, 429, "rate-limited", "too many attempts — wait a moment");
    }

    // Friendly pre-check; the transaction below is the real race arbiter.
    if (await registry.getGroupByAccount(body.accountId)) {
      return err(c, 409, "conflict", "a group for this Claude account already exists — join it");
    }
    const { token, tokenHash } = mintToken();
    try {
      // ONE transaction: group + provisioned ledger + first member + token —
      // a failure anywhere leaves nothing behind (no compensation needed).
      const { group, member } = await registry.createGroupWithMember({
        accountId: body.accountId,
        groupPasswordHash: await hashPassword(body.groupPassword),
        memberName: body.memberName,
        memberPasswordHash: await hashPassword(body.memberPassword),
        tokenHash,
      });
      return c.json({ token, groupId: group.id, memberName: member.name }, 201);
    } catch (e) {
      if (e instanceof RegistryConflictError) {
        // lost the creation race — the unique accountId constraint is the arbiter
        return err(c, 409, "conflict", "a group for this Claude account already exists — join it");
      }
      return err(c, 500, "invalid", `could not provision the group: ${(e as Error).message}`);
    }
  });

  app.post("/v1/groups/join", async (c) => {
    const parsed = parseJoinGroup(await c.req.json().catch(() => null));
    if (!parsed.ok) return err(c, 400, "invalid", parsed.error);
    const body = parsed.value;
    const key = damperKey(body.accountId);
    if (damper.isBlocked(key)) {
      return err(c, 429, "rate-limited", "too many attempts — wait a moment");
    }

    const group = await registry.getGroupByAccount(body.accountId);
    if (!group) return err(c, 404, "not-found", "no group exists for this Claude account yet");
    if (!(await verifyPassword(body.groupPassword, group.passwordHash))) {
      damper.recordFailure(key);
      return err(c, 401, "auth", "wrong group password");
    }

    const { token, tokenHash } = mintToken();
    let member = await registry.getMember(group.id, body.memberName);
    if (member) {
      // The anti-impersonation check: an existing name is only re-joinable by
      // whoever knows its member password.
      if (!(await verifyPassword(body.memberPassword, member.passwordHash))) {
        damper.recordFailure(key);
        return err(c, 401, "auth", `"${body.memberName}" exists and this isn't its password`);
      }
      await registry.insertToken(tokenHash, member.id);
    } else {
      try {
        // ONE transaction: member + roster row + change-token bump + token.
        member = await registry.addMemberWithToken(
          group.id,
          body.memberName,
          await hashPassword(body.memberPassword),
          tokenHash
        );
      } catch (e) {
        if (!(e instanceof RegistryConflictError)) throw e;
        // Lost a same-name race — the name exists now, so apply the
        // impersonation guard against the row that won.
        member = await registry.getMember(group.id, body.memberName);
        if (!member || !(await verifyPassword(body.memberPassword, member.passwordHash))) {
          damper.recordFailure(key);
          return err(c, 401, "auth", `"${body.memberName}" exists and this isn't its password`);
        }
        await registry.insertToken(tokenHash, member.id);
      }
    }
    damper.recordSuccess(key);
    return c.json({ token, groupId: group.id, memberName: member.name }, 200);
  });

  app.post("/v1/login", async (c) => {
    const parsed = parseLogin(await c.req.json().catch(() => null));
    if (!parsed.ok) return err(c, 400, "invalid", parsed.error);
    const body = parsed.value;
    const key = damperKey(body.accountId);
    if (damper.isBlocked(key)) {
      return err(c, 429, "rate-limited", "too many attempts — wait a moment");
    }

    const group = await registry.getGroupByAccount(body.accountId);
    if (!group) return err(c, 404, "not-found", "no group exists for this Claude account yet");
    const member = await registry.getMember(group.id, body.memberName);
    // Unknown member and wrong password answer identically — don't leak names.
    if (!member || !(await verifyPassword(body.memberPassword, member.passwordHash))) {
      damper.recordFailure(key);
      return err(c, 401, "auth", "wrong member name or password");
    }
    damper.recordSuccess(key);
    const { token, tokenHash } = mintToken();
    await registry.insertToken(tokenHash, member.id);
    return c.json({ token, groupId: group.id, memberName: member.name }, 200);
  });

  // ── the ledger surface ────────────────────────────────────────────────────

  app.post("/v1/ingest", async (c) => {
    const raw = await readCappedText(c.req.raw, MAX_INGEST_BYTES);
    if (raw === null) return err(c, 413, "invalid", "ingest body too large");
    let json: unknown = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* malformed JSON — parseIngest rejects null below */
    }
    const parsed = parseIngest(json);
    if (!parsed.ok) return err(c, 400, "invalid", parsed.error);
    const body = parsed.value;
    const group = c.get("group");
    const member = c.get("member");

    // §1.5 server-side: a tick observed under a *different* Claude account never
    // lands in this group's ledger. A null accountId is an unhydrated sender that
    // can't yet know its account — accepted, since the authenticated member can
    // only ever write into their own group's ledger.
    if (body.accountId !== null && body.accountId !== group.accountId) {
      return err(c, 409, "account-conflict", "this group is bound to a different Claude account");
    }

    // Names come from auth, not the payload — members can't write as each other.
    const batch = {
      samples: body.samples,
      resets: body.resets,
      messages: body.messages.map((m) => ({ ...m, user: member.name })),
      markers: body.markers.map((m) => ({ ...m, user: member.name })),
    };
    try {
      const tenant = await tenants.get(group);
      await tenant.sink.ingest(batch, { at: body.at, accountId: body.accountId });
    } catch (e) {
      if (e instanceof AccountConflictError) {
        return err(c, 409, "account-conflict", e.message);
      }
      return err(c, 500, "invalid", (e as Error).message);
    }
    return c.body(null, 204);
  });

  app.get("/v1/bootstrap", async (c) => {
    const group = c.get("group");
    const tenant = await tenants.get(group);
    const boot = await tenant.sink.bootstrap();
    return c.json({ accountId: group.accountId, samples: boot.samples });
  });

  app.get("/v1/view", async (c) => {
    const group = c.get("group");
    const tenant = await tenants.get(group);
    const now = Date.now();
    // The view-source cache key doubles as the ETag: one single-row read
    // answers the steady-state 2s poll with a 304 and zero body bytes.
    const etag = `"${await tenant.view.currentKey(now)}"`;
    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304, { ETag: etag });
    }
    const view = await tenant.view.fetchView(now);
    return c.json(view, 200, { ETag: etag });
  });

  // Cold history read: a page of frozen windows for one cap, newest first (ADR-0005).
  app.get("/v1/history", async (c) => {
    const capQ = c.req.query("cap") ?? "five_hour";
    if (!CAP_KINDS.includes(capQ as CapKind)) return err(c, 400, "invalid", "unknown cap");
    const before = c.req.query("before") || undefined;
    const limitRaw = Number(c.req.query("limit"));
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 50;
    const tenant = await tenants.get(c.get("group"));
    const page = await tenant.view.history({ cap: capQ as CapKind, before, limit });
    return c.json(page);
  });

  return app;
}
