import { LibsqlDatabase } from "@ccpool/storage-libsql";
import type { ServerDeps } from "../src/deps.js";
import { TenantCache } from "../src/tenants.js";

/**
 * ServerDeps over a libSQL `:memory:` database: the whole HTTP surface runs
 * against these in tests (and the CLI's end-to-end test) with zero
 * infrastructure — the same composition production uses (backend.ts). One
 * database per call (`:memory:` is per-client); the caller tears it down
 * (`deps.tenants.close()` + `deps.db.close()`) in teardown so no client leaks.
 */
export async function makeTestDeps(): Promise<ServerDeps> {
  const db = new LibsqlDatabase(":memory:");
  await db.init();
  return { db, registry: db.registry, tenants: new TenantCache(db) };
}
