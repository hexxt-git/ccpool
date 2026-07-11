---
layout: ../../../layouts/DocsLayout.astro
title: Observation
description: Reading the tank and the transcripts — identity, polling, reset detection, JSONL ingest, the daemon tick.
---

_Part of the [ccpool algorithm docs](/docs/algorithm)._

## Identity — which account, whose token

ccpool reads the token Claude Code **already stored**. It never logs in.

Everything is scoped to a Claude _config dir_ (`~/.claude` by default, `CLAUDE_CONFIG_DIR` overrides), with transcripts under `projects/` and the account identity in a sibling `.claude.json`. The token itself is read from `.credentials.json` (Linux + a universal fallback) or, on macOS, the keychain (`security find-generic-password`) — whichever exists first:

```ts
interface Credentials {
  accessToken: string;
  expiresAt: number; // epoch ms
}
```

**Every use is gated on expiry.** If the token is expired (or `expiresAt` isn't finite) we skip the poll entirely — Claude Code refreshes it on its next run; ccpool never mints or refreshes a token.

`resolver.ts` separately reads `oauthAccount.accountUuid` from the global JSON to identify the **account** (used to scope/label the tank) — never the person; the person is just a name in ccpool's own config. The views also read `oauthAccount.emailAddress` for a human-readable label, cached ~once a minute ([the view model](/docs/algorithm/views#the-view-model--what-status-and-tui-render)).

### Account binding — one ledger, one account

The whole design rests on **every machine sharing one login** ([the pipeline](/docs/algorithm#the-pipeline-at-a-glance)): each poll returns the _same_ account-wide tank, so the samples in the DB form one coherent trajectory. If two machines signed into **different** Claude accounts wrote to the same ledger, `usage_samples` would interleave two unrelated tanks and the attribution baseline, target, and reset detection would all read garbage.

So the group's ledger is **bound to an account**. `ccpool_meta.accountId` records the `accountUuid` — the **UUID, never the email** (email is only a display label, and can be absent). The binding is enforced at two points:

- **The server** ([the server](/docs/algorithm/storage-and-server#the-server--tenancy-and-the-two-password-model)) binds a group at creation — `POST /v1/groups` _requires_ a hydrated account, so there is no unbound state to claim — and answers **409 `account-conflict`** (writing nothing) when a tick's `accountId` doesn't match.
- **The daemon** reads the binding once at startup and compares the freshly resolved local account each tick; on a mismatch (or a 409) it **halts all ledger writes** and flags `account.conflict` in `state.json`. It still polls, so the local user keeps seeing their own tank — the shared ledger just stays clean.

Only a **hydrated** account has a real `accountUuid`; the `user-<hash>` fallback never triggers a conflict, and a tick with a null `accountId` is accepted, so onboarding can't trip a false mismatch. The `accountId` column stays nullable so the one-way `null → accountUuid` claim (`bindAccount`) stays available.

## Polling the tank

The global tank comes from one endpoint — `GET https://api.anthropic.com/api/oauth/usage`, with the OAuth beta header (`anthropic-beta: oauth-2025-04-20`) and a `claude-code` user agent. A `401` is treated as token expiry (no back-off); any other non-2xx backs off.

The response has one node per cap:

```jsonc
{
  "five_hour": { "utilization": 46.0, "resets_at": "2026-06-29T21:10:00Z" },
  "seven_day": { "utilization": 19.0, "resets_at": "2026-07-05T22:00:00Z" },
  "seven_day_opus": null, // null = not applicable to this plan
}
```

Parsing maps each non-null cap to a `UsageSample`:

```ts
type CapKind = "five_hour" | "seven_day" | "seven_day_opus";

interface UsageSample {
  cap: CapKind;
  pct: number; // taken verbatim from `utilization`, never derived from tokens
  resetsAt: string | null;
  capturedAt: string;
}
```

**`pct` is taken verbatim from `utilization`** — we never derive a percentage from token counts (that mapping is unstable). A cap is skipped (never rendered as 0%) when it is `null` **or** when `utilization` is **non-finite** (`NaN`/`Infinity`) — because `typeof NaN === "number"`, a bare type check would let it through and poison reset detection and attribution. Any _finite_ pct is trusted verbatim.

## Reset detection — by pct-drop, never by clock

Each cap carries a `resets_at`, but that field is unreliable (Anthropic flushes some windows out-of-band). So a reset is detected purely by the percentage **dropping** between two consecutive readings by more than an `epsilon` of `0.5` (which ignores sub-point float jitter):

> `reset ⟺ next.pct < prev.pct − 0.5` — per cap, between one machine's own two readings.

Resets matter twice: they're logged as `ResetEvent`s, and they re-baseline the attribution window ([attribution](/docs/algorithm/attribution#attribution--the-heart-of-the-per-person-split)).

## JSONL ingest — only new activity, attributed to a name

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

Each parsed line becomes a `MessageUsage`:

```ts
interface MessageUsage {
  uuid: string; // dedup key: requestId, falling back to uuid
  user: string; // the active name at ingest; invalid/missing → "unknown"
  timestamp: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}
```

Two quirks drive the parse: **a single request emits several assistant lines with identical usage** (streaming + tool-use blocks), so the dedup id is `requestId` (falling back to `uuid`) to avoid double-counting; and the active **name** is stamped at ingest, with an invalid/missing name falling to `unknown`. Negative token counts are clamped to 0 so they can't invert the weighted split.

**Tailing without backfilling.** The daemon must never ingest old history (its token counts are unreliable and can't be tied to whoever is using the account now). So on the **first** read the reader records every existing file's end-of-file offset and returns nothing; thereafter it reads only bytes appended past that offset, **stops at the last newline** (a half-written trailing line is left for next time), and dedups uuids within a batch. Offsets live **in memory** only, so a daemon restart re-baselines at EOF — activity that landed while the daemon was down is skipped by design.

## The daemon tick

One tick wires the above together. The key property: **poll, ingest, and state write are independent** — a failed poll never blocks attribution, and `state.json` is always refreshed. Each tick:

1. Resolve the local account and read credentials. If the token is missing/expired, **skip the poll** (not an error); otherwise poll the tank, detect resets, and collect the caps whose `pct` **moved** since the last reading (report-on-change — a steady tank ingests nothing).
2. Collect new transcript rows for the current name (resolved **fresh each tick**, so `ccpool config set name alex` takes effect without a restart).
3. If a cap rose this tick with **no** message but this machine drove Code within the last few minutes, add an **activity marker** so the rise isn't lost to `unknown` ([attribution](/docs/algorithm/attribution#activity-markers--reclaiming-lagged--uncaptured-local-rises)).
4. Send everything as **one `TickBatch`** → one `sink.ingest` → one `POST /v1/ingest`, persisted as one DB transaction that bumps the group's change token once.
5. Write `state.json` atomically.

The load-bearing details:

- **One write per tick.** Everything observed lands in one `TickBatch`:

  ```ts
  interface TickBatch {
    samples: UsageSample[]; // only caps whose pct moved (or accompany a reset)
    resets: ResetEvent[];
    messages: MessageUsage[]; // idempotent on uuid/id
    markers: UsageMarker[]; // idempotent on uuid/id
  }
  ```

  On the server an **envelope filter** keeps only samples that raise the running max for their cap, collapsing every member's stream into one canonical per-group trajectory.

- **A failed ingest keeps the batch** and merges it into the next tick's; messages and markers are idempotent on uuid/id, so the re-send can't double-count. An `AccountConflictError` (409) drops the batch and flags the conflict. A **401** ingest is _not_ retryable — the bearer was revoked or rotated by a hand-off elsewhere — so the daemon latches `authRejected`; the reader treats that as logged out, stops the daemon, deletes the token, and routes back to `init`. (Contrast the poll's 401, which is just a token-refresh gap.)
- **The sync heartbeat** (`lastSyncAt`) advances **only on a fully clean tick** — a fresh poll _and_ a landed ingest (or nothing new to send). `updatedAt` bumps every tick, but "synced X ago" reads `lastSyncAt`, so a 429 poll or an unreachable ingest makes the footer age grow instead of falsely resetting to zero.
- **Startup** runs `sink.bootstrap()`: it reports the group's bound account and seeds `prev` with the latest stored samples (`GET /v1/bootstrap`), so a reset that happened while the daemon was down is caught on the first poll.

### The run loop — single-instance lock

The loop ticks every `pollIntervalMs`, applies **exponential back-off** (cap 5m) on poll failure, and sleeps a **±10% jittered** delay so a fleet doesn't sync up.

Lifecycle is enforced by a **single-instance pidfile lock** keyed to a hash of the config dir. The lock is taken with an atomic `openSync(pidFile, "wx")` (`O_CREAT | O_EXCL`): the kernel creates the file only if it doesn't already exist, in one indivisible step, so two daemons racing to boot can never both win — exactly one creates it, every other gets `EEXIST` and exits `AlreadyRunningError`. (A plain read-pid → check-alive → write sequence has a TOCTOU window that once let a fleet of daemons pile up, since `spawnDetached` takes a second or two to start.) A stale lock (owner `SIGKILL`ed, or empty from a crash mid-write) is reclaimed only if its recorded pid is dead.

The atomic acquire is point-in-time, and that alone isn't enough: the pidfile can later vanish (a manual `rm`, a crashed starter's stale-reclaim `unlink`) after which a second daemon starts legitimately and both run **invisibly**. So a live daemon **re-asserts ownership for its whole life** (`reassertLock`) — at the top of every tick and on a 5s guard timer — reconciling against the pidfile as the single source of truth: if it records us we continue; if it's missing/dead we re-acquire; if it holds a **different live** pid we are the duplicate and **surrender immediately**. The fleet converges to exactly one within seconds. SIGINT/SIGTERM flush, close storage, and remove the pidfile.

## `state.json` — the local snapshot

Written **atomically** (temp file + rename) so a reader never sees a half-written file. The snapshot carries two timestamps with different meanings — `updatedAt` (bumped every tick — proof the daemon is alive and writing) and `lastSyncAt` (advanced only on a clean poll + ingest — what "synced X ago" reports) — plus three health flags the readers surface: `tokenExpired` (Claude Code will refresh), `account.conflict` (this machine's account ≠ the ledger's — writes halted), and `account.authRejected` (the server revoked the bearer — logged out).

`statusline` reads only this file — cheap, no network — so it's safe to call on every prompt. It short-circuits to a loud `⚠ ccpool logged out · run \`ccpool init\``line when`authRejected` is set, rather than painting a stale tank.
