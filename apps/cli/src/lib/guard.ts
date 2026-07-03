import { StorageViewSource, type Config, type ViewSource } from "@ccshare/core";
import { loadConfig } from "./config.js";
import { makeStorage } from "./storage.js";
import { makeViewSource } from "./backend.js";

/**
 * Most commands require a completed `init`. Returns the config + an open
 * ViewSource, or null after printing guidance. Caller owns closing the source.
 *
 * Selfhost gets the full inspection gate (friendly errors for empty/foreign
 * DBs); shared mode gates on config + token presence — reachability problems
 * surface as the view's existing `stale` path instead of blocking startup.
 */
export async function requireInit(): Promise<{ cfg: Config; viewSource: ViewSource } | null> {
  const cfg = await loadConfig();
  if (!cfg) {
    console.error("Not initialized. Run `ccshare init` first.");
    process.exitCode = 1;
    return null;
  }

  if (cfg.mode === "shared") {
    if (!cfg.server?.url || !cfg.server.token) {
      console.error("Shared-hosting setup is incomplete. Run `ccshare init` again.");
      process.exitCode = 1;
      return null;
    }
    return { cfg, viewSource: makeViewSource(cfg) };
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
  // Reuse the already-open handle for the session's view source.
  return { cfg, viewSource: new StorageViewSource(storage) };
}
