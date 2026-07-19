import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isValidName, resolveAccount, resolveConfigDir, type Config } from "@ccpool/core";

/** Everything ccpool keeps for this machine lives under here. */
export function ccpoolDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CCPOOL_DIR?.trim() || join(homedir(), ".ccpool");
}

/**
 * One machine can be logged into ccpool under several Claude accounts at once —
 * a personal Pro and a shared/pooled Pro, say. Each account gets its own profile
 * (config + bearer + state) under `~/.ccpool/accounts/<accountUuid>/`; the *live*
 * Claude account (whatever `resolveAccount` reports for the observed config dir)
 * selects which profile is active. Switching Claude accounts leaves the inactive
 * profile untouched, waiting for a switch back.
 */
function accountsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(ccpoolDir(env), "accounts");
}

/** The per-account profile directory. `accountId` is a Claude `accountUuid`. */
export function profileDir(accountId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(accountsDir(env), accountId);
}

export function configPath(accountId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(profileDir(accountId, env), "config.json");
}

/**
 * The server bearer token is kept apart from the committed config (the "two-password trust model" section), in its
 * own 0600 file — never in config.json.
 */
function tokenPath(accountId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(profileDir(accountId, env), "token");
}

/** Where the daemon writes this account's `state.json` snapshot. */
export function stateFilePath(accountId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(profileDir(accountId, env), "state.json");
}

/** The single machine-wide daemon (it follows whichever account is live). */
export function daemonControlPaths(env: NodeJS.ProcessEnv = process.env): {
  pidFile: string;
  logFile: string;
} {
  const dir = ccpoolDir(env);
  return { pidFile: join(dir, "daemon.pid"), logFile: join(dir, "logs", "daemon.log") };
}

// The pre-multi-account single-profile layout, kept only so an upgrade can migrate.
function legacyConfigPath(env: NodeJS.ProcessEnv): string {
  return join(ccpoolDir(env), "config.json");
}
function legacyTokenPath(env: NodeJS.ProcessEnv): string {
  return join(ccpoolDir(env), "token");
}

export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * The Claude account that is live right now (the observed config dir's onboarded
 * `oauthAccount`). Only a *hydrated* account has a real `accountUuid` to key a
 * profile by; an un-onboarded machine has no active profile.
 */
export async function activeAccountId(
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const acct = await resolveAccount(resolveConfigDir(env), env);
  return acct?.hydrated ? acct.id : null;
}

/** Every account this machine has a profile for. */
export async function listProfileIds(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  try {
    const entries = await readdir(accountsDir(env), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function readToken(accountId: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const t = (await readFile(tokenPath(accountId, env), "utf8")).trim();
    return t.length > 0 ? t : undefined;
  } catch {
    return undefined;
  }
}

async function writeToken(accountId: string, token: string, env: NodeJS.ProcessEnv): Promise<void> {
  const p = tokenPath(accountId, env);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, token, "utf8");
  await chmod(p, 0o600);
}

/** Load one account's profile (config + its 0600 bearer), or null if absent. */
export async function loadProfile(
  accountId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<Config | null> {
  let raw: string;
  try {
    raw = await readFile(configPath(accountId, env), "utf8");
  } catch {
    return null;
  }
  const cfg = JSON.parse(raw) as Config;
  cfg.accountId = accountId; // the directory is authoritative
  const token = await readToken(accountId, env);
  if (token && cfg.server) cfg.server.token = token;
  return cfg;
}

/**
 * Migrate a pre-multi-account `~/.ccpool/{config.json,token}` into the live
 * account's profile dir. We file it under whoever is live *now* (the switch-was-
 * before-upgrade edge is accepted); if the profile already exists we don't
 * clobber it, we just drop the legacy files. Best-effort and idempotent.
 */
async function migrateLegacy(env: NodeJS.ProcessEnv): Promise<void> {
  let legacy: string;
  try {
    legacy = await readFile(legacyConfigPath(env), "utf8");
  } catch {
    return; // no legacy profile — nothing to migrate
  }
  const accountId = await activeAccountId(env);
  if (!accountId) return; // can't key it without a live account; try again next time

  try {
    if (!(await loadProfile(accountId, env))) {
      await mkdir(profileDir(accountId, env), { recursive: true });
      await writeFile(configPath(accountId, env), legacy, "utf8");
      const token = (await readFile(legacyTokenPath(env), "utf8").catch(() => "")).trim();
      if (token) await writeToken(accountId, token, env);
    }
    await rm(legacyConfigPath(env), { force: true });
    await rm(legacyTokenPath(env), { force: true });
  } catch {
    // leave the legacy files in place; a later call retries the migration
  }
}

/**
 * The active profile: migrate any legacy layout, resolve the live Claude account,
 * and load its profile. Returns null when the machine isn't onboarded or the live
 * account has no ccpool profile (the personal-Pro case) — callers then behave
 * exactly as if uninitialized and route to `init`.
 */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config | null> {
  await migrateLegacy(env);
  const accountId = await activeAccountId(env);
  if (!accountId) return null;
  return loadProfile(accountId, env);
}

/**
 * Persist a profile. The account it belongs to comes from the config itself
 * (`accountId`), falling back to the live account — a config is only ever saved
 * for the account that's live while `init`/`config set` runs.
 */
export async function saveConfig(cfg: Config, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const accountId = cfg.accountId ?? (await activeAccountId(env));
  if (!accountId) {
    throw new Error("no onboarded Claude account — cannot save a ccpool profile");
  }
  await mkdir(profileDir(accountId, env), { recursive: true });

  // Strip the bearer token before the config touches disk.
  const onDisk: Config = { ...cfg, accountId };
  let token: string | undefined;
  if (cfg.server) {
    const { token: t, ...server } = cfg.server;
    onDisk.server = server;
    token = t;
  }
  await writeFile(configPath(accountId, env), JSON.stringify(onDisk, null, 2) + "\n", "utf8");

  if (token) await writeToken(accountId, token, env);
}

/**
 * Log out: delete the active account's 0600 bearer so its profile is no longer
 * "configured". Called when the server rejects the token (revoked/rotated) — the
 * user is routed back to `init` to re-authenticate. Idempotent.
 */
export async function logout(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const accountId = await activeAccountId(env);
  if (!accountId) return;
  await rm(tokenPath(accountId, env), { force: true });
}

/** A config for this machine: it talks to the ccpool server over HTTP. */
export function newConfig(opts: {
  serverUrl: string;
  token: string;
  name: string;
  accountId: string;
  configDirs: string[];
}): Config {
  if (!isValidName(opts.name)) {
    throw new Error(`invalid name "${opts.name}" — use letters, digits, and hyphens only`);
  }
  return {
    server: { url: opts.serverUrl, token: opts.token },
    name: opts.name,
    accountId: opts.accountId,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    configDirs: opts.configDirs,
    logLevel: "debug",
  };
}
