import { afterAll } from "vitest";
import { runStorageContract } from "../../core/test/storage-contract.js";
import { LibsqlDatabase } from "../src/index.js";

// Each openDb() is its own libSQL `:memory:` database (per-client isolation).
// Storage facades share their Database's client and their close() is a no-op, so
// the harness tracks and closes the Databases themselves.
const dbs: LibsqlDatabase[] = [];
const openDb = async () => {
  const db = new LibsqlDatabase(":memory:");
  await db.init();
  dbs.push(db);
  return db;
};
afterAll(async () => {
  await Promise.all(dbs.map((db) => db.close().catch(() => {})));
});

runStorageContract({
  name: "libsql (:memory:)",
  fresh: async () => (await openDb()).forGroup("default"),
  pair: async () => {
    const db = await openDb();
    return [db.forGroup("grp-a"), db.forGroup("grp-b")];
  },
});
