# ccshare — how it works, end to end

This document explains every algorithm in ccshare, in the order data flows through
the system, with code excerpts from the actual implementation.

ccshare answers one question for a group sharing **one Claude subscription**: _the
account is at 60% of its 5-hour limit — who caused that?_ Anthropic only reports a
single account-wide number, so the per-person split has to be reconstructed
locally and shared.

The whole system is a **read-only observer plus a shared ledger**. It never sits in
the request path. Two facts drive the entire design:

1. **The tank level is global.** Every machine shares the same login, so every
   machine's usage poll returns the _same_ account-wide percentages.
2. **The per-person split is local and additive.** Each machine can only see the
   Claude Code activity on _that_ machine. Each daemon writes what it sees to a
   shared database; summed across everyone, that's the breakdown.

---

## 0. The pipeline at a glance

```
                      ┌─────────────────────────── per machine ───────────────────────────┐
  Claude Code keychain│   credentials.ts ─ reads OAuth token (never mints one)             │
  ~/.claude.json      │   resolver.ts    ─ which Claude *account* (not person)             │
  api/oauth/usage  ───┼─► poller.ts      ─ the global tank: 5h / weekly / weekly-opus %    │
  projects/**/*.jsonl │   reader.ts      ─ tails transcripts, only NEW lines, → who+tokens │
                      │            │                                                        │
                      │            ▼                                                        │
                      │   daemon.ts tick(): poll → detect resets → ingest → write state    │
                      │            │                         │                              │
                      │     state.json (atomic)         shared DB (samples + messages)      │
                      └────────────┼─────────────────────────┼─────────────────────────────┘
                                   │                          │
                  statusline ◄─────┘            tui / status ◄┴─ gatherView() + attributeShares()
                  (reads state only)            (DB everyone-included, attributes deltas)
```

No process talks to another process. The contract is **files and the database
only**: the daemon writes `state.json` and the DB; readers read them.

---

## 1. Identity — which account, whose token

ccshare reads the token Claude Code **already stored**. It never logs in.

### Config-dir resolution

Everything is scoped to a Claude _config dir_ (`~/.claude` by default,
overridable). The global JSON that holds the account identity is a sibling, except
when `CLAUDE_CONFIG_DIR` is set.

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

The token lives in different places per OS. The reader tries a plaintext file
first (Linux + a universal fallback), then the macOS keychain:

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

The credentials carry an `expiresAt` (epoch ms). **Every use is gated on expiry** —
if the token is expired we skip the poll entirely (Claude Code refreshes it on its
next run; ccshare never refreshes):

```ts
export function isTokenExpired(c: { expiresAt: number }, now = Date.now()): boolean {
  return !Number.isFinite(c.expiresAt) || now >= c.expiresAt;
}
```

`resolver.ts` separately reads `oauthAccount.accountUuid` from the global JSON to
identify the **account** (used to scope/label the tank) — never the person. The
person is just a name in ccshare's own config.

---

## 2. Polling the tank

The global tank comes from one endpoint. The request carries the OAuth beta header
and a `claude-code` user agent:

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

Parsing maps each non-null cap to a `UsageSample`. **`pct` is taken verbatim from
`utilization`** — we never derive a percentage from token counts (that mapping is
unstable). A `null` cap is skipped, never rendered as 0%. The guard also rejects a
**non-finite** `utilization` (`NaN`/`Infinity`): because `typeof NaN === "number"`,
a bare type check would let it through and poison reset detection (§3) and
attribution (§7), so such a cap is skipped exactly like a `null` one — we still
trust any _finite_ pct verbatim:

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

Each cap has a `resets_at`, but that field is unreliable (Anthropic flushes some
windows out-of-band). So a reset is detected purely by the percentage **dropping**
between two consecutive readings:

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

The `epsilon` (0.5) ignores sub-point jitter. Resets matter twice: they're logged,
and they re-baseline the attribution window (§6).

---

## 4. JSONL ingest — only new activity, attributed to a name

This is the source of the per-person split. Claude Code writes a transcript per
session under `projects/**/*.jsonl` (and `agent-*.jsonl` for subagents). Assistant
lines carry a `usage` block:

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
  - tool-use blocks). Counting each would double-count, so the dedup id is
    `requestId` (falling back to `uuid`).
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

The daemon must **never** ingest old history (its token counts are unreliable and
it can't be tied to whoever is using the account now). So on the **first**
`collectNew` call the reader records every existing file's end-of-file offset and
returns nothing. Thereafter it only reads bytes appended past that offset:

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

`readAppended` reads `[offset, fileSize)`, and crucially **stops at the last
newline** so a half-written trailing line is left for next time:

```ts
const lastNl = text.lastIndexOf("\n");
if (lastNl === -1) return []; // no complete line yet
const complete = text.slice(0, lastNl + 1);
this.offsets.set(file, start + Buffer.byteLength(complete, "utf8"));
// parse each line in `complete`…
```

Because offsets live **in memory** only, a daemon restart re-baselines at EOF —
activity that landed while the daemon was down is skipped by design.

---

## 5. The daemon tick

One tick wires the above together. The key property: **poll, ingest, and state
write are independent.** A failed poll must never block attribution, and
`state.json` is always refreshed.

```ts
// packages/daemon/src/daemon.ts  (abridged)
async tick(): Promise<{ pollFailed: boolean }> {
  const account = await resolveAccount(configDir);
  const creds = await readCredentials(configDir);
  let tokenExpired = false, pollFailed = false, samples = this.prev;

  if (!creds || isTokenExpired(creds)) {
    tokenExpired = true;                              // skip poll; not an error
  } else {
    try {
      const fresh = await pollUsage(creds.accessToken);
      for (const e of detectResets(this.prev, fresh)) await storage.recordReset(e);
      for (const s of fresh) await storage.recordUsageSample(s);   // dense trajectory
      samples = fresh; this.prev = fresh;
    } catch (err) {
      if (err instanceof UsageAuthError) tokenExpired = true;      // 401 → treat as expiry
      else pollFailed = true;                                      // network → back off
    }
  }

  // independent of the poll outcome:
  const rows = await this.reader.collectNew(await this.currentName());
  if (rows.length) await storage.recordMessageUsage(rows);

  await atomicWriteJson(paths.stateFile, buildLocalState({
    accountId: account?.id ?? null, tokenExpired, samples,
    pid: process.pid, startedAt: this.startedAt, now: nowIso,
  }));
  return { pollFailed };
}
```

Two details worth noting:

- A **sample is recorded every tick**, even if the tank didn't change. That dense
  trajectory is what attribution (§7) needs to align tank rises with activity.
- `currentName()` is resolved **fresh each tick** (re-reads config), so handing the
  machine to another person with `ccshare config set name alex` takes effect
  without restarting the daemon.

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

Lifecycle is enforced by a **single-instance pidfile lock** keyed to a hash of the
config dir; SIGINT/SIGTERM flush, close storage, and remove the pidfile. The
process is spawned detached by `ccshare daemon start` via a runtime-aware
`spawnDetached` (Bun.spawn vs Node's `spawn(..., { detached: true })`).

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

`statusline` reads only this file — cheap, no network — so it's safe to call from
Claude Code's status bar on every prompt.

---

## 7. Attribution — the heart of the per-person split

This is the algorithm that says "sam used 5%, unknown 87%". It's the one that was
subtly wrong at first; the correct version is **delta-based time correlation**.

### Why the obvious approach is wrong

The tempting approach — split the _current tank_ across users by their token
weight — fails badly:

- It can't see chat/mobile/web usage, so that usage gets dumped on whoever ran
  Code.
- The tank that built up _before_ the daemon started gets attributed to the first
  person who runs anything.

A single measured message would make you "responsible" for 100% of the tank.

### The right model

Attribute **changes in the tank**, correlated in time with the activity that
caused them:

1. The tank level at the **earliest reading in the window** is `unknown`'s
   **baseline** (pre-daemon usage is nobody's).
2. Walk consecutive samples. For each **rise** `Δ = curPct − prevPct`, look at the
   Code activity whose timestamp falls in that interval:
   - activity present → split `Δ` across those users by token weight;
   - none → the whole `Δ` is `unknown` (mobile / web / chat, or daemon was down).
3. A **drop** is a reset → clear everything and re-baseline at the new (low) level.
4. `unknown` absorbs any remainder so the column totals the current tank.

```ts
// packages/core/src/state/shares.ts  (the core loop, abridged)
const attributed = new Map<string, number>();
attributed.set(UNKNOWN_USER, win[0].pct);            // 1. baseline = pre-daemon tank

let mi = 0;                                          // pointer into time-sorted messages
while (mi < msgs.length && msgs[mi].t <= win[0].t) mi++;   // skip pre-baseline activity

for (let i = 1; i < win.length; i++) {
  const prev = win[i - 1], cur = win[i];

  // 2a. collect this interval's activity (advance pointer regardless of Δ)
  const weights = new Map<string, number>(); let total = 0;
  while (mi < msgs.length && msgs[mi].t <= cur.t) {
    const m = msgs[mi++];
    if (opusOnly && !isOpus(m.model)) continue;      // opus cap only counts opus models
    weights.set(m.user, (weights.get(m.user) ?? 0) + m.w);
    total += m.w;
  }

  const delta = cur.pct - prev.pct;
  if (delta <= 0) continue;                          // 3. reset/dip handled by windowing

  if (total > 0) {                                   // 2b. split the rise by weight
    for (const [u, w] of weights) attributed.set(u, (attributed.get(u) ?? 0) + delta * w / total);
  } else {                                           // 2c. nobody active → unknown
    attributed.set(UNKNOWN_USER, (attributed.get(UNKNOWN_USER) ?? 0) + delta);
  }
}

// 4. normalize to the latest tank, dumping drift into unknown (the bias we want)
const target = win[win.length - 1].pct;
const nonUnknown = sum(users except unknown);
if (nonUnknown > target) {
  // guard: measured users can't collectively exceed the tank — scale them down
  const scale = target / nonUnknown;
  for each non-unknown user: user.pct *= scale;
  unknown.pct = 0;
} else {
  unknown.pct = Math.max(0, target - nonUnknown);
}
```

The window (`win`) is bounded to the **current reset cycle** — it starts at the
last detected pct-drop and never looks back further than the cap's length:

```ts
const cutoff = now - CAP_WINDOW_MS[cap]; // 5h or 7d
let start = 0;
for (let i = 1; i < capSamples.length; i++) {
  if (capSamples[i].pct < capSamples[i - 1].pct - RESET_EPS)
    start = i; // reset
  else if (capSamples[i].t < cutoff) start = i; // too old
}
const win = capSamples.slice(start);
```

### Worked example

Daemon comes up when 5h is already at **80%**. You run a bit of Code (tank rises
80→85). Then mobile usage pushes it 85→92 with no Code activity.

| interval     | Δ   | Code activity in interval | credited to     |
| ------------ | --- | ------------------------- | --------------- |
| _(baseline)_ | —   | —                         | `unknown` += 80 |
| 80 → 85      | +5  | sam (1000 tok)            | `sam` += 5      |
| 85 → 92      | +7  | _(none — mobile)_         | `unknown` += 7  |

Result: **sam 5%, unknown 87%**, summing to the 92% tank. Exactly what you'd
expect, and what the old algorithm got wrong (it would have shown sam 92%).

### Why this is multi-machine correct

Each machine writes its own samples (all see the same global tank → last-write-wins
is fine) and its own messages with timestamps. At view time, attribution reads
**everyone's** messages from the shared DB, so a rise is credited to whichever
participant — on any machine — was active in that interval. Activity from a machine
whose daemon was down simply isn't in the DB, so that interval's rise falls to
`unknown`.

It remains an **estimate**: cache token fields are reliable but raw input/output
undercount, and Code + chat happening in the _same ~60s interval_ can't be
perfectly separated (that sliver attaches to the active user). It's bounded by the
interval's delta — a world better than the whole tank.

---

## 8. The view model — what `status` and `tui` render

Both surfaces render from one model, assembled by `gatherView`. It prefers the
**shared DB** (everyone-included), falls back to the local **`state.json`** (instant,
no network), and finally to a one-shot **live poll** so the view is never empty
before the daemon's first write:

```ts
// apps/cli/src/lib/view.ts  (abridged)
const since = new Date(now - CAP_WINDOW_MS.seven_day).toISOString();
const [latest, samplesSince, messagesSince, budgets] = await Promise.all([
  storage.getLatestSamples(), // the header bars
  storage.getUsageSamplesSince(since), // the trajectory, for attribution
  storage.getMessageUsageSince(since), // everyone's measured activity
  storage.getBudgets(),
]);
const shares = attributeShares(samplesSince, messagesSince, now); // §7

let samples = latest,
  source = latest.length ? "db" : "none";
if (!samples.length && state?.samples.length) {
  samples = state.samples;
  source = "state";
}
if (!samples.length) {
  const live = await tryLivePoll(configDir);
  if (live) {
    samples = live;
    source = "live";
  }
}
```

The renderer turns this into the header bars + a per-user table whose rows sum to
the header. `status` prints one frame; `tui` re-runs `gatherView` every 2s and
ticks the clock every 1s so countdowns move. Edge states (token expired, daemon
down, DB unreachable, live-poll badge) render as footnotes.

```
5h          ▓▓▓▓▓▓▓▓▓░   92%
weekly      ▓▓░░░░░░░░   21%

user         5h  weekly
-------  ------  ------
sam         5%      1%
unknown    87%     20%
```

---

## 9. Storage — the swappable boundary

Everything above talks to one async interface; the concrete adapter is chosen from
config in a single place:

```ts
function makeStorage(cfg: Config): Storage {
  switch (cfg.storage.driver) {
    case "libsql":
    case "sqlite":
      return new LibsqlStorage(cfg.storage.url, cfg.storage.token);
    case "postgres":
      return new PostgresStorage(cfg.storage.url);
    case "memory":
      return new MemoryStorage();
  }
}
```

The interface is deliberately dumb — record/query rows, no business logic:

```ts
interface Storage {
  inspect(): Promise<DbInspection>; // empty | ccshare | foreign
  initializeSchema(): Promise<void>;
  recordUsageSample(s): Promise<void>;
  getLatestSamples(): Promise<UsageSample[]>;
  getUsageSamplesSince(since): Promise<UsageSample[]>; // trajectory for attribution
  recordMessageUsage(rows): Promise<void>; // idempotent on uuid
  getMessageUsageSince(since): Promise<MessageUsage[]>;
  setBudget(name, cap, pct);
  getBudgets();
  upsertUser(name);
  getUsers();
  // …
}
```

A single **contract test suite** runs against the memory, libSQL, and Postgres
adapters, which is what proves both swappability and the clean-DB rules below.

### Init inspection — clean DB enforcement

`ccshare init` refuses to mix into someone else's database. Inspection classifies
the target three ways and the CLI branches on it:

```ts
type DbInspection =
  | { kind: "empty" } // no tables  → prompt, then create
  | { kind: "ccshare"; schemaVersion: number } // our marker → join (maybe migrate)
  | { kind: "foreign" }; // other tables → refuse
```

The marker is a `ccshare_meta` table holding `app='ccshare'`, `schemaVersion`, a
`projectId`, and `createdAt`. Init only creates tables on `empty` (after explicit
confirmation), only joins on `ccshare`, and **never** writes alongside a `foreign`
schema.

---

## 10. Budgets

Optional fair-share targets per `(name, cap)`. They don't change attribution; they
just annotate it. A user whose share exceeds their target gets a `▲`:

```ts
// apps/cli/src/lib/render.ts
const budget = budgetOf.get(`${u}:${c}`);
const mark = budget === undefined ? " " : pct > budget + 0.5 ? "▲" : "·";
```

```
sam        45%▲    23%·     ← over the 33% 5h target, within the 33% weekly target
```

---

## 11. Names, hand-offs, and `unknown`

- A **name** is the only identity (`^[A-Za-z0-9-]+$`), stored in local config — not
  bound to a machine. Several people can share a machine and hand off with
  `config set name <name>`; the running daemon picks up the change next tick.
  `isValidName` also **reserves `unknown`** (case-insensitive): a person can't
  register as the bucket below, or their share would silently merge into it.
- **`unknown`** is a normal, always-listed row. It receives: activity ingested with
  no/invalid name, tank rises during intervals with no measured Code activity
  (chat/mobile/web, or daemon down), the pre-daemon baseline, and normalization
  remainder. This is what keeps measured users from claiming usage they didn't
  cause.

---

## 12. Runtime portability

The same code runs on **Node (≥20) and Bun**, so it avoids native-only modules:

- HTTP via the global `fetch`.
- Default storage `@libsql/client` (one driver for `file:` and `libsql://`).
- `node:` imports for fs/path/crypto.
- The only runtime branch is `spawnDetached` (Bun.spawn vs `child_process`),
  isolated to one function.

CI runs the entire suite twice — once on Node, once on Bun — and the storage
contract suite additionally runs against a real Postgres.

---

## Appendix — edge cases the algorithm bakes in

| Situation                                 | Behavior                                                      |
| ----------------------------------------- | ------------------------------------------------------------- |
| Tank already high when daemon starts      | That level is `unknown`'s baseline (§7).                      |
| Mobile / web / chat usage                 | Tank rises with no Code activity → `unknown` (§7).            |
| Daemon was down during usage              | Those messages aren't in the DB → that rise → `unknown`.      |
| Access token expired                      | Skip the poll; keep ingesting + writing state (§5).           |
| 401 with a non-expired token (clock skew) | Treat like expiry; don't back off.                            |
| Network error                             | Exponential backoff (cap 5m), jittered; ingest still runs.    |
| Mid-week out-of-band reset                | Detected by pct-drop, never by `resets_at` (§3).              |
| Same request logged on several lines      | Dedup by `requestId` so it's counted once (§4).               |
| Partial trailing JSONL line               | Offset stops at the last newline; resumed next tick (§4).     |
| Daemon restart                            | Re-baseline transcripts at EOF — no backfill (§4).            |
| `weekly-opus` not on the plan (`null`)    | Skipped, not rendered as 0% (§2).                             |
| Cap with a `NaN`/`Infinity` utilization   | Skipped like a `null` cap; never poisons the trajectory (§2). |
| Two people, one machine                   | Hand off with `config set name`; applied next tick (§11).     |
| DB unreachable mid-run                    | Serve last-known from `state.json` with a stale badge (§8).   |

```

```
