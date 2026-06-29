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

/** The DB token is kept apart from the committed config (§12). */
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
  // Token lives in its own 0600 file, never in config.json.
  const token = await readToken(env);
  if (token) cfg.storage.token = token;
  return cfg;
}

export async function saveConfig(cfg: Config, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dir = ccshareDir(env);
  await mkdir(dir, { recursive: true });

  const { token, ...storage } = cfg.storage;
  const onDisk: Config = { ...cfg, storage };
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
    storage: { driver: opts.driver, url: opts.url, token: opts.token },
    name: opts.name,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    configDirs: opts.configDirs,
    logLevel: "info",
  };
}
