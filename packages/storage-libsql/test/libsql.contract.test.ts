import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { runStorageContract } from "../../core/test/storage-contract.js";
import { LibsqlStorage } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "ccshare-libsql-"));
let n = 0;
const freshUrl = () => `file:${join(dir, `db-${n++}.sqlite`)}`;

runStorageContract({
  name: "libsql (file:)",
  fresh: async () => new LibsqlStorage(freshUrl()),
  foreign: async () => {
    const url = freshUrl();
    const c = createClient({ url });
    await c.execute("CREATE TABLE some_other_app (id INTEGER PRIMARY KEY)");
    c.close();
    return new LibsqlStorage(url);
  },
});
