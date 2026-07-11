# ccpool — how it works, end to end

This document explains every algorithm in ccpool, in the order data flows through the system, with code excerpts from the actual implementation.

ccpool answers one question for a group sharing **one Claude subscription**: _the account is at 60% of its 5-hour limit — who caused that?_ Anthropic only reports a single account-wide number, so the per-person split has to be reconstructed locally and shared.

The whole system is a **read-only observer plus a shared ledger**. It never sits in the request path. Two facts drive the entire design:

1. **The tank level is global.** Every machine shares the same login, so every machine's usage poll returns the _same_ account-wide percentages.
2. **The per-person split is local and additive.** Each machine can only see the Claude Code activity on _that_ machine. Each daemon writes what it sees to a shared database; summed across everyone, that's the breakdown.

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
                                   │                          │  HTTP
                                   │                 ccpool server (§13)
                                   │            libSQL — one shared DB,
                                   │            every row scoped by group_id
                                   │                          │
                  statusline ◄─────┘    tui / status ◄─ ViewSource.fetchView() → SharedView
                  (reads state only)    (computeSharedView = attributeShares + summarizeMembers,
                                         cached by change token; recomputed only on change)
```

No process talks to another process. The contract is **files plus the server**: the daemon writes `state.json` and sends each tick as one `IngestSink` batch over HTTP; readers pull the precomputed `SharedView` through a `ViewSource`. The client never opens a database — the multi-tenant ccpool server owns the only one (§13).

---

## Contents

The pipeline, in the order data flows through the system:

1. **[Observation](algorithm/observation.md)** — identity & the OAuth token, polling the tank, reset detection, JSONL ingest, the daemon tick, `state.json`. _(§1–§6)_
2. **[Attribution](algorithm/attribution.md)** — the delta-based per-person split, activity markers, no budgets, names & `unknown`. _(§7, §10, §11)_
3. **[The view model](algorithm/views.md)** — what `status` and `tui` render, and the watermark cache that makes a 2s refresh cheap. _(§8)_
4. **[Storage and the server](algorithm/storage-and-server.md)** — the `Storage` boundary, runtime portability, and multi-tenant server with the two-password model. _(§9, §12, §13)_

See also [DESIGN.md](DESIGN.md) and [RESOURCE_UTILIZATION.md](RESOURCE_UTILIZATION.md).

---

## Appendix — edge cases the algorithm bakes in

| Situation                                 | Behavior                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Tank already high when daemon starts      | That level is `unknown`'s baseline (§7).                                                              |
| Mobile / web / chat usage                 | Tank rises with no Code activity → `unknown` (§7).                                                    |
| Daemon was down during usage              | Those messages aren't in the DB → that rise → `unknown`.                                              |
| Resume/compaction re-prime or lagged tail | Local rise with no in-interval message → daemon marks it for its recent user (§7).                    |
| Access token expired                      | Skip the poll; keep ingesting + writing state (§5).                                                   |
| 401 with a non-expired token (clock skew) | Treat like expiry; don't back off.                                                                    |
| Usage poll rate-limited (429)             | Poll fails → back off; the sync heartbeat freezes so "synced X ago" grows, not resets (§5, §8).       |
| Server revokes/rotates the bearer (401)   | Ingest can't be retried: latch `authRejected`; the reader logs out, stops the daemon, re-inits (§13). |
| Network error                             | Exponential backoff (cap 5m), jittered; ingest still runs.                                            |
| Mid-week out-of-band reset                | Detected by pct-drop, never by `resets_at` (§3).                                                      |
| Same request logged on several lines      | Dedup by `requestId` so it's counted once (§4).                                                       |
| Partial trailing JSONL line               | Offset stops at the last newline; resumed next tick (§4).                                             |
| Daemon restart                            | Re-baseline transcripts at EOF — no backfill (§4).                                                    |
| Several daemons spawned at once           | Atomic `O_EXCL` pidfile lock: exactly one wins, the rest exit `AlreadyRunningError` (§5).             |
| Daemon `SIGKILL`ed (stale pidfile)        | Next start finds a dead owner, reclaims the lock, and continues (§5).                                 |
| `weekly-opus` not on the plan (`null`)    | Skipped, not rendered as 0% (§2).                                                                     |
| Cap with a `NaN`/`Infinity` utilization   | Skipped like a `null` cap; never poisons the trajectory (§2).                                         |
| Two people, one machine                   | Hand off with `config set name`; applied next tick (§11).                                             |
| Machine signed into a different account   | A running daemon halts ledger writes + flags a conflict; the server 409s the tick (§1.5, §13).        |
| Server unreachable mid-run                | Serve last-known from `state.json` with a stale badge; failed batches retry next tick (§5, §8).       |
| Ingest 409 (wrong account)                | Nothing written; daemon flags `account.conflict` and drops the batch (§1.5, §13).                     |
| Joining an existing name, wrong password  | Refused (401) — names are impersonation-protected (§13).                                              |
| Transient ingest failure (network blip)   | The tick's batch is kept and merged into the next tick; uuid/id dedup makes the re-send safe (§5).    |
| Corrupt/negative token count in a line    | Clamped to 0 so it can't invert the weighted split (§4, §7).                                          |
| Message timestamped in the future         | Never matches an interval → its rise falls to `unknown` (§7).                                         |
| Downward pct correction (not a reset)     | May register as a reset above `epsilon`; rare, pct-drop still beats `resets_at` (§3).                 |
