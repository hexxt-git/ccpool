import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isValidName, type Config, type StorageDriver } from "@ccshare/core";

/** Everything ccshare keeps for this machine lives under here. */
export function ccshareDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CCSHARE_DIR?.trim() || join(homedir(), ".ccshare");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(ccshareDir(env), "config.json");
}

/**
 * The secret is kept apart from the committed config (§12). In selfhost mode
 * it's the DB auth token; in shared mode it's the server bearer token — the
 * config's `mode` disambiguates which one this file holds.
 */
function tokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(ccshareDir(env), "token");
}

export const DEFAULT_POLL_INTERVAL_MS = 60_000;

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config | null> {
  let raw: string;
  try {
    raw = await readFile(configPath(env), "utf8");
  } catch {
    return null;
  }
  const cfg = JSON.parse(raw) as Config;
  cfg.mode ??= "selfhost"; // configs written before the mode existed
  // The secret lives in its own 0600 file, never in config.json.
  const token = await readToken(env);
  if (token) {
    if (cfg.mode === "shared" && cfg.server) cfg.server.token = token;
    else if (cfg.storage) cfg.storage.token = token;
  }
  return cfg;
}

export async function saveConfig(cfg: Config, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dir = ccshareDir(env);
  await mkdir(dir, { recursive: true });

  // Strip both possible secrets before the config touches disk.
  const onDisk: Config = { ...cfg };
  let token: string | undefined;
  if (cfg.storage) {
    const { token: t, ...storage } = cfg.storage;
    onDisk.storage = storage;
    token ??= t;
  }
  if (cfg.server) {
    const { token: t, ...server } = cfg.server;
    onDisk.server = server;
    token ??= t;
  }
  await writeFile(configPath(env), JSON.stringify(onDisk, null, 2) + "\n", "utf8");

  if (token) await writeToken(token, env);
}

async function readToken(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const t = (await readFile(tokenPath(env), "utf8")).trim();
    return t.length > 0 ? t : undefined;
  } catch {
    return undefined;
  }
}

async function writeToken(token: string, env: NodeJS.ProcessEnv): Promise<void> {
  const p = tokenPath(env);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, token, "utf8");
  await chmod(p, 0o600);
}

/** A selfhost config: this machine talks to the storage adapter directly. */
export function newConfig(opts: {
  driver: StorageDriver;
  url: string;
  token?: string;
  name: string;
  configDirs: string[];
}): Config {
  if (!isValidName(opts.name)) {
    throw new Error(`invalid name "${opts.name}" — use letters, digits, and hyphens only`);
  }
  return {
    mode: "selfhost",
    storage: { driver: opts.driver, url: opts.url, token: opts.token },
    name: opts.name,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    configDirs: opts.configDirs,
    logLevel: "info",
  };
}

/** A shared-hosting config: this machine talks to the ccshare server. */
export function newSharedConfig(opts: {
  serverUrl: string;
  token: string;
  name: string;
  configDirs: string[];
}): Config {
  if (!isValidName(opts.name)) {
    throw new Error(`invalid name "${opts.name}" — use letters, digits, and hyphens only`);
  }
  return {
    mode: "shared",
    server: { url: opts.serverUrl, token: opts.token },
    name: opts.name,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    configDirs: opts.configDirs,
    logLevel: "info",
  };
}
