import type { Database, GroupRow, IngestSink, Registry, StorageViewSource } from "@ccshare/core";

/**
 * The server's injectable dependencies. Routes in app.ts are written against
 * these interfaces so the whole HTTP surface is testable with the in-memory
 * Database (memory-deps.ts); production wires PostgresDatabase/LibsqlDatabase
 * (backend.ts). All SQL lives in the storage packages behind the core-owned
 * `Database`/`Registry` interfaces — the server only routes and authenticates.
 */

export type { GroupRow, MemberRow, Registry } from "@ccshare/core";

/** One group's composed backend: a group-scoped Storage behind the core boundary. */
export interface Tenant {
  sink: IngestSink;
  /** StorageViewSource concretely — its cache key doubles as the ETag. */
  view: StorageViewSource;
}

export interface TenantProvider {
  /** The (cached) live tenant for a group. */
  get(group: GroupRow): Promise<Tenant>;
  close(): Promise<void>;
}

export interface ServerDeps {
  /** The one shared physical database (one pool/client per process). */
  db: Database;
  /** Always `db.registry` — a field for the routes' ergonomics. */
  registry: Registry;
  tenants: TenantProvider;
}
