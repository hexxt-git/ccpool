# Observation — reading the tank and the transcripts

_Part of the [ccpool algorithm docs](../ALGORITHM.md)._

---

## 1. Identity — which account, whose token

ccpool reads the token Claude Code **already stored**. It never logs in.

### Config-dir resolution

Everything is scoped to a Claude _config dir_ (`~/.claude` by default, overridable). The global JSON that holds the account identity is a sibling, except when `CLAUDE_CONFIG_DIR` is set.

```ts
// packages/core/src/identity/paths.ts
export function resolveConfigDir(env = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  return override && override.length > 0 ? override : join(homedir(), ".claude");
}

export function projectsDir(configDir: string): string {
  return join(configDir, "projects"); // transcripts live here
}

export function globalConfigPath(configDir: string, env = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  if (override) return join(configDir, ".claude.json");
  return join(homedir(), ".claude.json");
}
```

### Reading the token

The token lives in different places per OS. The reader tries a plaintext file first (Linux + a universal fallback), then the macOS keychain:

```ts
// packages/core/src/identity/credentials.ts
export async function readCredentials(configDir: string): Promise<Credentials | null> {
  // 1. plaintext file (Linux + universal fallback)
  try {
    return parse(await readFile(join(configDir, ".credentials.json"), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // 2. macOS keychain: `security find-generic-password -s <service> -w`
  if (process.platform === "darwin") {
    for (const svc of keychainServices(configDir)) {
      try {
        const { stdout } = await pExecFile("security", ["find-generic-password", "-s", svc, "-w"]);
        return parse(stdout);
      } catch {
        /* try the next service name */
      }
    }
  }
  return null;
}
```

The credentials carry an `expiresAt` (epoch ms). **Every use is gated on expiry** — if the token is expired we skip the poll entirely (Claude Code refreshes it on its next run; ccpool never refreshes):

```ts
export function isTokenExpired(c: { expiresAt: number }, now = Date.now()): boolean {
  return !Number.isFinite(c.expiresAt) || now >= c.expiresAt;
}
```

`resolver.ts` separately reads `oauthAccount.accountUuid` from the global JSON to identify the **account** (used to scope/label the tank) — never the person. The person is just a name in ccpool's own config. The views also read `oauthAccount.emailAddress` from the same file to show a human-readable account label, cached ~once a minute since it barely changes (§8).

### 1.5 Account binding — one ledger, one account

The whole design rests on **every machine sharing one login** (§0): each poll returns the _same_ account-wide tank, so the samples in the DB form a single coherent trajectory. If two machines signed into **different** Claude accounts wrote to the same ledger, `usage_samples` would interleave two unrelated tanks — the attribution baseline (`win[0].pct`), the target (`win[last].pct`), and reset detection would all read garbage. Nothing about a random `projectId` catches that.

So the group's ledger is **bound to an account**. `ccpool_meta.accountId` records the `accountUuid` — the **UUID, never the email** (email is only a display label, and can even be absent). The binding is enforced at two points:

- **The server** (§13) binds a group at creation: `POST /v1/groups` _requires_ a hydrated account, so there is no unbound state to claim. `/v1/ingest` answers **409 `account-conflict`** — writing nothing — when a tick's `accountId` doesn't match the group's.
- **The daemon** reads the binding once at startup (`sink.bootstrap()` returns the group's account). Every tick it compares the freshly resolved local account; on a mismatch — or a 409 from the server — it **halts all ledger writes** (samples, resets, messages) and flags `account.conflict` in `state.json`, which the views surface as the loudest footnote. It still polls, so the local user keeps seeing _their own_ tank — the shared ledger just stays clean.

Only a **hydrated** (onboarded) account has a real `accountUuid`; an unhydrated local account (the `user-<hash>` fallback) never triggers a conflict, and a tick with a null `accountId` is accepted (the authenticated member can only write into their own group), so onboarding can't trip a false mismatch. The `accountId` column stays nullable so the storage layer keeps the one-way `null → accountUuid` claim (via `bindAccount`) available, even though the server always binds at creation.

---

## 2. Polling the tank

The global tank comes from one endpoint. The request carries the OAuth beta header and a `claude-code` user agent:

```ts
// packages/core/src/usage/poller.ts
const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
  headers: {
    Authorization: `Bearer ${accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": `claude-code/${version}`,
  },
});
if (res.status === 401) throw new UsageAuthError("token expired?");
if (!res.ok) throw new Error(`usage endpoint returned ${res.status}`);
```

The response has one node per cap, e.g.:

```jsonc
{
  "five_hour": { "utilization": 46.0, "resets_at": "2026-06-29T21:10:00Z" },
  "seven_day": { "utilization": 19.0, "resets_at": "2026-07-05T22:00:00Z" },
  "seven_day_opus": null, // null = not applicable to this plan
}
```

Parsing maps each non-null cap to a `UsageSample`. **`pct` is taken verbatim from `utilization`** — we never derive a percentage from token counts (that mapping is unstable). A `null` cap is skipped, never rendered as 0%. The guard also rejects a **non-finite** `utilization` (`NaN`/`Infinity`): because `typeof NaN === "number"`, a bare type check would let it through and poison reset detection (§3) and attribution (§7), so such a cap is skipped exactly like a `null` one — we still trust any _finite_ pct verbatim:

```ts
export function parseUsage(body: unknown, capturedAt = new Date().toISOString()): UsageSample[] {
  const obj = (body ?? {}) as Record<string, unknown>;
  const out: UsageSample[] = [];
  for (const cap of CAP_KINDS) {
    const node = obj[CAP_FIELD[cap]] as { utilization?: unknown; resets_at?: unknown } | null;
    if (!node || typeof node.utilization !== "number" || !Number.isFinite(node.utilization))
      continue;
    out.push({
      cap,
      pct: node.utilization,
      resetsAt: typeof node.resets_at === "string" ? node.resets_at : null,
      capturedAt,
    });
  }
  return out;
}
```

---

## 3. Reset detection — by pct-drop, never by clock

Each cap has a `resets_at`, but that field is unreliable (Anthropic flushes some windows out-of-band). So a reset is detected purely by the percentage **dropping** between two consecutive readings:

```ts
// packages/core/src/usage/resets.ts
export function detectResets(prev: UsageSample[], next: UsageSample[], at, epsilon = 0.5) {
  const prevByCap = new Map(prev.map((s) => [s.cap, s.pct]));
  const events: ResetEvent[] = [];
  for (const s of next) {
    const before = prevByCap.get(s.cap);
    if (before !== undefined && s.pct < before - epsilon) {
      // a real drop, not float wobble
      events.push({ cap: s.cap, at, previousPct: before });
    }
  }
  return events;
}
```

The `epsilon` (0.5) ignores sub-point jitter. Resets matter twice: they're logged, and they re-baseline the attribution window (§6).

---

## 4. JSONL ingest — only new activity, attributed to a name

This is the source of the per-person split. Claude Code writes a transcript per session under `projects/**/*.jsonl` (and `agent-*.jsonl` for subagents). Assistant lines carry a `usage` block:

```jsonc
{
  "type": "assistant",
  "uuid": "…",
  "requestId": "req_…",
  "timestamp": "…",
  "message": {
    "model": "claude-opus-4-8",
    "usage": {
      "input_tokens": 3838,
      "output_tokens": 325,
      "cache_creation_input_tokens": 13209,
      "cache_read_input_tokens": 8020,
    },
  },
}
```

### Parsing one line

Two quirks drive the parse:

- **A single request emits several assistant lines with identical usage** (streaming
  - tool-use blocks). Counting each would double-count, so the dedup id is `requestId` (falling back to `uuid`).
- The active **name** is stamped at ingest; an invalid/missing name → `unknown`.

```ts
// packages/core/src/jsonl/reader.ts
export function parseLine(line: string, user: string): MessageUsage | null {
  const j = JSON.parse(line.trim());
  if (j?.type !== "assistant") return null;
  const usage = j?.message?.usage;
  if (!usage) return null;
  const id = j.requestId ?? j.uuid; // dedup key
  if (typeof id !== "string") return null;
  return {
    uuid: id,
    user: isValidName(user) ? user : UNKNOWN_USER,
    timestamp: j.timestamp ?? new Date().toISOString(),
    model: j.message?.model ?? null,
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
  };
}
```

### Tailing without backfilling

The daemon must **never** ingest old history (its token counts are unreliable and it can't be tied to whoever is using the account now). So on the **first** `collectNew` call the reader records every existing file's end-of-file offset and returns nothing. Thereafter it only reads bytes appended past that offset:

```ts
export class JsonlReader {
  private offsets = new Map<string, number>(); // file -> bytes already consumed (in memory)
  private baselined = false;

  async collectNew(user: string): Promise<MessageUsage[]> {
    const files = await this.listFiles(); // *.jsonl recursive (incl. agent-*)
    if (!this.baselined) {
      for (const f of files) this.offsets.set(f, await sizeOf(f)); // baseline at EOF
      this.baselined = true;
      return []; // no backfill, ever
    }
    const seen = new Set<string>();
    const rows: MessageUsage[] = [];
    for (const file of files) {
      for (const row of await this.readAppended(file, user)) {
        if (seen.has(row.uuid)) continue; // dedup across files within a batch
        seen.add(row.uuid);
        rows.push(row);
      }
    }
    return rows;
  }
}
```

`readAppended` reads `[offset, fileSize)`, and crucially **stops at the last newline** so a half-written trailing line is left for next time:

```ts
const lastNl = text.lastIndexOf("\n");
if (lastNl === -1) return []; // no complete line yet
const complete = text.slice(0, lastNl + 1);
this.offsets.set(file, start + Buffer.byteLength(complete, "utf8"));
// parse each line in `complete`…
```

Because offsets live **in memory** only, a daemon restart re-baselines at EOF — activity that landed while the daemon was down is skipped by design.

---

## 5. The daemon tick

One tick wires the above together. The key property: **poll, ingest, and state write are independent.** A failed poll must never block attribution, and `state.json` is always refreshed.

```ts
// packages/daemon/src/daemon.ts  (abridged)
async tick(): Promise<{ pollFailed: boolean }> {
  const account = await resolveAccount(configDir);
  const creds = await readCredentials(configDir);
  let tokenExpired = false, pollFailed = false, pollOk = false, samples = this.prev;
  const batch = emptyBatch();                          // ONE ledger write per tick

  if (!creds || isTokenExpired(creds)) {
    tokenExpired = true;                              // skip poll; not an error
  } else {
    try {
      const fresh = await pollUsage(creds.accessToken);
      batch.resets.push(...detectResets(this.prev, fresh));
      // report-on-change: only caps whose pct moved since the last reading
      // (flat repeats are exactly what the server's envelope filter drops)
      batch.samples.push(...fresh.filter(s => pctChanged(s, this.prev)));
      samples = fresh; this.prev = fresh; pollOk = true;
    } catch (err) {
      if (err instanceof UsageAuthError) tokenExpired = true;      // 401 → treat as expiry
      else pollFailed = true;                                      // network/429 → back off
    }
  }

  // independent of the poll outcome:
  const rows = await this.reader.collectNew(await this.currentName());
  batch.messages.push(...rows);

  // a tank rise this tick with no message, but this machine was driving Code in the
  // last few minutes → an activity marker so the rise isn't lost to unknown (§7)
  if (!rows.length && caps rose && recent local activity)
    batch.markers.push({ user, at: nowIso, model, weight });

  // ONE write: merged with a previously failed batch (uuid/id dedup makes the
  // re-send safe); AccountConflictError → flag the conflict, drop the batch (§1.5)
  let ingestOk = false;
  const toSend = this.pending ? mergeBatches(this.pending, batch) : batch;
  if (isEmptyBatch(toSend)) { ingestOk = true; }        // nothing new → already in sync
  else try { await sink.ingest(toSend, { at: nowIso, accountId }); this.pending = null; ingestOk = true; }
  catch (err) {
    if (err instanceof AccountConflictError) { accountConflict = true; this.pending = null; }
    else if (isAuthError(err)) { this.pending = null; pollFailed = true; this.authRejected = true; } // 401 → logged out
    else { this.pending = toSend; pollFailed = true; }   // retry next tick
  }

  // "synced X ago" reflects a *complete* refresh — a fresh poll AND a landed ingest.
  // Only then does the heartbeat advance, so a failed poll (429) or ingest
  // (401/unreachable) leaves it growing instead of resetting to zero every tick.
  if (pollOk && ingestOk) this.lastSyncAt = nowIso;

  await atomicWriteJson(paths.stateFile, buildLocalState({
    accountId: account?.id ?? null, tokenExpired, accountConflict,
    authRejected: this.authRejected, lastSyncAt: this.lastSyncAt, samples,
    pid: process.pid, startedAt: this.startedAt, now: nowIso,
  }));
  return { pollFailed };
}
```

Details worth noting:

- Samples are **report-on-change**, not one-per-tick: a tick sends only the caps whose `pct` moved since the last reading (or that accompany a reset), so a steady tank ingests nothing. On the server the **envelope filter** then keeps only samples that raise the running max for their cap in the window, collapsing every member's stream into one canonical per-group trajectory — the same monotonic envelope attribution (§7) walks to align tank rises with activity.
- Everything observed lands in **one `TickBatch`** and one `sink.ingest` call — one `POST /v1/ingest`, which the server persists as one DB transaction. The batch also bumps that group's change token exactly once (§8.5).
- A **failed ingest keeps the batch** and merges it into the next tick's (bounded, newest rows win), so a transient outage never silently drops transcript rows — messages and markers are idempotent on uuid/id, so the re-send can't double-count.
- The **sync heartbeat** (`lastSyncAt`) advances **only on a fully clean tick** — the poll landed a fresh tank _and_ the ingest committed (or there was nothing new to send). `updatedAt` still bumps every tick (it's the write timestamp), but the reader's "synced X ago" reads `lastSyncAt`, so a 429 poll or a 401/unreachable ingest makes the footer age grow instead of falsely resetting to zero.
- A **401 (or `auth`-coded) ingest** is _not_ retryable: the bearer was revoked or rotated by a hand-off elsewhere, and this daemon's token is fixed at startup. The daemon latches `authRejected` into `state.json` and backs off hard; the reader treats that as **logged out**, stops the daemon, deletes the token, and routes the user back to `init` (§13). Contrast the poll's 401, which is just a token-refresh gap (treated as expiry, no back-off).
- `currentName()` is resolved **fresh each tick** (re-reads config), so handing the machine to another person with `ccpool config set name alex` takes effect without restarting the daemon.
- An **activity marker** is added only when the tank rose but no message was ingested this tick _and_ this machine produced Code activity within the last few minutes — the daemon's local view of a lagged/uncaptured rise it can honestly claim for its user (§7). The whole batch is dropped on an account conflict (§1.5).
- Startup runs `sink.bootstrap()`: it reports the group's bound account and seeds `prev` with the latest stored samples (over HTTP: `GET /v1/bootstrap`), so a reset that happened while the daemon was down is caught on the first poll. The server heals/migrates the group's schema on its side.

### The run loop — jitter and backoff

```ts
while (!this.stopped) {
  let delay = this.pollIntervalMs;
  const { pollFailed } = await this.tick();
  if (pollFailed) {
    this.failures++;
    delay = Math.min(MAX_BACKOFF_MS, this.pollIntervalMs * 2 ** this.failures); // exp backoff, cap 5m
  } else {
    this.failures = 0;
  }
  await this.sleep(jitter(delay)); // ±10% so a fleet doesn't sync up
}
```

Lifecycle is enforced by a **single-instance pidfile lock** keyed to a hash of the config dir. The lock is taken with an **atomic `openSync(pidFile, "wx")`** (`O_CREAT | O_EXCL`) — the kernel creates the file only if it doesn't already exist, in one indivisible step, so two daemons racing to boot can never both win: exactly one creates it, every other gets `EEXIST`, sees the live owner, and exits with `AlreadyRunningError`. (A plain read-pid → check-alive → write sequence is **not** enough — the gap between the check and the write is a race window, and since `spawnDetached` + tsx take a second or two to start, several redundant spawns can land inside it; that TOCTOU is what once let a fleet of daemons pile up.) A stale lock — the owner was `SIGKILL`ed so `releaseLock` never ran, or the file is empty from a crash mid-write — is reclaimed: if the recorded pid is dead we clear it (only if it still holds that same dead pid) and retry the atomic create. SIGINT/SIGTERM flush, close storage, and remove the pidfile. The process is spawned detached by `ccpool daemon start` via a runtime-aware `spawnDetached` (Bun.spawn vs Node's `spawn(..., { detached: true })`).

The atomic acquire is a **point-in-time** check, and that is not sufficient on its own: the pidfile can later vanish (a manual `rm`, or a crashed starter's stale-reclaim `unlink`) or be replaced, after which `isDaemonRunning` reports "down", a second daemon starts _legitimately_, and both then run **invisibly** — neither backed by the pidfile, so the CLI can neither see nor stop them, and they fight over `state.json`. That orphan-with-no-pidfile is how duplicates slipped past the atomic lock every previous time. So a live daemon **re-asserts ownership for its whole life**, not just at boot (`reassertLock`): at the top of every tick (before it polls, ingests, or writes `state.json`) and on a 5s backoff-independent guard timer, it reconciles against the pidfile — the single source of truth for "who is the daemon". If the file records us we keep running; if it's missing or holds a dead pid we self-heal by re-acquiring atomically; if it holds a **different live** pid we are the duplicate and **surrender immediately** (stop, doing no work). A duplicate therefore can neither persist nor touch shared state — the fleet converges to exactly one within seconds.

---

## 6. `state.json` — the local snapshot

Written atomically (temp file + rename) so a reader never sees a half-written file:

```ts
// packages/core/src/state/snapshot.ts
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path); // atomic on POSIX
}
```

The snapshot carries two timestamps with different meanings: `updatedAt` (bumped every tick — proof the daemon is alive and writing) and `lastSyncAt` (advanced only on a clean poll + ingest — what "synced X ago" reports). It also carries three health flags the readers surface: `tokenExpired` (Claude Code will refresh), `account.conflict` (this machine's account ≠ the ledger's — writes halted, §1.5), and `account.authRejected` (the server revoked the bearer — logged out, §13).

`statusline` reads only this file — cheap, no network — so it's safe to call from Claude Code's status bar on every prompt. It short-circuits to a loud `⚠ ccpool logged out · run \`ccpool init\``line when`authRejected` is set, rather than painting a stale tank.
