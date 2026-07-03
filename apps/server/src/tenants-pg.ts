import postgres, { type Sql } from "postgres";
import { StorageIngestSink, StorageViewSource } from "@ccshare/core";
import { PostgresStorage } from "@ccshare/storage-postgres";
import type { GroupRow, Tenant, TenantProvider } from "./deps.js";

/**
 * Schema-per-group tenancy: every group's ledger is a plain ccshare database
 * living in its own Postgres schema, reached through the unchanged
 * PostgresStorage adapter (`search_path`). The composed sink/view-source are
 * the same core pieces the self-host CLI uses — the server adds nothing but
 * routing and auth on top.
 *
 * Pools: one small pool per live tenant (max 2 connections, aggressive idle
 * reap), LRU-capped. If connection counts ever bite, the contained fallback is
 * a single pool + `SET search_path` per transaction inside this file.
 */
const TENANT_POOL_MAX = 2;
const TENANT_IDLE_SECS = 60;
const MAX_LIVE_TENANTS = 200;
/** Grace before an evicted tenant's pool is closed, so in-flight requests finish. */
const TENANT_DRAIN_MS = 30_000;

interface TenantEntry {
  tenant: Tenant;
  storage: PostgresStorage;
  /** Runs `sink.bootstrap()` (schema heal/migrate) exactly once per open. */
  ready?: Promise<void>;
}

export class PgTenantProvider implements TenantProvider {
  /** Tiny admin pool for CREATE SCHEMA only. */
  private admin: Sql;
  private tenants = new Map<string, TenantEntry>();

  constructor(private readonly url: string) {
    this.admin = postgres(url, { onnotice: () => {}, max: 1 });
  }

  async provision(group: GroupRow): Promise<void> {
    // schemaName is server-generated ('grp_' + uuid hex) — no user input — but
    // quote it anyway; identifiers can't be parameterized.
    await this.admin.unsafe(`CREATE SCHEMA IF NOT EXISTS "${group.schemaName}"`);
    const entry = this.open(group);
    // Bind the fresh ledger to the group's account (idempotent re-provision:
    // only an empty schema is initialized).
    if ((await entry.storage.inspect()).kind === "empty") {
      await entry.storage.initializeSchema(group.accountId);
    }
    await this.ready(entry); // heal the schema + prime the binding for ingest re-checks
  }

  async get(group: GroupRow): Promise<Tenant> {
    const entry = this.open(group);
    // Guarantee the schema is migrated to the current version before the tenant
    // serves any ingest/view. Migration used to ride on the daemon's `/v1/bootstrap`
    // call, but that's best-effort (it fails if the server is down at daemon start),
    // leaving a group on an older schema — and a v2 `ON CONFLICT` then hits a missing
    // unique index on every ingest. Healing on open makes it the server's guarantee.
    await this.ready(entry);
    return entry.tenant;
  }

  /** Bootstrap (migrate) a tenant's schema once per open; don't cache a failure. */
  private ready(entry: TenantEntry): Promise<void> {
    if (!entry.ready) {
      entry.ready = entry.tenant.sink.bootstrap().then(
        () => undefined,
        (err) => {
          entry.ready = undefined; // let the next request retry a transient failure
          throw err;
        }
      );
    }
    return entry.ready;
  }

  /** Cached tenant (LRU refresh on access), creating pools lazily. */
  private open(group: GroupRow): TenantEntry {
    const hit = this.tenants.get(group.id);
    if (hit) {
      // refresh LRU position
      this.tenants.delete(group.id);
      this.tenants.set(group.id, hit);
      return hit;
    }
    const storage = new PostgresStorage(this.url, {
      schema: group.schemaName,
      max: TENANT_POOL_MAX,
      idleTimeoutSecs: TENANT_IDLE_SECS,
    });
    const entry: TenantEntry = {
      tenant: {
        sink: new StorageIngestSink(storage),
        view: new StorageViewSource(storage),
        upsertUser: (name: string) => storage.upsertUser(name),
      },
      storage,
    };
    this.tenants.set(group.id, entry);
    if (this.tenants.size > MAX_LIVE_TENANTS) {
      const [oldestId, oldest] = this.tenants.entries().next().value!;
      this.tenants.delete(oldestId);
      // Don't close the pool out from under a request that grabbed this tenant
      // just before eviction — a concurrent ingest/view mid-transaction would hit
      // a closed pool and 500. Drain after a grace window; the pool's own idle
      // reaper frees the connections in the meantime.
      const timer = setTimeout(() => void oldest.storage.close().catch(() => {}), TENANT_DRAIN_MS);
      timer.unref?.();
    }
    return entry;
  }

  async close(): Promise<void> {
    await Promise.all([...this.tenants.values()].map((t) => t.storage.close().catch(() => {})));
    this.tenants.clear();
    await this.admin.end();
  }
}
