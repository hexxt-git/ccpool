import {
  ApiRequestError,
  CcshareClient,
  isValidName,
  resolveAccount,
  resolveConfigDir,
  type Config,
} from "@ccshare/core";
import { loadConfig, saveConfig } from "../lib/config.js";
import { makeStorage } from "../lib/storage.js";
import { resolveServerUrl } from "../lib/backend.js";
import { withPrompts } from "../lib/prompt.js";
import { isDaemonRunning, runDaemonRestart } from "./daemon.js";

const SETTABLE = ["name", "pollIntervalMs", "logLevel"] as const;

export async function runConfigGet(key?: string): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) {
    console.error("Not initialized — run `ccshare init`.");
    process.exitCode = 1;
    return;
  }
  if (!key) {
    console.log(`name           ${cfg.name}`);
    console.log(`mode           ${cfg.mode}`);
    if (cfg.mode === "shared") {
      console.log(`server.url     ${cfg.server?.url ?? "—"}`);
    } else {
      console.log(`storage.driver ${cfg.storage?.driver ?? "—"}`);
      console.log(`storage.url    ${cfg.storage?.url ?? "—"}`);
    }
    console.log(`pollIntervalMs ${cfg.pollIntervalMs}`);
    console.log(`logLevel       ${cfg.logLevel}`);
    return;
  }
  const value = readKey(cfg, key);
  if (value === undefined) {
    console.error(`Unknown key "${key}".`);
    process.exitCode = 1;
    return;
  }
  console.log(String(value));
}

export async function runConfigSet(key: string, value: string): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) {
    console.error("Not initialized — run `ccshare init`.");
    process.exitCode = 1;
    return;
  }

  let sharedIdentityChanged = false;

  switch (key) {
    case "name": {
      if (!isValidName(value)) {
        console.error(`Invalid name "${value}" — use letters, digits, and hyphens only.`);
        process.exitCode = 1;
        return;
      }
      if (cfg.mode === "shared") {
        // In shared mode a name is password-protected — switching identities means
        // logging in as that member, which mints a fresh bearer token. A name that
        // doesn't exist yet has no password to log into; joining it goes through
        // `ccshare init` (it needs the group password too).
        const acct = await resolveAccount(resolveConfigDir());
        if (!acct?.hydrated) {
          console.error("No onboarded Claude account found — sign into Claude Code first.");
          process.exitCode = 1;
          return;
        }
        const ok = await withPrompts(async (p) => {
          const memberPassword =
            process.env.CCSHARE_MEMBER_PASSWORD ?? (await p.ask(`Password for "${value}"`));
          try {
            const auth = await new CcshareClient(resolveServerUrl(cfg)).login({
              accountId: acct.id,
              memberName: value,
              memberPassword,
            });
            cfg.name = auth.memberName;
            cfg.server = { url: resolveServerUrl(cfg), token: auth.token };
            return true;
          } catch (err) {
            if (err instanceof ApiRequestError && err.code === "not-found") {
              console.error("No group exists for this account — run `ccshare init`.");
            } else if (err instanceof ApiRequestError && err.code === "auth") {
              console.error(
                `Login failed: ${err.message}. To add "${value}" as a NEW member, run \`ccshare init\`.`
              );
            } else {
              console.error(`Login failed: ${(err as Error).message}`);
            }
            return false;
          }
        });
        if (!ok) {
          process.exitCode = 1;
          return;
        }
        // A shared-mode hand-off mints a fresh bearer. A running daemon baked the
        // old token into its sink at startup and the server attributes by token,
        // not by the name in the payload — so unless we restart it, activity keeps
        // landing under the previous member. (Self-host needs no restart: the
        // daemon re-reads the name each tick.)
        sharedIdentityChanged = true;
        break;
      }
      cfg.name = value;
      // register the new name in the shared DB so it shows up immediately
      const storage = makeStorage(cfg);
      try {
        if ((await storage.inspect()).kind === "ccshare") await storage.upsertUser(value);
      } catch {
        // DB may be unreachable; config still updates
      } finally {
        await storage.close();
      }
      break;
    }
    case "pollIntervalMs": {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 1000) {
        console.error("pollIntervalMs must be a number >= 1000.");
        process.exitCode = 1;
        return;
      }
      cfg.pollIntervalMs = n;
      break;
    }
    case "logLevel": {
      if (!["debug", "info", "warn", "error"].includes(value)) {
        console.error("logLevel must be one of: debug, info, warn, error.");
        process.exitCode = 1;
        return;
      }
      cfg.logLevel = value as Config["logLevel"];
      break;
    }
    default:
      console.error(`"${key}" is not settable. Settable keys: ${SETTABLE.join(", ")}.`);
      process.exitCode = 1;
      return;
  }

  await saveConfig(cfg);
  console.log(`Set ${key} = ${value}`);

  // The new bearer only reaches a live daemon by restarting it (see above).
  if (sharedIdentityChanged && isDaemonRunning(cfg)) {
    await runDaemonRestart();
  }
}

function readKey(cfg: Config, key: string): unknown {
  switch (key) {
    case "name":
      return cfg.name;
    case "mode":
      return cfg.mode;
    case "server.url":
      return cfg.server?.url;
    case "storage.driver":
      return cfg.storage?.driver;
    case "storage.url":
      return cfg.storage?.url;
    case "pollIntervalMs":
      return cfg.pollIntervalMs;
    case "logLevel":
      return cfg.logLevel;
    default:
      return undefined;
  }
}
