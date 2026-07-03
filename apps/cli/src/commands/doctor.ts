import { isTokenExpired, readCredentials, resolveAccount, resolveConfigDir } from "@ccshare/core";
import { configPath, loadConfig } from "../lib/config.js";
import { makeStorage } from "../lib/storage.js";
import { makeViewSource, resolveServerUrl } from "../lib/backend.js";

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
  console.log(`name:         ${cfg.name}`);
  console.log(`mode:         ${cfg.mode}`);

  if (cfg.mode === "shared") {
    const serverUrl = resolveServerUrl(cfg);
    console.log(`server:       ${serverUrl}`);
    console.log(
      cfg.server?.token
        ? "server auth:  token present"
        : "server auth:  no token — re-run `ccshare init`"
    );
    try {
      const res = await fetch(new URL("/healthz", serverUrl));
      console.log(res.ok ? "server ping:  ok" : `server ping:  answered ${res.status}`);
    } catch (err) {
      console.log(`server ping:  unreachable (${(err as Error).message})`);
    }
    if (cfg.server?.token) {
      try {
        const view = await makeViewSource(cfg).fetchView();
        console.log(`ledger:       ok (${view.users.length} member(s))`);
      } catch (err) {
        console.log(`ledger:       unreachable (${(err as Error).message})`);
      }
    }
    return;
  }
  console.log(`storage:      ${cfg.storage?.driver} ${cfg.storage?.url}`);

  const storage = makeStorage(cfg);
  try {
    const inspection = await storage.inspect();
    switch (inspection.kind) {
      case "empty":
        console.log("database:     empty — run `ccshare init`");
        break;
      case "ccshare": {
        console.log(`database:     ccshare (schema v${inspection.schemaVersion})`);
        // Compare the DB's bound account (accountUuid) against this machine's.
        const localId = account?.hydrated ? account.id : null;
        if (inspection.accountId == null) {
          console.log("db account:   unbound (binds to the first onboarded account)");
        } else if (localId != null && inspection.accountId !== localId) {
          console.log(`db account:   ${inspection.accountId}`);
          console.log(
            "  ⚠ MISMATCH — this database is bound to a different Claude account than\n" +
              "    the one you're signed into. The daemon will NOT record to the ledger."
          );
        } else {
          console.log(`db account:   ${inspection.accountId} (matches)`);
        }
        break;
      }
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
