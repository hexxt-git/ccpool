# ccshare — Resource Utilization Summary

This document details the resources ccshare consumes, based on the number of
users ($N$) in a group. The figures are derived from the code, not measured:

- **Poll cadence** — each machine's daemon ticks every **60 s**
  (`DEFAULT_POLL_INTERVAL_MS`) → **1,440 ticks/day**.
- **Samples per tick** — one `usage_sample` per available cap, and there are
  **3 caps** (`CAP_KINDS`: `five_hour`, `seven_day`, `seven_day_opus`) → up to
  **4,320 sample rows/day/user**. This is unconditional (a sample is written
  every tick, unique on `capturedAt`), so it is the dominant, fully deterministic
  cost. Messages/markers/resets are comparatively small and usage-dependent; the
  tables below assume an active user producing **~300 measured Code requests/day**
  (one `message_usage` row per `requestId`), and the totals are insensitive to
  that number because samples dominate.
- **Retention** — every ledger table is kept inside an **8-day window**
  (`RETENTION_MS = 7 days + 24 h`), so storage stabilizes after 8 days.
- **IDs are 36-char UUIDs** (`randomUUID()`), and every ledger row carries a
  `group_id` UUID; those sizes are baked into the per-row figures below.

Since the rewrite there is **one architecture**: every machine reaches the shared
ledger over HTTP through the ccshare server, and the server owns the only
database. So there are two very different cost centres:

- **The server database** — a single relational database (Postgres _or_ libSQL)
  holding every group's ledger, each row scoped by a `group_id` foreign key to
  the `groups` table. This is where all storage, writes, and heavy reads live.
- **The client (per machine)** — the CLI/daemon/TUI. It never opens a database;
  its only cost is HTTP requests to the server (one ingest per minute, one view
  poll every 2 s, almost all answered `304`).

The figures are identical whether the server runs on Postgres or libSQL — the
adapters implement the same relational model.

---

## 1. Server Storage Consumption

At steady state a user's rows in the 8-day window are, per user:

| Table            | Rows in window         | ~Bytes/row (incl. index) |        ~KB |
| :--------------- | :--------------------- | :----------------------- | ---------: |
| `usage_samples`  | 4,320/day × 8 ≈ 34,560 | ~0.20 KB                 |     ~6,900 |
| `message_usage`  | ~300/day × 8 ≈ 2,400   | ~0.35 KB                 |       ~840 |
| `usage_markers`  | ~20/day × 8 ≈ 160      | ~0.30 KB                 |        ~48 |
| `reset_events`   | ~5/day × 8 ≈ 40        | ~0.20 KB                 |         ~8 |
| **Ledger total** |                        |                          | **~7,800** |

The `usage_samples` stream — 34,560 rows in the window — is ~88% of a user's
footprint and is fully deterministic (it does not depend on how much anyone
codes). The `group_id` UUID that lets one database hold every group (no
schema-per-group, no database-per-group) is already counted in every row size.

On top of the ledger, the **registry** (`members` + `tokens` rows) is ~0.7 KB
per user, plus one small `groups` row per group — negligible (~1 KB/user).

| Number of Users ($N$) | Ledger Storage (KB) | + Registry (KB) | Total (approx) |
| :-------------------: | :-----------------: | :-------------: | :------------: |
|      **1 User**       |      ~7,800 KB      |      ~1 KB      |    ~7.6 MB     |
|      **5 Users**      |     ~39,000 KB      |      ~4 KB      |     ~38 MB     |
|     **10 Users**      |     ~78,000 KB      |      ~7 KB      |     ~76 MB     |
|     **50 Users**      |     ~390,000 KB     |     ~35 KB      |    ~381 MB     |
|     **100 Users**     |     ~780,000 KB     |     ~70 KB      |    ~762 MB     |

---

## 2. Database Writes (per Day)

Writes happen **only on the server**, driven by each machine's daemon ticking
every 60 s (1,440 ticks/day/machine). A tick is one batched transaction
(`POST /v1/ingest` → one `recordBatch`), which bumps that group's change token
(`ccshare_meta.writeSeq`) exactly once.

Per user per day:

- **Sample inserts**: 3 caps × 1,440 ticks = **4,320**.
- **Change-token bumps**: one per non-empty tick (every successful poll carries
  3 samples, so effectively every tick) = **~1,440**.
- **Message/marker/reset inserts**: **~325** (usage-dependent).
- **Prune**: a handful of `DELETE`s per day (four tables, one prune interval).
- → **Ledger writes ≈ 6,100/day/user.**
- **Registry writes**: `tokens.lastUsedAt` is touched at most once per minute per
  token (`TOKEN_TOUCH_INTERVAL_MS`) = **~1,440/day/user**.

| Number of Users ($N$) | Ledger Writes / Day | Registry Writes / Day | Total Writes / Day |
| :-------------------: | :-----------------: | :-------------------: | :----------------: |
|      **1 User**       |       ~6,100        |        ~1,440         |       ~7,540       |
|      **5 Users**      |       ~30,500       |        ~7,200         |      ~37,700       |
|     **10 Users**      |       ~61,000       |        ~14,400        |      ~75,400       |
|     **50 Users**      |      ~305,000       |        ~72,000        |      ~377,000      |
|     **100 Users**     |      ~610,000       |       ~144,000        |      ~754,000      |

Each machine itself issues just **~1,440 HTTP POSTs/day** (one ingest per tick);
the server fans those into the writes above.

---

## 3. Database Reads

The read path is **watermark-cached and window-mirrored**, so heavy reads have
been engineered out of steady state:

- `GET /v1/view` first checks the group's change token — a **single-row
  `SELECT`** on `ccshare_meta` (the ETag). If it hasn't moved (and the 60 s time
  bucket hasn't rolled), the server returns a bodyless **`304`** from its cached
  `SharedView`. **No ledger rows are read.**
- When the token _does_ move, the view is recomputed **at most once per minute
  group-wide** (not per viewer). That recompute reads the 7-day window from the
  in-memory **`LedgerWindow`** — the DB is touched only for the single-row token
  and the **tiny roster** (`getUsers()`, ~$N$ rows). **Still zero ledger rows.**
- The heavy 7-day scan runs **once per tenant load** (lazy hydration on the first
  view read, or after a cache eviction / `invalidate`), then the ingest sink
  appends each committed batch to the mirror in RAM.

### Steady-state reads (per hour)

| Source                       | Cost                                                    |
| :--------------------------- | :------------------------------------------------------ |
| Client, per active viewer    | ~1,800 `GET /v1/view`/hour, almost all bodyless `304`   |
| Server, per active viewer    | ~1,800 single-row token `SELECT`s/hour (the ETag check) |
| Server, group-wide recompute | ≤ 60/hour, each reading only the ~$N$-row roster        |
| Server, ledger rows from DB  | **0** (the 7-day window is served from RAM)             |

So the million-rows-per-hour heavy read is gone: a busy hour of viewing costs the
database ~1,800 single-row lookups per viewer plus ≤ 60 roster reads — **it does
not scan the ledger, and it does not scale with group size beyond the roster.**

### One-time hydration (per tenant load)

The only place the ledger window is scanned. Per user the 7-day window holds
~30,240 samples + ~2,100 messages + ~175 markers/resets ≈ **~32,500 rows**, read
once and then held in memory:

| Number of Users ($N$) | Rows Read Once at Hydration |
| :-------------------: | :-------------------------: |
|      **1 User**       |           ~32,500           |
|      **5 Users**      |          ~162,500           |
|     **10 Users**      |          ~325,000           |
|     **50 Users**      |         ~1,625,000          |
|     **100 Users**     |         ~3,250,000          |

Amortized over a long-lived server this rounds to ~0 rows/hour; it is paid only
at process start (or per group on its first view after an eviction).
