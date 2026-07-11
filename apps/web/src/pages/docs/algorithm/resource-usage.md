---
layout: ../../../layouts/DocsLayout.astro
title: Resource usage
description: What ccpool actually stores, writes, and reads for a group of N users.
---

_Part of the [ccpool algorithm docs](/docs/algorithm)._

This page details the resources ccpool consumes, for a group of N users. The figures are derived from the code, not measured, and they describe the current **envelope-based ledger**: the daemon reports on change and the server stores only the monotonic usage envelope, so the old "one sample row per tick" model no longer holds.

- **Poll cadence** — each machine's daemon ticks every **60 s** (`DEFAULT_POLL_INTERVAL_MS`), so it _reads_ the tank up to **1,440 times/day**. But a tick only _writes_ when something actually changed (see below), so ticks are not writes.
- **Report-on-change (daemon).** A tick sends an ingest only when it has real work: a cap's `pct` moved, a new Code request landed, a marker fired, or a reset was detected. A **steady tank with no new activity sends no ingest at all** (`isEmptyBatch` gates the `POST /v1/ingest`), so an idle group is nearly free.
- **Envelope filter (server).** Of the samples a tick does send, the server keeps only those that **raise the running max** for their cap in the current window (`EnvelopeFilter`). Flat repeats and dips are dropped, and a second machine reporting a level the global tank already reached raises nothing — so every member's stream **collapses into one canonical per-group trajectory**. A reset restarts the cap's envelope.
- **`pct` is an integer 0–100** taken verbatim from the endpoint's `utilization`. So one cap's envelope holds **at most ≈100 rows per cycle** (one per one-point rise), not one row per tick.
- **Three caps** (`CAP_KINDS`: `five_hour`, `seven_day`, `seven_day_opus`).
- **Retention** — the four raw ledger tables (`usage_samples`, `message_usage`, `usage_markers`, `reset_events`) are pruned to an **8-day window** (`RETENTION_MS = 7 days + 24 h`) on a throttled sweep (every 6 h). The two **history tables are retained unbounded** (see below).
- **IDs are 36-char UUIDs**, and every row carries a `group_id` UUID; those sizes are baked into the per-row figures.

There is **one architecture**: every machine reaches the shared ledger over HTTP through the ccpool server, and the server owns the only database. Two cost centres:

- **The server database** — a single libSQL database (a `file:` local SQLite or a remote `libsql://` Turso) holding every group's ledger, each row scoped by a `group_id` foreign key to the `groups` table. All storage, writes, and heavy reads live here.
- **The client (per machine)** — the CLI/daemon/TUI. It never opens a database; its only cost is HTTP: at most one ingest per active minute (fewer when idle) and one view poll every 2 s (almost all answered `304`).

The figures are the same for a local `file:` database or a remote Turso — the one adapter speaks both.

## Server Storage Consumption

Storage splits into two very different shapes, because the envelope makes the tank trajectory a **per-group** cost while measured activity stays **per-user**.

### Per-group tables (flat in N — one trajectory, shared)

| Table           | Rows in 8-day window (heavy use)            | Note                                           |
| :-------------- | :------------------------------------------ | :--------------------------------------------- |
| `usage_samples` | five_hour up to ≈500/day (≈4,000);          | monotonic envelope, integer pct, shared by all |
|                 | seven_day + opus ≈100–200 each → **≈4,300** | members — does **not** multiply by N           |
| `reset_events`  | ≈5–6/day → **≈45**                          | five_hour cycles + the two weekly caps         |

At ≈0.20 KB/row the whole per-group ledger is **≈0.9 MB** for a heavily-used group, and far less for a light one. Crucially this is **fixed in N**: a 100-user group and a 1-user group carry the same tank trajectory, because the envelope collapses every daemon's samples into one canonical stream.

### Per-user tables (scale with N)

| Table           | Rows in 8-day window    | ≈Bytes/row (incl. index) |  ≈KB |
| :-------------- | :---------------------- | :----------------------- | ---: |
| `message_usage` | ≈300/day × 8 ≈ 2,400    | ≈0.35 KB                 | ≈840 |
| `usage_markers` | up to ≈20/day × 8 ≈ 160 | ≈0.30 KB                 |  ≈48 |

So an active user adds roughly **≈0.9 MB** of pruned ledger. `message_usage` (one row per `requestId`) is now the dominant N-scaling cost — a reversal of the old model, where per-tick samples dominated.

### History tables (retained unbounded)

When a cap cycle closes (a reset, past a 30-min grace) it freezes into history and is **never pruned**:

- `history_windows` — one row per closed cycle per group: ≈5–6/day/group (mostly five_hour) → on the order of **≈2,000 rows/year/group** (≈0.3 MB/year).
- `history_shares` — one row per (closed cycle × participating user): a few rows per user per day; grows slowly and linearly, small per row.

History is tiny per day but unbounded, so over long horizons it, not the 8-day window, becomes a group's floor. It is intentionally cheap.

### Totals (8-day steady state, active users)

| Number of Users (N) | Per-group ledger | Per-user ledger | Total (approx) |
| :-----------------: | :--------------: | :-------------: | :------------: |
|     **1 User**      |     ≈0.9 MB      |     ≈0.9 MB     |    ≈1.8 MB     |
|     **5 Users**     |     ≈0.9 MB      |     ≈4.5 MB     |    ≈5.4 MB     |
|    **10 Users**     |     ≈0.9 MB      |      ≈9 MB      |     ≈10 MB     |
|    **50 Users**     |     ≈0.9 MB      |     ≈45 MB      |     ≈46 MB     |
|    **100 Users**    |     ≈0.9 MB      |     ≈90 MB      |     ≈91 MB     |

Plus the registry (`members` + `tokens`, ≈0.7 KB/user, one small `groups` row) and slowly-growing history — both negligible next to `message_usage`. These figures are roughly an order of magnitude below the pre-envelope estimates, which multiplied 34,560 per-tick samples by N.

## Database Writes (per Day)

Writes happen **only on the server**, and only when a daemon sends a **non-empty** batch. A batch is one transaction (`POST /v1/ingest` → one `recordBatch`) that bumps that group's change token (`ccpool_meta.writeSeq`) exactly once. An idle machine (flat tank, no new Code activity) sends nothing, so **writes track activity, not the tick clock**.

For an **active** user (call it ≈6 productive hours ≈ ≈360 active-minute ticks/day):

- **Ingest transactions**: about **≈360/day/user** (one per active minute), each a single `writeSeq` bump.
- **Sample inserts**: only envelope-raising points, and shared group-wide — about **≈500/day for the whole group** at heavy use (dominated by five_hour), not per user.
- **Message inserts**: **≈300/day/user** (one per `requestId`).
- **Marker / reset inserts**: **≈20/day/user** and **≈5/day/group**.
- **Prune**: throttled to every 6 h → **4 sweeps/day**, a handful of `DELETE`s each.
- **Registry writes**: `tokens.lastUsedAt` is touched at most once per minute per token (`TOKEN_TOUCH_INTERVAL_MS`) and only on a request that reaches the server → about **≈360/day/active user**.

| Number of Users (N) | Ledger Writes / Day | Registry Writes / Day | Total Writes / Day |
| :-----------------: | :-----------------: | :-------------------: | :----------------: |
|     **1 User**      |       ≈1,200        |         ≈360          |       ≈1,600       |
|     **5 Users**     |       ≈4,000        |        ≈1,800         |       ≈5,800       |
|    **10 Users**     |       ≈7,500        |        ≈3,600         |      ≈11,100       |
|    **50 Users**     |       ≈37,000       |        ≈18,000        |      ≈55,000       |
|    **100 Users**    |       ≈74,000       |        ≈36,000        |      ≈110,000      |

(Per-group sample/reset writes are counted once, not per user; the per-user rows are messages, markers, and ingest-transaction token bumps.) An idle day writes close to zero — a large drop from the old model, which assumed 1,440 unconditional sample-bearing ticks per user per day.

## Database Reads

The read path is **watermark-cached and window-mirrored**, so heavy reads are engineered out of steady state (this part of the design is unchanged):

- `GET /v1/view` first checks the group's change token — a **single-row `SELECT`** on `ccpool_meta` (the ETag). If it hasn't moved (and the 60 s time bucket hasn't rolled), the server returns a bodyless **`304`** from its cached `SharedView`. **No ledger rows are read.**
- When the token does move, the view is recomputed **at most once per minute group-wide** (not per viewer). That recompute reads the 7-day window from the in-memory **`LedgerWindow`** — the DB is touched only for the single-row token and the **tiny roster** (`getUsers()`, N rows). **Still zero ledger rows.**
- The heavy 7-day scan runs **once per tenant load** (lazy hydration on the first view read, or after a cache eviction / `invalidate`); the ingest sink then appends each committed batch to the mirror in RAM.

### Steady-state reads (per hour)

| Source                       | Cost                                                    |
| :--------------------------- | :------------------------------------------------------ |
| Client, per active viewer    | ≈1,800 `GET /v1/view`/hour, almost all bodyless `304`   |
| Server, per active viewer    | ≈1,800 single-row token `SELECT`s/hour (the ETag check) |
| Server, group-wide recompute | at most 60/hour, each reading only the N-row roster     |
| Server, ledger rows from DB  | **0** (the 7-day window is served from RAM)             |

A busy hour of viewing costs the database about 1,800 single-row lookups per viewer plus at most 60 roster reads — **it does not scan the ledger, and it does not scale with group size beyond the roster.**

### One-time hydration (per tenant load)

The only place the ledger window is scanned. The window now holds the **per-group envelope** (about ≈4,300 samples + ≈45 resets, shared) plus **per-user** measured rows (≈2,400 messages + up to ≈160 markers each), read once and then held in memory:

| Number of Users (N) | Rows Read Once at Hydration |
| :-----------------: | :-------------------------: |
|     **1 User**      |           ≈7,000            |
|     **5 Users**     |           ≈17,000           |
|    **10 Users**     |           ≈30,000           |
|    **50 Users**     |          ≈132,000           |
|    **100 Users**    |          ≈261,000           |

(Roughly 4,350 shared per-group rows + ≈2,560 per user.) Amortized over a long-lived server this rounds to about 0 rows/hour; it is paid only at process start, or per group on its first view after an eviction.
