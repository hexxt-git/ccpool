import type { Config, Storage } from "@ccshare/core";
import { loadConfig } from "./config.js";
import { makeStorage } from "./storage.js";

/**
 * Most commands require a completed `init` against a compatible ccshare DB.
 * Returns the config + an open Storage, or null after printing guidance.
 * Caller owns closing the storage.
 */
export async function requireInit(): Promise<{ cfg: Config; storage: Storage } | null> {
  const cfg = await loadConfig();
  if (!cfg) {
    console.error("Not initialized. Run `ccshare init` first.");
    process.exitCode = 1;
    return null;
  }
  const storage = makeStorage(cfg);
  let kind: string;
  try {
    kind = (await storage.inspect()).kind;
  } catch (err) {
    console.error(`Database unreachable: ${(err as Error).message}`);
    process.exitCode = 1;
    await storage.close();
    return null;
  }
  if (kind !== "ccshare") {
    console.error(
      kind === "empty"
        ? "Database is empty. Run `ccshare init` to set it up."
        : "Database is not a ccshare database. Run `ccshare init` and point at a clean DB."
    );
    process.exitCode = 1;
    await storage.close();
    return null;
  }
  return { cfg, storage };
}
