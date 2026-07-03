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
                      │     state.json (atomic)      IngestSink.ingest(ONE batch/tick)      │
                      └────────────┼─────────────────────────┼─────────────────────────────┘
                                   │            ┌────────────┴────────────┐
                                   │        selfhost                   shared
                                   │     shared DB (adapter)     ccshare server (HTTP)
                                   │            │                  one schema per group
                                   │            └────────────┬────────────┘
                  statusline ◄─────┘    tui / status ◄─ ViewSource.fetchView() → SharedView
                  (reads state only)    (computeSharedView = attributeShares + summarizeMembers,
                                         cached by change token; recomputed only on change)
```

No process talks to another process. The contract is **files plus one backend**:
the daemon writes `state.json` and sends each tick as one `IngestSink` batch;
readers pull the precomputed `SharedView` through a `ViewSource`. The backend is
either a database the group hosts itself ("selfhost") or the multi-tenant ccshare
server ("shared" — see §13).

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
person is just a name in ccshare's own config. The views also read
`oauthAccount.emailAddress` from the same file to show a human-readable account
label, cached ~once a minute since it barely changes (§8).

### 1.5 Account binding — one ledger, one account

The whole design rests on **every machine sharing one login** (§0): each poll
returns the _same_ account-wide tank, so the samples in the DB form a single
coherent trajectory. If two machines signed into **different** Claude accounts wrote
to the same ledger, `usage_samples` would interleave two unrelated tanks — the
attribution baseline (`win[0].pct`), the target (`win[last].pct`), and reset
detection would all read garbage. Nothing about a random `projectId` catches that.

So the ledger is **bound to an account**. `ccshare_meta.accountId` records the
`accountUuid` — the **UUID, never the email** (email is only a display label, and
can even be absent). The binding is enforced at two points:

- **`init`** resolves the local `accountUuid`. On an _empty_ DB it writes the binding
  at creation. On an existing _ccshare_ DB it **refuses** (like `foreign`) when the
  DB's bound account differs from the local one, before any migrate or write. A DB
  that is still _unbound_ (created before onboarding) is **claimed** for the local
  account on join.
- **The daemon** reads the binding once at startup. Every tick it compares the freshly
  resolved local account; on a mismatch it **halts all ledger writes** (samples,
  resets, messages) and flags `account.conflict` in `state.json`, which the views
  surface as the loudest footnote. It still polls, so the local user keeps seeing
  _their own_ tank — the shared ledger just stays clean.

Only a **hydrated** (onboarded) account has a real `accountUuid`; an unhydrated local
account (the `user-<hash>` fallback) never triggers a conflict and never binds — the
binding is claimed later, one-way (`null → accountUuid`), so onboarding can't trip a
false mismatch.

In **shared hosting** (§13) the same rule is enforced server-side: a group is a
ledger bound at creation (creating one _requires_ a hydrated account, so there is no
unbound state to claim), and `/v1/ingest` answers **409 `account-conflict`** —
writing nothing — when a tick's `accountId` doesn't match the group's. The daemon
maps that 409 onto the same halt-and-flag behavior.

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
  const batch = emptyBatch();                          // ONE ledger write per tick

  if (!creds || isTokenExpired(creds)) {
    tokenExpired = true;                              // skip poll; not an error
  } else {
    try {
      const fresh = await pollUsage(creds.accessToken);
      batch.resets.push(...detectResets(this.prev, fresh));
      batch.samples.push(...fresh);                    // dense trajectory
      samples = fresh; this.prev = fresh;
    } catch (err) {
      if (err instanceof UsageAuthError) tokenExpired = true;      // 401 → treat as expiry
      else pollFailed = true;                                      // network → back off
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
  const toSend = this.pending ? mergeBatches(this.pending, batch) : batch;
  try { await sink.ingest(toSend, { at: nowIso, accountId }); this.pending = null; }
  catch (err) {
    if (err instanceof AccountConflictError) { accountConflict = true; this.pending = null; }
    else { this.pending = toSend; pollFailed = true; }   // retry next tick
  }

  await atomicWriteJson(paths.stateFile, buildLocalState({
    accountId: account?.id ?? null, tokenExpired, accountConflict, samples,
    pid: process.pid, startedAt: this.startedAt, now: nowIso,
  }));
  return { pollFailed };
}
```

Details worth noting:

- A **sample is recorded every tick**, even if the tank didn't change. That dense
  trajectory is what attribution (§7) needs to align tank rises with activity.
- Everything observed lands in **one `TickBatch`** and one `sink.ingest` call —
  one DB transaction in selfhost mode, one `POST /v1/ingest` in shared mode. The
  batch also bumps the ledger's change token exactly once (§8.5).
- A **failed ingest keeps the batch** and merges it into the next tick's (bounded,
  newest rows win), so a transient outage never silently drops transcript rows —
  messages and markers are idempotent on uuid/id, so the re-send can't double-count.
- `currentName()` is resolved **fresh each tick** (re-reads config), so handing the
  machine to another person with `ccshare config set name alex` takes effect
  without restarting the daemon.
- An **activity marker** is added only when the tank rose but no message was
  ingested this tick _and_ this machine produced Code activity within the last few
  minutes — the daemon's local view of a lagged/uncaptured rise it can honestly
  claim for its user (§7). The whole batch is dropped on an account conflict (§1.5).
- Startup runs `sink.bootstrap()`: it heals the schema (selfhost), reports the
  ledger's bound account, and seeds `prev` with the latest stored samples so a
  reset that happened while the daemon was down is caught on the first poll.

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
2. Walk consecutive samples, tracking a **monotonic envelope** (the running max so
   far in the window). For each step, the rise `Δ = newMax − oldMax` is the genuine
   new-high; look at the Code activity whose timestamp falls in that interval:
   - activity present → split `Δ` across those users by token weight;
   - none → the whole `Δ` is `unknown` (mobile / web / chat, or daemon was down) —
     _unless_ a machine left an **activity marker** for that interval (a lagged or
     uncaptured local rise), which claims it for that user instead (see below).
     A reading that **dips** below the running max (clock-skew reorder across machines,
     or sub-point float wobble) is a new-high of zero — it neither inflates the active
     user nor discards their interval.
3. The window is bounded by **recorded reset events**, not by re-detecting drops here
   (a multi-machine series sorted by `capturedAt` can reorder under clock skew, and a
   view-time drop check would read that as a phantom reset).
4. `unknown` absorbs any remainder so the column totals the current tank.

```ts
// packages/core/src/state/shares.ts  (the core loop, abridged)
const attributed = new Map<string, number>();
attributed.set(UNKNOWN_USER, win[0].pct);            // 1. baseline = pre-daemon tank

let mi = 0;                                          // pointer into time-sorted messages
while (mi < msgs.length && msgs[mi].t <= win[0].t) mi++;   // skip pre-baseline activity

let envMax = win[0].pct;                              // monotonic envelope (running max)
for (let i = 1; i < win.length; i++) {
  const cur = win[i];

  // 2a. collect this interval's activity (advance pointer regardless of Δ)
  const weights = new Map<string, number>(); let total = 0;
  while (mi < msgs.length && msgs[mi].t <= cur.t) {
    const m = msgs[mi++];
    if (opusOnly && !isOpus(m.model)) continue;      // opus cap only counts opus models
    weights.set(m.user, (weights.get(m.user) ?? 0) + m.w);
    total += m.w;
  }
  // …and this interval's activity markers into markerWeights/markerTotal the same way

  const newMax = Math.max(envMax, cur.pct);
  const delta = newMax - envMax; envMax = newMax;    // rise off the running max
  if (delta <= 0) continue;                          // 3. dip/wobble → zero new-high

  if (total > 0) {                                   // 2b. split the rise by weight
    for (const [u, w] of weights) attributed.set(u, (attributed.get(u) ?? 0) + delta * w / total);
  } else if (markerTotal > 0) {                       // 2c. no message, but a machine
    for (const [u, w] of markerWeights)               //     flagged local Code was active
      attributed.set(u, (attributed.get(u) ?? 0) + delta * w / markerTotal);
  } else {                                           // 2d. nobody active → unknown
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

The window (`win`) is bounded to the **current reset cycle** — it starts at the most
recent **recorded reset event** (§3) for the cap and never looks back further than
the cap's length. It deliberately does **not** re-detect resets from pct drops in the
merged series: machines have skewed clocks, so a genuine rise can land out of order
(46% before 45%), and a view-time drop check would read that one-percent dip as a
phantom reset and dump the whole split into `unknown`. Reset events are recorded on a
single machine's clock between two of its own readings, so they don't suffer that.

```ts
const cutoff = now - CAP_WINDOW_MS[cap]; // 5h or 7d
let start = 0;
for (let i = 1; i < capSamples.length; i++) {
  if (capSamples[i].t < cutoff) start = i; // too old
}
const lastReset = resetTimes.length ? Math.max(...resetTimes) : -Infinity;
if (lastReset > -Infinity) {
  // drop the previous cycle: begin at the first sample at/after the reset
  const firstAfter = capSamples.findIndex((s) => s.t >= lastReset);
  start = Math.max(start, firstAfter < 0 ? capSamples.length - 1 : firstAfter);
}
const win = capSamples.slice(start);
```

The daemon seeds its `prev` reading from the shared DB at startup, so a reset that
happened while it was down is caught — and recorded as an event — on the first poll,
rather than being missed because `prev` began empty.

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

### Activity markers — reclaiming lagged / uncaptured local rises

One case the pure delta-vs-message correlation gets wrong: **real Code usage whose
token cost lands on the tank without a matching transcript line in that interval.**
The usage endpoint can report a heavy session's cost a tick or two _after_ its last
transcript line (an endpoint-lagged tail), and a **resume / compaction re-prime**
rebuilds a cold prompt cache — billed to the account, but under-reported (or absent)
in the transcript at the moment the tank moves. Both leave a genuine local rise in an
interval with no measured message, so the base algorithm dumps it on `unknown`.

The only observer that can tell this apart from real mobile/web/chat usage is the
**local daemon**: it alone knows _this machine's_ user was driving Code seconds ago.
So each tick, if a cap rose but **no message was ingested that tick** _and_ this
machine produced Code activity within the last few minutes (`MARKER_ACTIVITY_WINDOW_MS`,
3 min), the daemon records a **`UsageMarker`** — `{ user, at, model, weight }` — for
its current user, stamped at the instant it _observed_ the rise (so the marker lands
in the same sample interval, side-stepping the transcript's lag).

Attribution treats markers as a strict **fallback**: an interval with any real message
splits by measured weight as before; only a genuinely message-less rise consults its
markers (§2c). So a marker can never dilute measured attribution, and a rise more than
a few minutes after the machine went quiet still falls to `unknown` — the conservative
bias, so an idle machine never claims someone else's mobile usage. On a shared account
this stays honest: another machine's own daemon marks (or measures) its own activity,
and two machines contesting the same empty interval split it by marker weight.

It remains an **estimate**: the inter-user weight is the reliable signal
(`cache_read + cache_creation + output`; `input_tokens` is left out because it
undercounts and isn't comparable between users); Code + chat happening in the
_same ~60s interval_ can't be perfectly separated (that sliver attaches to the active
user); and an **activity marker** is a best-effort call that a message-less local rise
was the recently-active user's overhead rather than mobile/web. Every case is bounded
by the interval's delta — a world better than the whole tank.

---

## 8. The view model — what `status` and `tui` render

Both surfaces render from one model, assembled by `gatherView`. It prefers the
**shared backend** (everyone-included), falls back to the local **`state.json`**
(instant, no network), and finally to a one-shot **live poll** so the view is never
empty before the daemon's first write.

The heavy half — the raw-row reads plus attribution — lives in core as
`computeSharedView` and produces the compact **`SharedView`** (latest samples,
shares, member rollups, and the roster — a few KB, never raw rows):

```ts
// packages/core/src/state/view.ts  (abridged)
const since = new Date(now - CAP_WINDOW_MS.seven_day).toISOString();
const [latest, samplesSince, messagesSince, resetsSince, users] = await Promise.all([
  storage.getLatestSamples(), // the header bars
  storage.getUsageSamplesSince(since), // the trajectory, for attribution
  storage.getMessageUsageSince(since), // everyone's measured activity
  storage.getResetsSince(since), // reset events bound the window (§7)
  storage.getUsers(), // the roster
]);
// Fetch markers defensively — a DB missing the table for any reason degrades to
// "no markers" rather than letting one missing table blank the whole view.
const markersSince = await storage.getUsageMarkersSince(since).catch(() => []);

// Merge latest samples into samplesSince (deduplicating) to guarantee that
// a cap with a current reading (even if older than the window) is always
// attributed (falling back to unknown) rather than skipped entirely.
const allSamples = [...samplesSince];
const seen = new Set(samplesSince.map((s) => `${s.cap}:${s.capturedAt}`));
for (const s of latest) {
  const key = `${s.cap}:${s.capturedAt}`;
  if (!seen.has(key)) {
    allSamples.push(s);
    seen.add(key);
  }
}

return {
  generatedAt,
  samples: latest,
  shares: attributeShares(allSamples, messagesSince, now, resetsSince, markersSince), // §7
  members: summarizeMembers(messagesSince), // per-name token totals + last-seen
  users,
};
```

`gatherView` (apps/cli) wraps a `ViewSource.fetchView()` in the local decoration —
daemon pid, `state.json` fallback, live-poll fallback, the cached account email —
exactly as before.

### 8.5 The watermark — why a 2s refresh is cheap

The TUI refreshes every 2 seconds, but the ledger changes at most about once per
minute (the daemon cadence). Re-reading a 7-day window of samples (~30k rows) and
re-running attribution on every refresh was the original cost problem — hundreds of
thousands of heavy queries a day per viewer. The fix is a **write watermark**:

- Every ledger mutation (`recordBatch`, `upsertUser`, `prune`) bumps a single
  counter, `ccshare_meta.writeSeq`, **inside the same transaction**. Reading it
  (`getChangeToken`) is one single-row SELECT.
- A computed view is cached under `viewCacheKey(token, now)` — the token plus a
  **60-second time bucket**. The bucket exists because `attributeShares` windows
  slide with `now`: without it, a group whose daemons stopped writing would be
  served a frozen split forever. Worst case is one recompute per minute even with
  zero writes; a healthy group writes ~1/min anyway, so the bucket adds ~nothing.
- **Selfhost:** `StorageViewSource.fetchView()` does the 1-row token read; only a
  changed key re-runs `computeSharedView`. The heavy read drops from every-2s to
  ~1/min per viewer (~30×), and `reset_events` scans sit behind a real index now.
- **Shared:** the same key doubles as the **ETag** of `GET /v1/view`. The client
  sends `If-None-Match`; the steady-state answer is a bodyless **304** backed by
  one single-row SELECT on the server. Only a real change re-sends the few-KB view
  (§13).

Retention rides the same path: rows older than the widest cap window (+1 day of
slack — `RETENTION_MS`, 8 days) can never influence a view again, so the sink
prunes them on a throttled sweep and every table stays bounded.

`toDesignModel` flattens this into one presentation model: **caps** (the header
bars) and **members** (each person's per-window share, joined with their token
total and an `active` flag). `active` is deliberately simple — the member is
holding more than 0% of the **5-hour** window right now. The member list is keyed
on the people attribution produced; `unknown` is always last.

Two surfaces render that model:

- **`status`** is a plain-string renderer (`status-render.ts`): one frame,
  **coloured when stdout is a TTY and plain text when piped/redirected**, so
  `status | grep` and `status > file` stay clean. It targets 70 columns and sheds
  columns (the per-member bar, then trailing caps) on narrower terminals. Bar colour
  comes from a calculated green→red ramp (`heat.ts`, hue 120°→0° in HSL); each
  member's bar matches their name colour.
- **`tui`** re-runs `gatherView` every 2s (cheap — §8.5; the clock ticks every 1s
  so countdowns move), rendering the same model through one of three
  interchangeable Ink layouts — **overview · split · mono**, cycled with **Tab**
  (Shift+Tab reverses) — adding per-person token totals and scrolling for large
  groups. The views fill the terminal width and reflow live on resize
  (`useTermSize`).

Bare **`ccshare`** opens a **TUI-first shell** (`tui/Root.tsx`): unconfigured, it
lands on a guided onboarding wizard (the interactive form of `init`); configured, it
opens the live view, where **`c`** opens a tabbed **configure** screen
(general · daemon, same Tab / Shift+Tab cycling). Configure writes config, tests a
storage connection before saving, and starts/stops the daemon — all the interactive
form of the flag commands, which stay as a scriptable fallback.

Edge states (token expired, daemon down, live-poll badge) render as footnotes. When
the **database is unreachable** but the tank is still cached (offline), the member
table can't show the real split, so it degrades to a placeholder rather than an empty
list: `DISCONNECTED_ROWS` grey `xxxx` rows whose shares are a random — but
seed-stable, so they don't flicker across re-renders — partition summing to each
cached window, all marked idle, under a red (mono: white) "can't reach the database"
line. It reverts to the real per-person split the moment the DB is reachable again.

```
 ▐▛███▜▌   ccshare · status  ·  you are sam
▝▜█████▛▘  account sam@example.com  ·  2 members (1 active)
  ▘▘ ▝▝    shared db · synced 12s ago · daemon running

overall
  5h      ███████████████████████████░░   92%  · resets 4h 02m
  weekly  ██████░░░░░░░░░░░░░░░░░░░░░░░░   21%  · resets 6d 4h

members
   # member    usage                          5h   wk  state
   1 sam ◂     █░░░░░░░░░░░░░░░░░░░░░░░░░░   5%   1%  active
   2 unknown   ██████████████████████████  87%  20%  idle
```

---

## 9. Storage — the swappable boundary (and the layer above it)

Two boundaries stack here. The **outer** one is what commands compose
(`apps/cli/src/lib/backend.ts`): the daemon writes through an `IngestSink`, views
read through a `ViewSource`, and the config's `mode` picks the implementation —

```ts
function makeIngestSink(cfg: Config): IngestSink {
  if (cfg.mode === "shared") return new HttpIngestSink(serverUrl, bearer); // §13
  return new StorageIngestSink(makeStorage(cfg));
}
function makeViewSource(cfg: Config): ViewSource {
  if (cfg.mode === "shared") return new HttpViewSource(serverUrl, bearer); // §13
  return new StorageViewSource(makeStorage(cfg)); // watermark-cached (§8.5)
}
```

The **inner** boundary is `Storage` — still deliberately dumb (rows in, rows out,
no business logic), chosen from config in a single place (`makeStorage`:
libsql/sqlite → `LibsqlStorage`, postgres → `PostgresStorage`, memory →
`MemoryStorage`):

```ts
interface Storage {
  inspect(): Promise<DbInspection>; // empty | ccshare | foreign
  initializeSchema(accountId?): Promise<void>;
  bindAccount(accountId): Promise<void>; // claim an unbound ledger (§1.5)
  migrate(toVersion): Promise<void>;

  upsertUser(name); // bumps the change token
  getUsers();

  recordBatch(batch: TickBatch): Promise<void>; // ONE atomic write per tick:
  //   samples + resets appended, messages/markers idempotent on uuid/id,
  //   change token bumped once
  prune(before): Promise<void>; // retention: delete rows older than `before`
  getChangeToken(): Promise<string>; // 1-row read; the §8.5 cache key input

  getLatestSamples(): Promise<UsageSample[]>;
  getUsageSamplesSince(since): Promise<UsageSample[]>; // trajectory for attribution
  getResetsSince(since): Promise<ResetEvent[]>; // window bounds (indexed on `at`)
  getMessageUsageSince(since): Promise<MessageUsage[]>;
  getUsageMarkersSince(since): Promise<UsageMarker[]>; // §7 activity markers
}
```

`recordBatch` is one transaction (`sql.begin` in Postgres, `client.batch` in
libSQL), so a tick is all-or-nothing and bumps `writeSeq` exactly once. A single
**contract test suite** runs against the memory, libSQL, and Postgres adapters,
which is what proves swappability, the batching/dedup/prune semantics, the change
token, and the clean-DB rules below.

### Init inspection — clean DB enforcement

`ccshare init` refuses to mix into someone else's database. Inspection classifies
the target three ways and the CLI branches on it:

```ts
type DbInspection =
  | { kind: "empty" } // no tables  → prompt, then create
  | { kind: "ccshare"; schemaVersion: number; accountId: string | null } // ours → join
  | { kind: "foreign" }; // other tables → refuse
```

The marker is a `ccshare_meta` table holding `app='ccshare'`, `schemaVersion`, a
`projectId`, `createdAt`, and the bound `accountId` (§1.5). Init only creates tables
on `empty` (after explicit confirmation), only joins on `ccshare` — and then only
when the bound account matches (or is still null) — and **never** writes alongside a
`foreign` schema. `inspect` reads `ccshare_meta` with `SELECT *`, so an older DB
missing a column still reads (the absent column comes back as `null`).

---

## 10. No budgets or quotas

ccshare deliberately has **no budgets, targets, or quotas**. It reports the reality
of who used what and leaves it to the group to coordinate how much anyone should
use — the tool never prescribes or enforces a share. (The retired `budgets` table
was dropped from the schema baseline when v1 was redefined pre-production.)

---

## 11. Names, hand-offs, and `unknown`

- A **name** is the only identity (`^[A-Za-z0-9-]+$`), stored in local config — not
  bound to a machine. Several people can share a machine and hand off with
  `config set name <name>`; the running daemon picks up the change next tick.
  `isValidName` also **reserves `unknown`** (case-insensitive): a person can't
  register as the bucket below, or their share would silently merge into it.
- **`unknown`** is a normal, always-listed row. It receives: activity ingested with
  no/invalid name, tank rises during intervals with no measured Code activity _and no
  local activity marker_ (chat/mobile/web, or daemon down), the pre-daemon baseline,
  and normalization remainder. This is what keeps measured users from claiming usage
  they didn't cause.

---

## 12. Runtime portability

The same code runs on **Node (≥20) and Bun**, so it avoids native-only modules:

- HTTP via the global `fetch`.
- Default storage `@libsql/client` (one driver for `file:` and `libsql://`).
- `node:` imports for fs/path/crypto.
- The only runtime branch is `spawnDetached` (Bun.spawn vs `child_process`),
  isolated to one function.

CI runs the entire suite twice — once on Node, once on Bun — and the
Postgres-gated suites (storage contract + server integration) additionally run
against a real Postgres.

---

## 13. Shared hosting — the server, tenancy, and the two-password model

Self-hosting requires the group to run a database and hand every member its
credentials — which also means every member can read and write **anything**,
including usage rows under someone else's name. Shared hosting removes both the
infrastructure and that trust requirement: the CLI ships with a **hardcoded server
URL** (`CCSHARE_SERVER_URL` overrides it for dev/self-hosted servers), and members
authenticate instead of connecting.

### The trust model — two passwords

Joining a group takes exactly two secrets:

- the **group password** — shared by the whole group; proves a machine may join at
  all;
- a **member password** — personal; set the first time a name joins, required
  forever after to use that name. Taking an existing name without its password is
  refused (the anti-impersonation check), so `ccshare config set name <other>` in
  shared mode is a real **login**.

The group itself is located (and bound, §1.5) by the Claude `accountUuid`, resolved
locally from `~/.claude.json` — never typed, never guessable from the outside
alone. A successful join/login mints a **bearer token** (`ccs_…`), returned once
and stored client-side in the 0600 `~/.ccshare/token` file; the server keeps only
its sha256 hash. Passwords are stored as salted **scrypt** hashes
(`scrypt:N:r:p:salt:hash`, self-describing so parameters can be raised without
migrating rows) — `node:crypto` only, no native deps. Password endpoints sit
behind an in-memory per-(IP, account) failure damper, and the CLI refuses plain
`http://` for anything but localhost so a bearer never travels unencrypted.

### What the server enforces (that self-host can't)

Every ingested row's `user` is **overwritten with the authenticated member's
name** — the payload's name field is untrusted. Combined with the member password,
this means a member can misreport at most _their own_ share (by not running the
daemon), never inflate someone else's.

### Tenancy — one Postgres schema per group

The server is multi-tenant but the `Storage` boundary never learns that: each
group's ledger is a plain ccshare database living in its own Postgres schema
(`grp_<uuid>`), reached through the **unchanged `PostgresStorage` adapter** via
`search_path`. Per group, the server composes the very same core pieces the
self-host CLI uses — `StorageIngestSink` + `StorageViewSource` — so ingest
semantics, attribution, watermark caching, migration, and pruning are one code
path everywhere. The server-owned **registry** (groups / members / tokens) lives
in ordinary tables outside the `Storage` interface. Tenant pools are small
(max 2, aggressive idle reap) and LRU-capped.

### The API surface

| Endpoint               | Auth      | Purpose                                                                  |
| ---------------------- | --------- | ------------------------------------------------------------------------ |
| `POST /v1/groups`      | passwords | create the group (409 if the account already has one) → token            |
| `POST /v1/groups/join` | passwords | join: group password + new-name password set / existing verified → token |
| `POST /v1/login`       | passwords | re-auth an existing member (member password only) → token                |
| `POST /v1/ingest`      | bearer    | one daemon tick; names stamped server-side; 409 on account conflict      |
| `GET /v1/bootstrap`    | bearer    | daemon startup seed: bound account + latest samples                      |
| `GET /v1/view`         | bearer    | the `SharedView`, ETag'd — steady-state polls are bodyless 304s (§8.5)   |

The wire shapes live in `packages/core/src/remote/api.ts` and are imported by both
the server (`apps/server`) and the client (`CcshareClient` / `HttpIngestSink` /
`HttpViewSource` in `packages/core/src/remote/client.ts`), so they cannot drift.

---

## Appendix — edge cases the algorithm bakes in

| Situation                                  | Behavior                                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Tank already high when daemon starts       | That level is `unknown`'s baseline (§7).                                                                              |
| Mobile / web / chat usage                  | Tank rises with no Code activity → `unknown` (§7).                                                                    |
| Daemon was down during usage               | Those messages aren't in the DB → that rise → `unknown`.                                                              |
| Resume/compaction re-prime or lagged tail  | Local rise with no in-interval message → daemon marks it for its recent user (§7).                                    |
| Access token expired                       | Skip the poll; keep ingesting + writing state (§5).                                                                   |
| 401 with a non-expired token (clock skew)  | Treat like expiry; don't back off.                                                                                    |
| Network error                              | Exponential backoff (cap 5m), jittered; ingest still runs.                                                            |
| Mid-week out-of-band reset                 | Detected by pct-drop, never by `resets_at` (§3).                                                                      |
| Same request logged on several lines       | Dedup by `requestId` so it's counted once (§4).                                                                       |
| Partial trailing JSONL line                | Offset stops at the last newline; resumed next tick (§4).                                                             |
| Daemon restart                             | Re-baseline transcripts at EOF — no backfill (§4).                                                                    |
| `weekly-opus` not on the plan (`null`)     | Skipped, not rendered as 0% (§2).                                                                                     |
| Cap with a `NaN`/`Infinity` utilization    | Skipped like a `null` cap; never poisons the trajectory (§2).                                                         |
| Two people, one machine                    | Hand off with `config set name`; applied next tick (§11).                                                             |
| DB unreachable mid-run                     | Serve last-known from `state.json` with a stale badge (§8).                                                           |
| Machine signed into a different account    | `init` refuses; a running daemon halts ledger writes + flags a conflict (§1.5).                                       |
| Ledger created before onboarding (unbound) | Bound to the first hydrated account that joins; one-way (§1.5). Selfhost only — shared groups bind at creation (§13). |
| Server unreachable mid-run (shared mode)   | Same as DB unreachable: `state.json` + stale badge; failed batches retry next tick (§5, §8).                          |
| Ingest 409 (wrong account, shared mode)    | Nothing written; daemon flags `account.conflict` and drops the batch (§1.5, §13).                                     |
| Joining an existing name, wrong password   | Refused (401) — names are impersonation-protected in shared mode (§13).                                               |
| Transient ingest failure (network blip)    | The tick's batch is kept and merged into the next tick; uuid/id dedup makes the re-send safe (§5).                    |
| Corrupt/negative token count in a line     | Clamped to 0 so it can't invert the weighted split (§4, §7).                                                          |
| Message timestamped in the future          | Never matches an interval → its rise falls to `unknown` (§7).                                                         |
| Downward pct correction (not a reset)      | May register as a reset above `epsilon`; rare, pct-drop still beats `resets_at` (§3).                                 |

```

```
