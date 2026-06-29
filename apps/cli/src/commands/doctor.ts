import { isTokenExpired, readCredentials, resolveAccount, resolveConfigDir } from "@ccshare/core";
import { configPath, loadConfig } from "../lib/config.js";
import { makeStorage } from "../lib/storage.js";

/** Re-run the inspection + identity checks and print findings. Changes nothing. */
export async function runDoctor(): Promise<void> {
  const configDir = resolveConfigDir();
  console.log(`config dir:   ${configDir}`);

  const account = await resolveAccount(configDir);
  if (account) {
    console.log(
      `account:      ${account.email ?? account.id}${account.hydrated ? "" : " (not onboarded)"}`
    );
  } else {
    console.log("account:      none found (sign in with Claude Code)");
  }

  const creds = await readCredentials(configDir);
  if (!creds) {
    console.log("credentials:  none found");
  } else if (isTokenExpired(creds)) {
    console.log("credentials:  token expired (Claude Code will refresh on next run)");
  } else {
    console.log("credentials:  ok");
  }

  const cfg = await loadConfig();
  if (!cfg) {
    console.log("ccshare:      not initialized — run `ccshare init`");
    return;
  }
  console.log(`ccshare cfg:  ${configPath()}`);
  console.log(`storage:      ${cfg.storage.driver} ${cfg.storage.url}`);
  console.log(`name:         ${cfg.name}`);

  const storage = makeStorage(cfg);
  try {
    const inspection = await storage.inspect();
    switch (inspection.kind) {
      case "empty":
        console.log("database:     empty — run `ccshare init`");
        break;
      case "ccshare":
        console.log(`database:     ccshare (schema v${inspection.schemaVersion})`);
        break;
      case "foreign":
        console.log("database:     foreign — ccshare needs its own clean database");
        break;
    }
  } catch (err) {
    console.log(`database:     unreachable (${(err as Error).message})`);
  } finally {
    await storage.close();
  }
}
