import { MemoryStorage } from "../src/index.js";
import { runStorageContract } from "./storage-contract.js";

runStorageContract({
  name: "memory",
  fresh: async () => new MemoryStorage(),
  foreign: async () => new MemoryStorage({ foreign: true }),
});
