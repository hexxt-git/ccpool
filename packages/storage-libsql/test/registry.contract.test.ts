import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRegistryContract } from "../../core/test/registry-contract.js";
import { LibsqlDatabase } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "ccshare-libsql-registry-"));
let n = 0;

runRegistryContract({
  name: "libsql (file:)",
  fresh: async () => {
    const db = new LibsqlDatabase(`file:${join(dir, `db-${n++}.sqlite`)}`);
    await db.init();
    return db;
  },
});
