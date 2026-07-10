import { runRegistryContract } from "../../core/test/registry-contract.js";
import { LibsqlDatabase } from "../src/index.js";

// One isolated libSQL `:memory:` database per fresh() (the harness closes them).
runRegistryContract({
  name: "libsql (:memory:)",
  fresh: async () => {
    const db = new LibsqlDatabase(":memory:");
    await db.init();
    return db;
  },
});
