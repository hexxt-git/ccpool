import { LibsqlDatabase } from "@ccpool/storage-libsql";
import type { Storage } from "../src/index.js";

// Core's own tests run against the real (only) adapter over a libSQL `:memory:`
// database — one isolated in-memory db per `freshStorage()`, resolved to source
// via the vitest alias (no package dep, so no turbo build cycle). `:memory:` is
// per-client, so every call gets its own database; all of them are torn down by
// `closeStorages()` — wire it to afterEach so no client leaks and hangs vitest.
const opened: LibsqlDatabase[] = [];

/**
 * A fresh, empty libSQL `:memory:` {@link Storage}. The ledger tables exist
 * (init() ran); the caller decides whether to `initializeSchema()`.
 */
export async function freshStorage(groupId = "g"): Promise<Storage> {
  const db = new LibsqlDatabase(":memory:");
  await db.init();
  opened.push(db);
  return db.forGroup(groupId);
}

/** Close every `:memory:` database opened via {@link freshStorage} in this file. */
export async function closeStorages(): Promise<void> {
  await Promise.all(opened.splice(0).map((db) => db.close().catch(() => {})));
}
