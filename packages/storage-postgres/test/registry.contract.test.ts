import { describe, it } from "vitest";
import { runRegistryContract } from "../../core/test/registry-contract.js";
import { PostgresDatabase } from "../src/index.js";

// Runs the shared registry contract against a real Postgres when
// CCSHARE_TEST_PG_URL is set (CI provides one); otherwise skipped.
const url = process.env.CCSHARE_TEST_PG_URL;

if (url) {
  let n = 0;
  runRegistryContract({
    name: "postgres",
    fresh: async () => {
      const schema = `ccshare_reg_test_${Date.now()}_${n++}`;
      const u = new URL(url);
      u.searchParams.set("options", `-c search_path=${schema}`);
      const pg = (await import("postgres")).default;
      const admin = pg(url);
      await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await admin.end();
      const db = new PostgresDatabase(u.toString(), { max: 2 });
      await db.init();
      return db;
    },
  });
} else {
  describe("postgres registry contract", () => {
    it.skip("set CCSHARE_TEST_PG_URL to run the Postgres registry contract suite", () => {});
  });
}
