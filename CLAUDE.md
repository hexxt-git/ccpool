# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ccshare gives a group sharing **one Claude subscription** a live, shared picture of
the account's usage and who's driving it. It is a **read-only observer plus a shared
ledger** — it never sits in the request path, never proxies, and only reads the
OAuth token Claude Code already stored.

Read `docs/ALGORITHM.md` for the full pipeline. `README.md` covers user-facing usage.

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
pnpm --filter @ccshare/cli dev <command>   # tsx, no build step
```

Both runtimes must stay green — **CI runs the whole suite twice (Node and Bun)** and
runs the storage contract against a real Postgres. To run the Postgres contract
locally, set `CCSHARE_TEST_PG_URL` (otherwise that suite skips).

When manually exercising the CLI/daemon, isolate state with env overrides so you
don't touch real data: `CCSHARE_DIR` (ccshare's `~/.ccshare`) and
`CLAUDE_CONFIG_DIR` (the Claude config dir it observes).

Note: the husky pre-commit hook only runs `lint-staged` (prettier) — it does **not**
run tests or eslint, so run `pnpm test` / `pnpm type-check` / `pnpm lint` yourself
before committing.

## Architecture

Monorepo (pnpm workspaces + turbo). The meaningful packages:

- `packages/core` — runtime-agnostic domain logic: the `Storage` interface, the
  in-memory adapter, identity/credentials, the usage poller, reset detection, the
  JSONL reader, the attribution algorithm, and shared formatters. No UI, no process.
- `packages/storage-libsql` — default adapter (`file:` and `libsql://`).
- `packages/storage-postgres` — second adapter, proving the boundary is swappable.
- `packages/daemon` — the long-running observer (poll loop, lifecycle, `spawnDetached`).
- `apps/cli` — Commander + Ink CLI (the composition root).
- `apps/web` — unrelated Astro marketing site.

### The data flow (read multiple files to see this)

There is **no IPC**. The only contract is files + the database:

1. `apps/cli daemon run` → `packages/daemon` runs a tick loop. Each tick: poll the
   global tank → detect resets → ingest new transcript activity → write an atomic
   local `state.json` and append samples + messages to the shared DB.
2. `status`/`tui` build a view via `apps/cli/src/lib/view.ts#gatherView`: prefer the
   shared DB (everyone-included), fall back to `state.json`, then a one-shot live
   poll. `statusline` reads `state.json` only.

### Strict boundary: `Storage`

`packages/core/src/storage/storage.ts` is the one interface that must stay clean.
Adapters are dumb (record/query rows only) — **no business logic lives in storage.**
`apps/cli/src/lib/storage.ts#makeStorage` is the single place a driver name becomes
an adapter. A shared contract suite (`packages/core/test/storage-contract.ts`) runs
against memory, libSQL, and Postgres; passing it is what proves swappability and the
clean-DB rules.

### Attribution lives in core, not storage

The per-person split is **delta-based time correlation** in
`packages/core/src/state/shares.ts#attributeShares`. Storage only exposes raw
`getUsageSamplesSince` (the tank trajectory) and `getMessageUsageSince` (everyone's
measured activity); the pure `attributeShares` function correlates tank _rises_ with
the Code activity in the same interval.

> Do **not** revert to apportioning the _current_ tank by token weight. That was the
> original bug: a single message made a user absorb 100% of the tank, including
> pre-daemon, prior-session, and mobile/web/chat usage. The tank level at the
> daemon's first reading is `unknown`'s baseline; a rise with no Code activity in its
> interval goes to `unknown`; `unknown` always absorbs the remainder so columns total
> the tank.

## Invariants to preserve

- **Runtime-agnostic.** Runs on Node ≥20 and Bun. Use global `fetch`, `node:`
  specifiers, no native-only modules. The only runtime branch is `spawnDetached`.
- **Never mint or refresh a token.** Read it; if expired, skip the poll (Claude Code
  refreshes on its next run).
- **Trust the endpoint's `pct` verbatim; never estimate a percentage from tokens.**
  Detect resets by pct-drop, never by `resets_at`.
- **Only new activity counts.** The JSONL reader baselines every transcript at EOF on
  start and ingests only appended lines; restart re-baselines (no backfill). Dedup by
  `requestId`/`uuid`.
- **Tests resolve workspace packages to source.** `vitest.config.ts` aliases
  `@ccshare/*` to `src`, so tests run without a build — but the CLI runtime imports
  built `dist`, so build before running it.
- **Names are the only identity** (`^[A-Za-z0-9-]+$`), not bound to machines;
  `unknown` is a normal, always-present row that absorbs unattributed usage.
- **`init` never writes into a foreign database.** Inspection classifies the target
  as `empty` / `ccshare` / `foreign`; only `empty` (after confirmation) or `ccshare`
  are written to.
