import { isValidName, type Config } from "@ccshare/core";
import { loadConfig, saveConfig } from "../lib/config.js";
import { makeStorage } from "../lib/storage.js";

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
    console.log(`storage.driver ${cfg.storage.driver}`);
    console.log(`storage.url    ${cfg.storage.url}`);
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

  switch (key) {
    case "name": {
      if (!isValidName(value)) {
        console.error(`Invalid name "${value}" — use letters, digits, and hyphens only.`);
        process.exitCode = 1;
        return;
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
}

function readKey(cfg: Config, key: string): unknown {
  switch (key) {
    case "name":
      return cfg.name;
    case "storage.driver":
      return cfg.storage.driver;
    case "storage.url":
      return cfg.storage.url;
    case "pollIntervalMs":
      return cfg.pollIntervalMs;
    case "logLevel":
      return cfg.logLevel;
    default:
      return undefined;
  }
}
