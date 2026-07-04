import { MemoryDatabase } from "@ccshare/core";
import type { ServerDeps } from "./deps.js";
import { TenantCache } from "./tenants.js";

/**
 * In-memory ServerDeps: the whole HTTP surface runs against these in tests (and
 * in the CLI's ungated end-to-end test) with zero infrastructure — the same
 * composition as production, over core's MemoryDatabase.
 */
export function makeMemoryDeps(): ServerDeps {
  const db = new MemoryDatabase();
  return { db, registry: db.registry, tenants: new TenantCache(db) };
}
