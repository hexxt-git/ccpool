import { existsSync, readFileSync } from "node:fs";
import {
  ApiRequestError,
  isTokenExpired,
  pollUsage,
  readCredentials,
  resolveAccount,
  UsageAuthError,
  type Config,
  type LocalState,
  type MemberSummary,
  type UsageSample,
  type User,
  type UserShare,
  type ViewSource,
} from "@ccshare/core";
import { daemonPaths, isAlive, readPid } from "@ccshare/daemon";
import { ccshareDir } from "./config.js";

/** Where the numbers on screen came from. */
export type ViewOrigin = "db" | "state" | "live" | "none";

/** The single model `status` and `tui` both render from (§10). */
export interface ViewModel {
  samples: UsageSample[];
  shares: UserShare[]; // per-user rows (Phase 5); empty until then
  members: MemberSummary[]; // per-name measured activity (tokens, last seen)
  users: User[]; // the roster from the shared ledger
  source: ViewOrigin;
  /** Backend unreachable — showing last-known numbers. */
  stale: boolean;
  /** The server rejected our bearer (unknown/revoked token) — we're logged out. */
  loggedOut: boolean;
  daemonRunning: boolean;
  tokenExpired: boolean;
  /** This machine's Claude account differs from the ledger's — daemon halted writes (§1.5). */
  accountConflict: boolean;
  /** The observed account's id/email (never the person), from local state. */
  account: string | null;
  /** When this snapshot was last written by the daemon (every tick). */
  updatedAt: string | null;
  /**
   * When the account picture was last *fully* refreshed — a clean poll + landed
   * ingest. Drives "synced X ago" so it grows on failure instead of the per-tick
   * `updatedAt` masking a broken poll (429) or ingest (401/unreachable).
   */
  syncedAt: string | null;
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
 * Assemble the live view: prefer the shared backend (everyone-included), fall
 * back to the local `state.json` (instant, no network), and finally to a
 * one-shot live poll so there's always something to show before the daemon's
 * first write. The heavy work lives behind `source` — a 2s refresh costs a
 * bodyless 304 from the server when nothing changed.
 */
export async function gatherView(cfg: Config, source: ViewSource): Promise<ViewModel> {
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
  let users: User[] = [];
  let stale = false;
  let loggedOut = false;
  try {
    const view = await source.fetchView();
    dbSamples = view.samples;
    shares = view.shares;
    members = view.members;
    users = view.users;
  } catch (e) {
    // A 401 isn't "unreachable" — the server reached us and rejected the bearer
    // (the token is unknown or was revoked, e.g. the ledger was reset). That's a
    // logged-out state, not a network problem, and the views must say so.
    if (e instanceof ApiRequestError && e.status === 401) loggedOut = true;
    else stale = true;
  }

  // The daemon's ingest can be auth-rejected even while reads still succeed (a
  // revoked/rotated bearer): it latches `authRejected` into state.json. Treat that
  // as logged-out too, so the TUI routes to re-init instead of silently spinning.
  if (state?.account.authRejected) loggedOut = true;

  let samples = dbSamples;
  let origin: ViewOrigin = dbSamples.length > 0 ? "db" : "none";

  if (samples.length === 0 && state?.samples.length) {
    samples = state.samples;
    origin = "state";
  }

  // last resort: poll the endpoint directly so the view is never empty
  if (samples.length === 0) {
    const live = await tryLivePoll(configDir);
    if (live) {
      samples = live;
      origin = "live";
    }
  }

  return {
    samples,
    shares,
    members,
    users,
    source: origin,
    stale,
    loggedOut,
    daemonRunning,
    tokenExpired: state?.account.tokenExpired ?? false,
    accountConflict: state?.account.conflict ?? false,
    account,
    updatedAt: state?.updatedAt ?? null,
    syncedAt: state?.lastSyncAt ?? null,
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
