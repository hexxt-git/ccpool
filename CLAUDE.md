# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ccpool gives a group sharing **one Claude subscription** a live, shared picture of
the account's usage and who's driving it. It is a **read-only observer plus a shared
ledger** — it never sits in the request path, never proxies, and only reads the
OAuth token Claude Code already stored.

The full pipeline is documented in the algorithm docs under
`apps/web/src/pages/docs/algorithm/` (the overview `index.md` plus observation,
attribution, views, storage-and-server, and resource-usage), published to the
marketing site at `/docs/algorithm`. `README.md` covers user-facing usage.

## Commands

```bash
pnpm install
pnpm build              # turbo build (respects ^build order; required before running the CLI)
pnpm type-check         # turbo type-check across the workspace
pnpm lint               # turbo lint (eslint)
pnpm format             # prettier --write .

pnpm test               # vitest run, on Node
pnpm test:bun           # the same suite under Bun (bun run vitest run)
pnpm vitest run packages/core/src/state/shares.test.ts   # a single file
pnpm vitest run -t "attributeShares"                     # tests matching a name

# run the built CLI
node apps/cli/dist/cli.js <command>
pnpm --filter @ccpool/cli dev <command>   # tsx, no build step

# run the built server (libSQL — a file: path or a libsql://… Turso URL)
DATABASE_URL=file:/tmp/ccpool-server.db PORT=8787 node apps/server/dist/index.js
DATABASE_URL=libsql://… CCPOOL_DB_AUTH_TOKEN=… PORT=8787 node apps/server/dist/index.js
```

Both runtimes must stay green — **CI runs the whole suite twice (Node and Bun)**. The
storage/registry contract suites and the server integration tests run on a libSQL
`:memory:` database (`file:` for the one on-disk regression test), so there is **no
external infrastructure** to provision — the whole suite is self-contained.

When manually exercising the CLI/daemon/server, isolate state with env overrides so
you don't touch real data: `CCPOOL_DIR` (ccpool's `~/.ccpool`), `CLAUDE_CONFIG_DIR`
(the Claude config dir it observes), and `CCPOOL_SERVER_URL` (points the CLI at a
dev server instead of the hardcoded host).

Note: the husky pre-commit hook only runs `lint-staged` (prettier) — it does **not**
run tests or eslint, so run `pnpm test` / `pnpm type-check` / `pnpm lint` yourself
before committing.

## Architecture

Monorepo (pnpm workspaces + turbo). The meaningful packages:

- `packages/core` — runtime-agnostic domain logic: the `Storage` interface (the one
  boundary; the adapter itself lives in storage-libsql), the `IngestSink`/`ViewSource`
  backend boundary (the storage-backed pieces the server composes + the HTTP client
  the CLI uses), the registry row/error shapes, the wire contract,
  identity/credentials, the usage poller, reset detection, the JSONL reader, the
  attribution algorithm, view assembly, and shared formatters. No UI, no process.
- `packages/storage-libsql` — the server-side backend and the **only** database code
  (`file:` local SQLite and remote `libsql://` Turso): `LibsqlDatabase` (the ONE
  client, DDL, the concrete `LibsqlRegistry`) + the `LibsqlStorage` facade. The
  server is the only thing that opens it; nothing else does.
- `packages/daemon` — the long-running observer (poll loop, lifecycle, `spawnDetached`).
- `apps/cli` — Commander + Ink CLI (the composition root). **HTTP client only — it
  never opens a database.**
- `apps/server` — the multi-tenant HTTP server (Hono; libSQL).
- `apps/web` — unrelated Astro marketing site.

### Design system (frontend and web)

strictly follow `apps/web/DESIGN.md`

### One path to the ledger, one boundary

Every machine reaches the shared ledger the **same way**: over HTTP through the
ccpool server at a hardcoded URL (`apps/cli/src/lib/links.ts#DEFAULT_SERVER_URL`,
`CCPOOL_SERVER_URL` overrides). Auth is two passwords — a shared **group password**
(proves membership) and a per-name **member password** (prevents impersonation) —
traded at init for a bearer token in the 0600 `~/.ccpool/token` file. The server
stamps every ingested row with the _authenticated_ member's name; **the CLI never
touches a database** (there is no selfhost mode, no `config.mode`).

The client composes the core boundary (`packages/core/src/backend/`): the daemon
writes through an `IngestSink` (one batched call per tick), views read through a
`ViewSource` (returns the compact precomputed `SharedView`). On the client both are
always the HTTP implementations. `apps/cli/src/lib/backend.ts` is the single place a
config becomes a sink/source. The server composes the storage-backed pieces
(`StorageIngestSink`/`StorageViewSource` in `backend/storage.ts`) over a
group-scoped `Storage`.

`@ccpool/core` ships the HTTP client **and** the storage-backed backend pieces (`StorageIngestSink`/`StorageViewSource`, written against the `Storage` interface) out of one barrel; the concrete adapter lives in `@ccpool/storage-libsql`. The "CLI never opens a database" split is held **by composition**: `apps/cli` imports no `storage-*` adapter and only wires the HTTP pair. There is no lint boundary — keep it a rule: the CLI imports the HTTP backend and view/format helpers from core, never `Storage*` or `@ccpool/storage-libsql`.

### The data flow

There is **no IPC**. The contract is files + the server API:

1. `apps/cli daemon run` → `packages/daemon` runs a tick loop. Each tick: poll the
   global tank → detect resets → ingest new transcript activity → write an atomic
   local `state.json` → send everything as **one** `IngestSink.ingest(batch)` (one
   `POST /v1/ingest`, which the server persists as one DB transaction). A failed
   batch is retained and merged into the next tick (idempotent uuids make the
   re-send safe).
2. `status`/`tui` build a view via `gatherView(cfg, viewSource)`: prefer the server
   backend (everyone-included), fall back to `state.json`, then a one-shot live
   poll. `statusline` reads `state.json` only.

### The read path is watermark-cached and window-mirrored (keep it that way)

The TUI refreshes every 2s but the ledger changes at most ~1/min, so the heavy work
hides behind a change token: every write bumps `ccpool_meta.writeSeq` in the same
transaction, and `viewCacheKey(token, now)` (`packages/core/src/state/view.ts`) adds
a 60s time bucket (attribution windows slide with `now`, so an idle ledger must
still drift). `StorageViewSource` recomputes only when the key moves; the server
uses the same key as the `GET /v1/view` ETag, so a steady-state poll is a bodyless
304 backed by one single-row SELECT.

The recompute itself runs over the group's **`LedgerWindow`**
(`packages/core/src/backend/window.ts`): an in-memory mirror of the 7-day raw-row
window, hydrated from storage ONCE (lazily, on the first view read) and appended to
by the ingest sink after each `recordBatch` commit — so a steady-state recompute
reads no ledger rows from the database (just the roster). Its mirror rules are
load-bearing, don't "simplify" them: insert-if-absent per natural key (the DB keeps
a retried tick's first write, so the window must too), `idle` drops appends /
`hydrating` buffers them, and trimming happens only when the sink's prune deletes
rows — never on a clock. `packages/core/test/window.test.ts` pins windowed ==
full-scan; keep it green. Never put raw-row queries back on the per-refresh path,
and never ship raw rows over the network — `SharedView` is the wire unit.

### Strict boundary: `Storage`

`packages/core/src/storage/storage.ts` is the one interface that must stay clean.
The adapter is dumb (rows in, rows out — `recordBatch`/`prune`/`getChangeToken` are
still just row mutation + a counter) — **no business logic lives in storage.**
**Storage is server-only** and every instance is **scoped to one `groupId`** (bound
at construction, injected as a `group_id` column on every table), so one shared
database backs every group. The contract suite
(`packages/core/test/storage-contract.ts`) runs the one adapter (`LibsqlStorage`)
over a libSQL `:memory:` database — including a two-groups-in-one-DB isolation case —
proving correctness, `group_id` isolation, and the group-setup rules.

**One `LibsqlDatabase`, one client per process.** `LibsqlDatabase`
(`packages/storage-libsql/src/database.ts`) is the one physical database the server
opens from `DATABASE_URL`: it owns THE single libSQL client, runs the idempotent
global DDL at boot (`init()`), and vends group-scoped `Storage` **facades**
(`forGroup`) over that shared client. A facade's `close()` is a no-op; only
`LibsqlDatabase.close()` tears down (tests must close it, or a leaked client hangs
vitest). Never give a group its own client again. There is **no `Database`
interface** — one driver, one concrete class the server imports directly.

**The registry lives in storage-libsql, not the server.** The registry tables
(groups/members/tokens) are the concrete `LibsqlRegistry`
(`packages/storage-libsql/src/registry.ts`) on `LibsqlDatabase`; core owns only the
row/input/error shapes (`packages/core/src/registry/registry.ts`), and `apps/server`
contains no SQL. The composed signup ops are single transactions that
deliberately cross into the ledger tables: `createGroupWithMember` writes the group
row + its `ccpool_meta` + the roster row + the member + the token atomically (a
lost UNIQUE race throws `RegistryConflictError` and writes NOTHING — no
compensation), and `addMemberWithToken` does member + roster + `writeSeq` bump +
token. A registry contract suite (`packages/core/test/registry-contract.ts`) runs
over a libSQL `:memory:` database. The server composes `LibsqlDatabase` in
`apps/server/src/backend.ts` and caches per-group compositions in `TenantCache`
(`apps/server/src/tenants.ts`). Ledger rows carry a `group_id` referencing
`groups(id)`.

### Schema changes require a versioned migration (do this every time)

**Any new feature or conflict-guard that touches the DB — a new column, table, or
`ccpool_meta` field — MUST ship as a numbered migration, never an ad-hoc schema
edit.** (`SCHEMA_VERSION` is currently **1**.) (update this too) For each such change:

1. Bump `SCHEMA_VERSION` in `packages/core/src/storage/storage.ts` and document
   what the new version adds.
2. Add the columns/tables to the fresh schema in
   `packages/storage-libsql/src/ddl.ts` — the shared DDL feeds both
   `LibsqlDatabase.init()` (boot) and `initializeSchema` (per-group provisioning) —
   keeping the `group_id` scoping.
3. Extend `migrate(toVersion)` in `LibsqlStorage` to bring an older DB forward
   **idempotently and additively** (nullable columns; `ADD COLUMN IF NOT EXISTS` /
   probe-then-`ALTER`), so it's forward- and multi-machine-safe. Never a destructive
   migration on a shared DB.
4. The server migrates each group's ledger on tenant open
   (`StorageIngestSink.bootstrap`), so nobody re-runs anything after an update. Keep
   it that way.
5. Cover it in the storage contract suite.

Migrations must stay backward-compatible: an older server still reads/writes a newer
DB (inspect uses `SELECT *`, writers only touch known columns). Don't make a new
schema version refuse older servers.

### Attribution lives in core, not storage

The per-person split is **delta-based time correlation** in
`packages/core/src/state/shares.ts#attributeShares`. Storage only exposes raw
`getUsageSamplesSince` (the tank trajectory), `getMessageUsageSince` (everyone's
measured activity), and `getUsageMarkersSince` (daemon activity markers);
`computeSharedView` feeds them to the pure `attributeShares`, which correlates tank
_rises_ with the Code activity in the same interval.

A rise with no measured message in its interval normally falls to `unknown`. The one
exception is a **`UsageMarker`**: the daemon records one when it observes a local rise
with no in-interval message _while this machine's user was driving Code moments ago_
(an endpoint-lagged tail, or a resume/compaction re-prime the transcript
under-reports). Markers are a **strict fallback** — a real message in the interval always wins, so they can never dilute measured attribution.

> Do not revert to apportioning the current tank by token weight — a single message would absorb 100% of the tank. `unknown` absorbs rises with no Code activity; columns always total the tank.

## Invariants to preserve

- **Runtime-agnostic.** Core, daemon, CLI, and server run on Node ≥20 and Bun. Use
  global `fetch`, `node:` specifiers, no native-only modules (passwords hash with
  `node:crypto` scrypt). The only runtime branch is `spawnDetached`.
- **Never mint or refresh a token.** Read it; if expired, skip the poll (Claude Code
  refreshes on its next run).
- **Trust the endpoint's `pct` verbatim; never estimate a percentage from tokens.**
  Detect resets by pct-drop, never by `resets_at`.
- **Only new activity counts.** The JSONL reader baselines every transcript at EOF on
  start and ingests only appended lines; restart re-baselines (no backfill). Dedup by
  `requestId`/`uuid`.
- **One ledger write per tick.** The daemon accumulates a `TickBatch` and makes one
  `ingest` call (`POST /v1/ingest`); the server persists it in one transaction and
  bumps that group's change token once. Retention (`prune`) keeps every table inside
  the 8-day window.
- **Tests resolve workspace packages to source.** `vitest.config.ts` aliases
  `@ccpool/*` to `src`, so tests run without a build — but the CLI runtime imports
  built `dist`, so build before running it.
- **Names are the only identity** (`^[A-Za-z0-9-]+$`, `≤ MAX_NAME_LENGTH`), not
  bound to machines; `unknown` is a normal, always-present row that absorbs
  unattributed usage. The server accepts exactly what `isValidName` accepts, so
  the length cap must live in `isValidName` (an unbounded name bloats rows and
  breaks the TUI columns). A name is additionally **password-protected**: joining an
  existing name requires its member password, and the server overwrites ingested
  rows' `user` with the authenticated member, so members can't write as each other. A
  hand-off (`config set name`) mints a fresh bearer, so it restarts the daemon — the
  sink's token is fixed at startup and the server attributes by token, not by the
  payload name.
- **Group setup is per-group.** Because one database holds every group, `inspect` is
  scoped to the instance's `groupId` and returns `empty` (this group has no ledger
  row yet) or `ccpool` (its `ccpool_meta` row exists). The server provisions a
  group by calling `initializeSchema(accountId)` on an `empty` group. There is no
  `foreign` state — only the server opens a DB, and always its own.
- **One ledger, one account.** `ccpool_meta.accountId` binds a group's ledger to a
  Claude `accountUuid` (the UUID, never the email). The server binds a group at
  creation (`POST /v1/groups` requires a hydrated account) and enforces it on ingest
  (409 `account-conflict` on `/v1/ingest`, nothing written); a running daemon halts
  all ledger writes on a mismatch and flags `state.json`'s `account.conflict`. The
  `accountId` column stays nullable so the one-way `null → accountUuid` claim
  (`bindAccount`) remains available.
- **Secrets stay out of config.json.** The 0600 `~/.ccpool/token` file holds the
  server bearer; the server stores only sha256 hashes of bearers and self-describing
  scrypt hashes of passwords. The CLI refuses plain-http server URLs except
  localhost.
