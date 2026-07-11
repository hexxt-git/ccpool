# Storage and the server — the storage boundary and tenancy

_Part of the [ccpool algorithm docs](../ALGORITHM.md)._

---

## 9. Storage — the boundary (and the layer above it)

Two boundaries stack here. The **outer** one is what commands compose (`apps/cli/src/lib/backend.ts`): the daemon writes through an `IngestSink`, views read through a `ViewSource`. The client always speaks HTTP to the server — there is no other implementation to pick:

```ts
function makeIngestSink(cfg: Config): IngestSink {
  return new HttpIngestSink(serverUrl, bearer); // §13
}
function makeViewSource(cfg: Config): ViewSource {
  return new HttpViewSource(serverUrl, bearer); // §13, watermark-cached (§8.5)
}
```

The **inner** boundary is `Storage` — used only on the **server**. It's deliberately dumb (rows in, rows out, no business logic), and its one adapter (`LibsqlStorage`, in `@ccpool/storage-libsql`) implements the relational model. Every instance is **scoped to one `groupId`**, bound at construction and injected into every query as a `group_id` column, so one shared database backs every group (see §13). The interface is unchanged by that — callers see a single ledger:

```ts
interface Storage {
  // scoped to one groupId
  inspect(): Promise<DbInspection>; // empty | ccpool (for this group)
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

`recordBatch` is one transaction (`client.batch(..., "write")`), so a tick is all-or-nothing and bumps that group's `writeSeq` exactly once. A **contract test suite** runs `LibsqlStorage` over a libSQL `:memory:` database — including a two-groups-in-one-database isolation case — which is what proves correctness, `group_id` isolation, the batching/dedup/prune semantics, the change token, and the group-setup rules below.

### Group inspection — per-group setup

Because one database holds every group, `inspect` is scoped to the instance's `groupId` and classifies **this group's** slice two ways:

```ts
type DbInspection =
  | { kind: "empty" } // this group has no ledger row yet → initialize it
  | { kind: "ccpool"; schemaVersion: number; accountId: string | null }; // exists → use it
```

The marker is a per-group `ccpool_meta` row (keyed by `group_id`) holding `app='ccpool'`, `schemaVersion`, a `projectId`, `createdAt`, and the bound `accountId` (§1.5). The ledger tables are created once (shared, `IF NOT EXISTS`); a group's ledger "exists" when its meta row does. The server provisions a group by calling `initializeSchema(accountId)` on an `empty` group. `inspect` reads `ccpool_meta` with `SELECT *`, so an older DB missing a column still reads (the absent column comes back as `null`). There is no `foreign` state: the client never opens a database, and the server always owns its own.

---

## 12. Runtime portability

The same code runs on **Node (≥20) and Bun**, so it avoids native-only modules:

- HTTP via the global `fetch`.
- Storage via `@libsql/client` (one driver for `file:` and remote `libsql://`).
- `node:` imports for fs/path/crypto.
- The only runtime branch is `spawnDetached` (Bun.spawn vs `child_process`), isolated to one function.

CI runs the entire suite twice — once on Node, once on Bun. The storage/registry contract suites and the server integration tests run on a libSQL `:memory:` database, so there is no external infrastructure to provision.

---

## 13. The server — tenancy and the two-password model

Every machine reaches the shared ledger the same way: over HTTP through the ccpool server, which owns the only database. Handing every member raw database credentials would let anyone read and write **anything**, including usage rows under someone else's name; authenticating against a server removes both that trust requirement and the need for anyone to run infrastructure. The CLI ships with a **hardcoded server URL** (`CCPOOL_SERVER_URL` overrides it for dev / a group's own self-hosted server), and members authenticate instead of connecting.

### The trust model — two passwords

Joining a group takes exactly two secrets:

- the **group password** — shared by the whole group; proves a machine may join at all. This is the anti-spoofing secret: the account identity that locates a group (the `accountUuid`, and the email behind it) is **client-reported** — the server has no way to verify it, so anyone could present someone else's account or email. Claiming an identity therefore only _finds_ the group; without the group password it grants nothing;
- a **member password** — personal; set the first time a name joins, required forever after to use that name. Taking an existing name without its password is refused (the anti-impersonation check), so `ccpool config set name <other>` is a real **login**.

The group itself is located (and bound, §1.5) by the Claude `accountUuid`, resolved locally from `~/.claude.json` — never typed, never guessable from the outside alone. Because it is self-reported, that identity _locates_ a group but never _authenticates_ against one — the group password does that. A successful join/login mints a **bearer token** (`ccs_…`), returned once and stored client-side in the 0600 `~/.ccpool/token` file; the server keeps only its sha256 hash. Passwords are stored as salted **scrypt** hashes (`scrypt:N:r:p:salt:hash`, self-describing so parameters can be raised without migrating rows) — `node:crypto` only, no native deps. Password endpoints sit behind an in-memory per-(IP, account) failure damper, and the CLI refuses plain `http://` for anything but localhost so a bearer never travels unencrypted.

### What the server enforces

Every ingested row's `user` is **overwritten with the authenticated member's name** — the payload's name field is untrusted. Combined with the member password, this means a member can misreport at most _their own_ share (by not running the daemon), never inflate someone else's.

### Tenancy — one relational database, `group_id` per group

The server runs on **libSQL** — one `DATABASE_URL` (a `file:` path or a remote `libsql://` Turso URL, plus `CCPOOL_DB_AUTH_TOKEN` for the latter), read by `resolveServerBackend`. The relational model is one shared database where every ledger row carries a `group_id` that references the `groups` table. The server is multi-tenant but the `Storage` boundary never learns that — each group is served by a `Storage` instance **scoped to its `group_id`** (see §9), composed into the very same core pieces used everywhere: `StorageIngestSink` + `StorageViewSource`. So ingest semantics, attribution, watermark caching, migration, and pruning are one code path. The **registry** (groups / members / tokens) lives in ordinary tables in the same database, as the concrete `LibsqlRegistry` on `LibsqlDatabase` — `apps/server` contains no SQL. There is **one libSQL client per process**: `LibsqlDatabase` owns it, runs the global DDL at boot, and vends `group_id`-scoped `Storage` facades via `forGroup`. Live tenants are LRU-capped in a connection-free `TenantCache` — the cap bounds per-tenant view-cache memory, not connections; a facade holds no client of its own.

### The API surface

| Endpoint               | Auth      | Purpose                                                                  |
| ---------------------- | --------- | ------------------------------------------------------------------------ |
| `POST /v1/groups`      | passwords | create the group (409 if the account already has one) → token            |
| `POST /v1/groups/join` | passwords | join: group password + new-name password set / existing verified → token |
| `POST /v1/login`       | passwords | re-auth an existing member (member password only) → token                |
| `POST /v1/ingest`      | bearer    | one daemon tick; names stamped server-side; 409 on account conflict      |
| `GET /v1/bootstrap`    | bearer    | daemon startup seed: bound account + latest samples                      |
| `GET /v1/view`         | bearer    | the `SharedView`, ETag'd — steady-state polls are bodyless 304s (§8.5)   |

The wire shapes live in `packages/core/src/remote/api.ts` and are imported by both the server (`apps/server`) and the client (`CcpoolClient` / `HttpIngestSink` / `HttpViewSource` in `packages/core/src/remote/client.ts`), so they cannot drift.
