import { afterAll, describe, it } from "vitest";
import { runStorageContract } from "../../core/test/storage-contract.js";
import { PostgresDatabase } from "../src/index.js";

// Runs the full shared contract against a real Postgres when CCSHARE_TEST_PG_URL
// is set (CI provides one). Each `fresh()` gets its own throwaway schema so the
// empty/ccshare states are clean; otherwise the suite is skipped.
const url = process.env.CCSHARE_TEST_PG_URL;

if (url) {
  let n = 0;
  const withSchema = (base: string) => {
    const schema = `ccshare_test_${Date.now()}_${n++}`;
    const u = new URL(base);
    u.searchParams.set("options", `-c search_path=${schema}`);
    return { url: u.toString(), schema };
  };

  const createSchema = async (schema: string) => {
    const pg = (await import("postgres")).default;
    const admin = pg(url);
    await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await admin.end();
  };

  // Storage facades share their Database's pool and their close() is a no-op,
  // so the harness tracks and closes the Databases themselves (a leaked pool
  // keeps vitest alive). Small per-Database pools: many are open at once.
  const dbs: PostgresDatabase[] = [];
  const openDb = async () => {
    const { url: u, schema } = withSchema(url);
    await createSchema(schema);
    const db = new PostgresDatabase(u, { max: 2 });
    await db.init();
    dbs.push(db);
    return db;
  };
  afterAll(async () => {
    await Promise.all(dbs.map((db) => db.close().catch(() => {})));
  });

  runStorageContract({
    name: "postgres",
    fresh: async () => (await openDb()).forGroup("default"),
    pair: async () => {
      const db = await openDb();
      return [db.forGroup("grp-a"), db.forGroup("grp-b")];
    },
  });
} else {
  describe("postgres contract", () => {
    it.skip("set CCSHARE_TEST_PG_URL to run the Postgres contract suite", () => {});
  });
}
