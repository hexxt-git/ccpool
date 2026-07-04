import { MemoryDatabase } from "../src/index.js";
import { runRegistryContract } from "./registry-contract.js";

runRegistryContract({
  name: "memory",
  fresh: async () => {
    const db = new MemoryDatabase();
    await db.init();
    return db;
  },
});
