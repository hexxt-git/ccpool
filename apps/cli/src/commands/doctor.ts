import {
  ApiRequestError,
  isTokenExpired,
  readCredentials,
  resolveAccount,
  resolveConfigDir,
} from "@ccpool/core";
import { configPath, loadConfig } from "../lib/config.js";
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
    console.log("ccpool:      not initialized — run `ccpool init`");
    return;
  }
  console.log(`ccpool cfg:  ${configPath()}`);
  console.log(`name:         ${cfg.name}`);

  const serverUrl = resolveServerUrl(cfg);
  console.log(`server:       ${serverUrl}`);
  console.log(
    cfg.server?.token
      ? "server auth:  token present"
      : "server auth:  no token — re-run `ccpool init`"
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
      if (err instanceof ApiRequestError && err.status === 401) {
        console.log("ledger:       logged out — token rejected, re-run `ccpool init`");
      } else {
        console.log(`ledger:       unreachable (${(err as Error).message})`);
      }
    }
  }
}
