import {
  ApiRequestError,
  CcpoolClient,
  isValidName,
  resolveAccount,
  resolveConfigDir,
  type Config,
} from "@ccpool/core";
import { loadConfig, saveConfig } from "../lib/config.js";
import { resolveServerUrl } from "../lib/backend.js";
import { withPrompts } from "../lib/prompt.js";
import { isDaemonRunning, runDaemonRestart } from "./daemon.js";

const SETTABLE = ["name", "pollIntervalMs", "logLevel"] as const;

export async function runConfigGet(key?: string): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) {
    console.error("Not initialized — run `ccpool init`.");
    process.exitCode = 1;
    return;
  }
  if (!key) {
    console.log(`name           ${cfg.name}`);
    console.log(`server.url     ${cfg.server?.url ?? "—"}`);
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
    console.error("Not initialized — run `ccpool init`.");
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
      // Names are password-protected: switching identity means logging in as that
      // member (mints a fresh bearer). Joining a new name goes through `ccpool init`.
      const acct = await resolveAccount(resolveConfigDir());
      if (!acct?.hydrated) {
        console.error("No onboarded Claude account found — sign into Claude Code first.");
        process.exitCode = 1;
        return;
      }
      const ok = await withPrompts(async (p) => {
        const memberPassword =
          process.env.CCPOOL_MEMBER_PASSWORD ?? (await p.ask(`Password for "${value}"`));
        try {
          const auth = await new CcpoolClient(resolveServerUrl(cfg)).login({
            accountId: acct.id,
            memberName: value,
            memberPassword,
          });
          cfg.name = auth.memberName;
          cfg.server = { url: resolveServerUrl(cfg), token: auth.token };
          return true;
        } catch (err) {
          if (err instanceof ApiRequestError && err.code === "not-found") {
            console.error("No group exists for this account — run `ccpool init`.");
          } else if (err instanceof ApiRequestError && err.code === "auth") {
            console.error(
              `Login failed: ${err.message}. To add "${value}" as a NEW member, run \`ccpool init\`.`
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
      // A hand-off mints a fresh bearer, but a running daemon baked the old token in
      // at startup and the server attributes by token — so restart it, or activity
      // keeps landing under the previous member.
      sharedIdentityChanged = true;
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
  if (sharedIdentityChanged && isDaemonRunning()) {
    await runDaemonRestart();
  }
}

function readKey(cfg: Config, key: string): unknown {
  switch (key) {
    case "name":
      return cfg.name;
    case "server.url":
      return cfg.server?.url;
    case "pollIntervalMs":
      return cfg.pollIntervalMs;
    case "logLevel":
      return cfg.logLevel;
    default:
      return undefined;
  }
}
