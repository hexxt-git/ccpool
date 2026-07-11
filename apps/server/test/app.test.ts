import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { AuthResponse, SharedView } from "@ccpool/core";
import { makeApp, type ServerDeps } from "../src/app.js";
import { makeTestDeps } from "./helpers.js";

/**
 * The whole HTTP surface against a libSQL `:memory:` database — the same
 * composition production uses, zero infrastructure. No sockets: Hono's
 * app.request() drives the routes directly.
 */

const ACCOUNT = "acc-uuid-1";

// Anchored to the current time, not a fixed date: the server rolls members up
// over a 7-day window from real `Date.now()`, so a hardcoded past timestamp
// would silently age out of that window and break the member assertions 7 days
// after the date was written. `AT` is the tank/sample instant; `MSG_AT` is the
// message, a minute earlier (as a real transcript line would be).
const AT = new Date(Date.now() - 60_000).toISOString();
const MSG_AT = new Date(Date.now() - 120_000).toISOString();

let app: Hono<never>;
let deps: ServerDeps;

beforeEach(async () => {
  deps = await makeTestDeps();
  app = makeApp(deps) as unknown as Hono<never>;
});

afterEach(async () => {
  await deps.tenants.close();
  await deps.db.close();
});

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function createGroup(memberName = "sam"): Promise<AuthResponse> {
  const res = await app.request("/v1/groups", {
    ...json({
      accountId: ACCOUNT,
      groupPassword: "group-pass-1",
      memberName,
      memberPassword: `${memberName}-pass-1`,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as AuthResponse;
}

const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

function tick(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    at: AT,
    accountId: ACCOUNT,
    samples: [{ cap: "five_hour", pct: 42, resetsAt: null, capturedAt: AT }],
    resets: [],
    messages: [
      {
        uuid: "m1",
        user: "spoofed-name", // must be overwritten with the authed member
        timestamp: MSG_AT,
        model: "claude-opus-4-8",
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationTokens: 3,
        cacheReadTokens: 4,
      },
    ],
    markers: [],
    ...over,
  };
}

describe("group lifecycle", () => {
  it("creates a group and returns a usable token", async () => {
    const auth = await createGroup();
    expect(auth.token.startsWith("ccs_")).toBe(true);
    expect(auth.memberName).toBe("sam");

    const view = await app.request("/v1/view", { headers: bearer(auth.token) });
    expect(view.status).toBe(200);
    const body = (await view.json()) as SharedView;
    expect(body.users.map((u) => u.name)).toEqual(["sam"]);
  });

  it("refuses a second group for the same account", async () => {
    await createGroup();
    const res = await app.request("/v1/groups", {
      ...json({
        accountId: ACCOUNT,
        groupPassword: "other-pass-1",
        memberName: "eve",
        memberPassword: "eve-pass-11",
      }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("conflict");
  });

  it("rejects invalid bodies (short password, bad name)", async () => {
    const short = await app.request("/v1/groups", {
      ...json({
        accountId: ACCOUNT,
        groupPassword: "short",
        memberName: "sam",
        memberPassword: "sam-pass-1",
      }),
    });
    expect(short.status).toBe(400);
    const badName = await app.request("/v1/groups", {
      ...json({
        accountId: ACCOUNT,
        groupPassword: "group-pass-1",
        memberName: "unknown",
        memberPassword: "x".repeat(10),
      }),
    });
    expect(badName.status).toBe(400);
    const longName = await app.request("/v1/groups", {
      ...json({
        accountId: ACCOUNT,
        groupPassword: "group-pass-1",
        memberName: "a".repeat(64),
        memberPassword: "x".repeat(10),
      }),
    });
    expect(longName.status).toBe(400);
  });
});

describe("atomic signup transactions", () => {
  it("concurrent creates for one account: one 201, one 409, and the loser's token is dead", async () => {
    const make = () =>
      app.request("/v1/groups", {
        ...json({
          accountId: ACCOUNT,
          groupPassword: "group-pass-1",
          memberName: "sam",
          memberPassword: "sam-pass-1",
        }),
      });
    // Sequential requests model the race past the friendly pre-check: the
    // second create hits the composed op's uniqueness arbiter.
    const first = await make();
    const second = await make();
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const loser = first.status === 409 ? first : second;
    expect((await loser.json()).code).toBe("conflict");

    // Only the winner's member exists, and only its token works.
    const winner = (await (first.status === 201 ? first : second).json()) as AuthResponse;
    const view = await app.request("/v1/view", { headers: bearer(winner.token) });
    expect(view.status).toBe(200);
    expect(((await view.json()) as SharedView).users.map((u) => u.name)).toEqual(["sam"]);
  });

  it("a failed duplicate-name join leaves no token behind", async () => {
    const auth = await createGroup("sam");
    const res = await app.request("/v1/groups/join", {
      ...json({
        accountId: ACCOUNT,
        groupPassword: "group-pass-1",
        memberName: "sam",
        memberPassword: "not-sams-pass",
      }),
    });
    expect(res.status).toBe(401);

    // The refused join must not have written anything: same roster, and the
    // winner's credentials still work.
    const view = await app.request("/v1/view", { headers: bearer(auth.token) });
    expect(((await view.json()) as SharedView).users.map((u) => u.name)).toEqual(["sam"]);
  });
});

describe("group lookup (pre-join existence check)", () => {
  it("reports false before the group exists and true after", async () => {
    const before = await app.request(`/v1/groups/lookup?accountId=${ACCOUNT}`);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ exists: false });

    await createGroup("sam");

    const after = await app.request(`/v1/groups/lookup?accountId=${ACCOUNT}`);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ exists: true });
  });

  it("400s without an accountId", async () => {
    const res = await app.request("/v1/groups/lookup");
    expect(res.status).toBe(400);
  });
});

describe("join and login", () => {
  it("joins a new member with the group password", async () => {
    await createGroup("sam");
    const res = await app.request("/v1/groups/join", {
      ...json({
        accountId: ACCOUNT,
        groupPassword: "group-pass-1",
        memberName: "alex",
        memberPassword: "alex-pass-1",
      }),
    });
    expect(res.status).toBe(200);
    const auth = (await res.json()) as AuthResponse;

    const view = await app.request("/v1/view", { headers: bearer(auth.token) });
    const body = (await view.json()) as SharedView;
    expect(body.users.map((u) => u.name)).toEqual(["alex", "sam"]);
  });

  it("refuses to join with the wrong group password", async () => {
    await createGroup();
    const res = await app.request("/v1/groups/join", {
      ...json({
        accountId: ACCOUNT,
        groupPassword: "wrong-pass-1",
        memberName: "alex",
        memberPassword: "alex-pass-1",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses to take an existing name without its member password (impersonation guard)", async () => {
    await createGroup("sam");
    const res = await app.request("/v1/groups/join", {
      ...json({
        accountId: ACCOUNT,
        groupPassword: "group-pass-1",
        memberName: "sam",
        memberPassword: "not-sams-pass",
      }),
    });
    expect(res.status).toBe(401);

    // with the right member password the name is re-joinable (new machine)
    const ok = await app.request("/v1/groups/join", {
      ...json({
        accountId: ACCOUNT,
        groupPassword: "group-pass-1",
        memberName: "sam",
        memberPassword: "sam-pass-1",
      }),
    });
    expect(ok.status).toBe(200);
  });

  it("404s join/login for an unknown account (CLI offers to create)", async () => {
    const res = await app.request("/v1/groups/join", {
      ...json({
        accountId: "acc-nope",
        groupPassword: "group-pass-1",
        memberName: "sam",
        memberPassword: "sam-pass-1",
      }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not-found");
  });

  it("logs an existing member in with only the member password", async () => {
    await createGroup("sam");
    const res = await app.request("/v1/login", {
      ...json({ accountId: ACCOUNT, memberName: "sam", memberPassword: "sam-pass-1" }),
    });
    expect(res.status).toBe(200);
    const wrong = await app.request("/v1/login", {
      ...json({ accountId: ACCOUNT, memberName: "sam", memberPassword: "wrong-pass-1" }),
    });
    expect(wrong.status).toBe(401);
  });
});

describe("ingest", () => {
  it("requires a bearer token", async () => {
    const res = await app.request("/v1/ingest", json(tick()));
    expect(res.status).toBe(401);
  });

  it("persists a tick and stamps rows with the AUTHENTICATED member's name", async () => {
    const auth = await createGroup("sam");
    const res = await app.request("/v1/ingest", {
      method: "POST",
      headers: bearer(auth.token),
      body: JSON.stringify(tick()),
    });
    expect(res.status).toBe(204);

    const view = await app.request("/v1/view", { headers: bearer(auth.token) });
    const body = (await view.json()) as SharedView;
    expect(body.samples).toEqual([{ cap: "five_hour", pct: 42, resetsAt: null, capturedAt: AT }]);
    // the spoofed user name never reaches the ledger
    expect(body.members.map((m) => m.user)).toEqual(["sam"]);
  });

  it("409s a tick observed under a different Claude account and writes nothing", async () => {
    const auth = await createGroup("sam");
    const res = await app.request("/v1/ingest", {
      method: "POST",
      headers: bearer(auth.token),
      body: JSON.stringify(tick({ accountId: "acc-OTHER" })),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("account-conflict");

    const view = await app.request("/v1/view", { headers: bearer(auth.token) });
    expect(((await view.json()) as SharedView).samples).toEqual([]);
  });

  it("accepts an unhydrated (null) accountId", async () => {
    const auth = await createGroup("sam");
    const res = await app.request("/v1/ingest", {
      method: "POST",
      headers: bearer(auth.token),
      body: JSON.stringify(tick({ accountId: null })),
    });
    expect(res.status).toBe(204);
  });
});

describe("bootstrap and view caching", () => {
  it("bootstrap returns the binding and the latest samples", async () => {
    const auth = await createGroup("sam");
    await app.request("/v1/ingest", {
      method: "POST",
      headers: bearer(auth.token),
      body: JSON.stringify(tick()),
    });
    const res = await app.request("/v1/bootstrap", { headers: bearer(auth.token) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accountId).toBe(ACCOUNT);
    expect(body.samples).toHaveLength(1);
  });

  it("answers an unchanged poll with 304 via ETag/If-None-Match", async () => {
    const auth = await createGroup("sam");
    const first = await app.request("/v1/view", { headers: bearer(auth.token) });
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();

    const second = await app.request("/v1/view", {
      headers: { ...bearer(auth.token), "if-none-match": etag },
    });
    expect(second.status).toBe(304);

    // a write moves the ETag -> the next conditional poll gets a fresh 200
    await app.request("/v1/ingest", {
      method: "POST",
      headers: bearer(auth.token),
      body: JSON.stringify(tick()),
    });
    const third = await app.request("/v1/view", {
      headers: { ...bearer(auth.token), "if-none-match": etag },
    });
    expect(third.status).toBe(200);
    expect(third.headers.get("etag")).not.toBe(etag);
  });
});
