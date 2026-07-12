import type { GroupRow, HistoryFinalizer, IngestSink, StorageViewSource } from "@ccpool/core";
import type { LibsqlDatabase, LibsqlRegistry } from "@ccpool/storage-libsql";

/**
 * The server's injectable dependencies. Routes in app.ts take `ServerDeps`, so
 * tests wire a libSQL `:memory:` database (test/helpers.ts) with the same
 * composition production uses (backend.ts). All SQL lives in
 * `@ccpool/storage-libsql` on `LibsqlDatabase`/`LibsqlRegistry` — the server
 * only routes and authenticates.
 */

export type { GroupRow, MemberRow } from "@ccpool/core";

/** One group's composed backend: a group-scoped Storage behind the core boundary. */
export interface Tenant {
  sink: IngestSink;
  /** StorageViewSource concretely — its cache key doubles as the ETag. */
  view: StorageViewSource;
  /** Shared with `sink`; the read routes tick it too (see {@link HistoryFinalizer}). */
  finalizer: HistoryFinalizer;
}

export interface TenantProvider {
  /** The (cached) live tenant for a group. */
  get(group: GroupRow): Promise<Tenant>;
  close(): Promise<void>;
}

export interface ServerDeps {
  /** The one shared physical database (one client per process). */
  db: LibsqlDatabase;
  /** Always `db.registry` — a field for the routes' ergonomics. */
  registry: LibsqlRegistry;
  tenants: TenantProvider;
}
