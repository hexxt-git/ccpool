import { existsSync, readFileSync } from "node:fs";
import {
  attributeShares,
  CAP_WINDOW_MS,
  isTokenExpired,
  pollUsage,
  readCredentials,
  UsageAuthError,
  type Budget,
  type Config,
  type LocalState,
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
  budgets: Budget[]; // Phase 6
  source: ViewSource;
  /** DB unreachable — showing last-known numbers. */
  stale: boolean;
  daemonRunning: boolean;
  tokenExpired: boolean;
  updatedAt: string | null;
}

function configDirOf(cfg: Config): string {
  return cfg.configDirs[0] ?? process.cwd();
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

  let dbSamples: UsageSample[] = [];
  let shares: UserShare[] = [];
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
    budgets,
    source,
    stale,
    daemonRunning,
    tokenExpired: state?.account.tokenExpired ?? false,
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
