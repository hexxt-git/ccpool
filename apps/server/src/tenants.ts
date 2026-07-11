import { LedgerWindow, StorageIngestSink, StorageViewSource } from "@ccpool/core";
import type { LibsqlDatabase } from "@ccpool/storage-libsql";
import type { GroupRow, Tenant, TenantProvider } from "./deps.js";

/**
 * Tenancy over the one shared client. Every group's ledger is a group-scoped
 * `Storage` facade the `LibsqlDatabase` hands out — a tenant holds no connection
 * of its own, so opening one is cheap and evicting one is a plain map delete (an
 * in-flight request keeps working; its facade still points at the shared client).
 *
 * The LRU cap bounds per-tenant memory (the view cache), not connections.
 */
const MAX_LIVE_TENANTS = 50;

interface TenantEntry {
  tenant: Tenant;
  /** Runs `sink.bootstrap()` (schema heal/migrate) exactly once per open. */
  ready?: Promise<void>;
}

export class TenantCache implements TenantProvider {
  private tenants = new Map<string, TenantEntry>();

  constructor(private readonly db: LibsqlDatabase) {}

  async get(group: GroupRow): Promise<Tenant> {
    const entry = this.open(group);
    // Guarantee the schema is migrated to the current version before the tenant
    // serves any ingest/view. Healing on open makes it the server's guarantee, not
    // the daemon's best-effort bootstrap.
    await this.ready(entry);
    return entry.tenant;
  }

  /** Bootstrap (migrate) a tenant's ledger once per open; don't cache a failure. */
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

  /** Cached tenant (LRU refresh on access), composing over the shared Database. */
  private open(group: GroupRow): TenantEntry {
    const hit = this.tenants.get(group.id);
    if (hit) {
      // refresh LRU position
      this.tenants.delete(group.id);
      this.tenants.set(group.id, hit);
      return hit;
    }
    const storage = this.db.forGroup(group.id);
    // One in-memory ledger mirror per live tenant, shared by its sink and view
    // source: hydrated from storage once, appended by ingest ever after — the
    // steady-state view recompute reads no ledger rows from the database.
    const window = new LedgerWindow(storage);
    const entry: TenantEntry = {
      tenant: {
        sink: new StorageIngestSink(storage, { window }),
        view: new StorageViewSource(storage, { window }),
      },
    };
    this.tenants.set(group.id, entry);
    if (this.tenants.size > MAX_LIVE_TENANTS) {
      // Nothing to drain: facades hold no connections, so eviction only drops
      // cached view state. The evicted group re-hydrates on its next touch.
      const oldestId = this.tenants.keys().next().value!;
      this.tenants.delete(oldestId);
    }
    return entry;
  }

  async close(): Promise<void> {
    this.tenants.clear();
  }
}
