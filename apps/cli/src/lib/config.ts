import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isValidName, type Config } from "@ccpool/core";

/** Everything ccpool keeps for this machine lives under here. */
export function ccpoolDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CCPOOL_DIR?.trim() || join(homedir(), ".ccpool");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(ccpoolDir(env), "config.json");
}

/**
 * The server bearer token is kept apart from the committed config (the "two-password trust model" section), in its
 * own 0600 file — never in config.json.
 */
function tokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(ccpoolDir(env), "token");
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
  // The secret lives in its own 0600 file, never in config.json.
  const token = await readToken(env);
  if (token && cfg.server) cfg.server.token = token;
  return cfg;
}

export async function saveConfig(cfg: Config, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dir = ccpoolDir(env);
  await mkdir(dir, { recursive: true });

  // Strip the bearer token before the config touches disk.
  const onDisk: Config = { ...cfg };
  let token: string | undefined;
  if (cfg.server) {
    const { token: t, ...server } = cfg.server;
    onDisk.server = server;
    token = t;
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

/**
 * Log out: delete the 0600 bearer file so the config is no longer "configured"
 * (the "server" section). Called when the server rejects the token (revoked/rotated) — the user is
 * routed back to `init` to re-authenticate. Idempotent.
 */
export async function logout(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await rm(tokenPath(env), { force: true });
}

async function writeToken(token: string, env: NodeJS.ProcessEnv): Promise<void> {
  const p = tokenPath(env);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, token, "utf8");
  await chmod(p, 0o600);
}

/** A config for this machine: it talks to the ccpool server over HTTP. */
export function newConfig(opts: {
  serverUrl: string;
  token: string;
  name: string;
  configDirs: string[];
}): Config {
  if (!isValidName(opts.name)) {
    throw new Error(`invalid name "${opts.name}" — use letters, digits, and hyphens only`);
  }
  return {
    server: { url: opts.serverUrl, token: opts.token },
    name: opts.name,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    configDirs: opts.configDirs,
    logLevel: "debug",
  };
}
