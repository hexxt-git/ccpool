import { describe, it } from "vitest";
import { runStorageContract } from "../../core/test/storage-contract.js";
import { PostgresStorage } from "../src/index.js";

// Runs the full shared contract against a real Postgres when CCSHARE_TEST_PG_URL
// is set (CI provides one). Each `fresh()` gets its own throwaway schema so the
// empty/ccshare/foreign states are clean; otherwise the suite is skipped.
const url = process.env.CCSHARE_TEST_PG_URL;

if (url) {
  let n = 0;
  const withSchema = (base: string) => {
    const schema = `ccshare_test_${Date.now()}_${n++}`;
    const u = new URL(base);
    u.searchParams.set("options", `-c search_path=${schema}`);
    return { url: u.toString(), schema };
  };

  const createSchema = async (schema: string, withForeignTable = false) => {
    const pg = (await import("postgres")).default;
    const admin = pg(url);
    await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    if (withForeignTable) {
      await admin.unsafe(`CREATE TABLE ${schema}.other_app (id INTEGER PRIMARY KEY)`);
    }
    await admin.end();
  };

  runStorageContract({
    name: "postgres",
    fresh: async () => {
      const { url: u, schema } = withSchema(url);
      await createSchema(schema);
      return new PostgresStorage(u);
    },
    foreign: async () => {
      const { url: u, schema } = withSchema(url);
      await createSchema(schema, true);
      return new PostgresStorage(u);
    },
  });
} else {
  describe("postgres contract", () => {
    it.skip("set CCSHARE_TEST_PG_URL to run the Postgres contract suite", () => {});
  });
}
