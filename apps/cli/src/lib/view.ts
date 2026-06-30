import { existsSync, readFileSync } from "node:fs";
import {
  attributeShares,
  CAP_WINDOW_MS,
  isTokenExpired,
  pollUsage,
  readCredentials,
  resolveAccount,
  summarizeMembers,
  UsageAuthError,
  type Budget,
  type Config,
  type LocalState,
  type MemberSummary,
  type Storage,
  type UsageSample,
  type UserShare,
} from "@ccshare/core";
import { daemonPaths, isAlive, readPid } from "@ccshare/daemon";
import { ccshareDir } from "./config.js";

export type ViewSource = "db" | "state" | "live" | "none";

/** The single model `status` and `tui` both render from (§10). */
export interface ViewModel {
  samples: UsageSample[];
  shares: UserShare[]; // per-user rows (Phase 5); empty until then
  members: MemberSummary[]; // per-name measured activity (tokens, last seen)
  budgets: Budget[]; // Phase 6
  source: ViewSource;
  /** DB unreachable — showing last-known numbers. */
  stale: boolean;
  daemonRunning: boolean;
  tokenExpired: boolean;
  /** The observed account's id/email (never the person), from local state. */
  account: string | null;
  updatedAt: string | null;
}

function configDirOf(cfg: Config): string {
  return cfg.configDirs[0] ?? process.cwd();
}

/**
 * The account email lives in `~/.claude.json`, which barely changes. The TUI calls
 * gatherView every 2s, so cache the parsed result and only re-read once a minute.
 */
const ACCOUNT_TTL_MS = 60_000;
let emailCache: { dir: string; email: string | null; at: number } | null = null;
async function resolveEmail(configDir: string): Promise<string | null> {
  const now = Date.now();
  if (emailCache && emailCache.dir === configDir && now - emailCache.at < ACCOUNT_TTL_MS) {
    return emailCache.email;
  }
  const email = (await resolveAccount(configDir))?.email ?? null;
  emailCache = { dir: configDir, email, at: now };
  return email;
}

function readState(stateFile: string): LocalState | null {
  if (!existsSync(stateFile)) return null;
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")) as LocalState;
  } catch {
    return null;
  }
}

/**
 * Assemble the live view: prefer the shared DB (everyone-included), fall back to
 * the local `state.json` (instant, no network), and finally to a one-shot live
 * poll so there's always something to show before the daemon's first write.
 */
export async function gatherView(cfg: Config, storage: Storage): Promise<ViewModel> {
  const configDir = configDirOf(cfg);
  const { stateFile, pidFile } = daemonPaths(ccshareDir(), configDir);

  const state = readState(stateFile);
  const pid = readPid(pidFile);
  const daemonRunning = pid !== null && isAlive(pid);

  // Prefer the human-readable email from the Claude config (cached, ~1/min); fall
  // back to the account uuid recorded in local state (never the ccshare person).
  const account = (await resolveEmail(configDir)) ?? state?.account.id ?? null;

  let dbSamples: UsageSample[] = [];
  let shares: UserShare[] = [];
  let members: MemberSummary[] = [];
  let budgets: Budget[] = [];
  let stale = false;
  try {
    const now = Date.now();
    // pull enough history to cover the widest window, then attribute deltas
    const since = new Date(now - CAP_WINDOW_MS.seven_day).toISOString();
    const [latest, samplesSince, messagesSince, resetsSince, b] = await Promise.all([
      storage.getLatestSamples(),
      storage.getUsageSamplesSince(since),
      storage.getMessageUsageSince(since),
      storage.getResetsSince(since),
      storage.getBudgets(),
    ]);
    dbSamples = latest;
    budgets = b;
    shares = attributeShares(samplesSince, messagesSince, now, resetsSince);
    members = summarizeMembers(messagesSince);
  } catch {
    stale = true;
  }

  let samples = dbSamples;
  let source: ViewSource = dbSamples.length > 0 ? "db" : "none";

  if (samples.length === 0 && state?.samples.length) {
    samples = state.samples;
    source = "state";
  }

  // last resort: poll the endpoint directly so the view is never empty
  if (samples.length === 0) {
    const live = await tryLivePoll(configDir);
    if (live) {
      samples = live;
      source = "live";
    }
  }

  return {
    samples,
    shares,
    members,
    budgets,
    source,
    stale,
    daemonRunning,
    tokenExpired: state?.account.tokenExpired ?? false,
    account,
    updatedAt: state?.updatedAt ?? null,
  };
}

async function tryLivePoll(configDir: string): Promise<UsageSample[] | null> {
  const creds = await readCredentials(configDir);
  if (!creds || isTokenExpired(creds)) return null;
  try {
    return await pollUsage(creds.accessToken);
  } catch (err) {
    if (err instanceof UsageAuthError) return null;
    return null;
  }
}
