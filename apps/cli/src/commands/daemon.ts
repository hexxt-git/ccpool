import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import {
  AlreadyRunningError,
  daemonPaths,
  isAlive,
  readPid,
  spawnDetached,
  startDaemon,
  type AccountProfile,
} from "@ccpool/daemon";
import { resolveConfigDir, type Config, type LocalState } from "@ccpool/core";
import {
  DEFAULT_POLL_INTERVAL_MS,
  activeAccountId,
  ccpoolDir,
  daemonControlPaths,
  loadConfig,
  loadProfile,
  stateFilePath,
} from "../lib/config.js";
import { makeIngestSink } from "../lib/backend.js";

/**
 * Best-effort: stop a pre-multi-account daemon still running under the legacy
 * per-config-dir pidfile (`daemon-<hash>.pid`). The new machine-wide daemon uses
 * a different pidfile, so without this an upgrade would orphan the old observer
 * (harmless — idempotent ingest, same account — but a wasteful second process).
 */
function sweepLegacyDaemon(): void {
  try {
    const { pidFile } = daemonPaths(ccpoolDir(), resolveConfigDir());
    const pid = readPid(pidFile);
    if (pid !== null && pid !== process.pid && isAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    rmSync(pidFile, { force: true });
  } catch {
    // no legacy daemon — nothing to sweep
  }
}

/**
 * The CLI entry to spawn for the detached daemon.
 *
 * In dev this module is `src/commands/daemon.ts`, so the entry sits one dir up
 * at `src/cli.tsx`. In the published build tsup bundles everything flat into a
 * single `dist/cli.js` — this module *is* the entry — so we must spawn the
 * running file itself, not `../cli.js` (which would point one level above dist,
 * where nothing exists).
 */
function cliEntryPath(): string {
  const isDev = import.meta.url.endsWith(".ts") || import.meta.url.endsWith(".tsx");
  return isDev
    ? fileURLToPath(new URL("../cli.tsx", import.meta.url))
    : fileURLToPath(import.meta.url);
}

/** Whether the single machine-wide daemon is live. */
export function isDaemonRunning(): boolean {
  const pid = readPid(daemonControlPaths().pidFile);
  return pid !== null && isAlive(pid);
}

/** Spawn the detached observer. No console output. Idempotent (one per machine). */
export function spawnDaemon(): { pid: number } | { already: number } {
  const { pidFile, logFile } = daemonControlPaths();
  const existing = readPid(pidFile);
  if (existing !== null && isAlive(existing)) return { already: existing };
  sweepLegacyDaemon();
  const cliEntry = cliEntryPath();
  const args = [...process.execArgv, cliEntry, "daemon", "run"];
  const pid = spawnDetached(process.execPath, args, { logFile });
  return { pid };
}

/**
 * Clear the `authRejected` latch in a profile's `state.json`.
 *
 * The daemon latches `authRejected` when the server rejects its bearer (the "server" section); it
 * lives in `state.json` until the daemon's next clean write. On a fresh re-init that
 * latch is stale — a new, valid token has just been minted — but the TUI reads
 * `state.json` every 2s and, seeing the stale latch, routes straight back to the
 * re-init screen (stopping the just-spawned daemon before it can clear the latch
 * itself). That loops forever. Clearing the latch here breaks the loop; the fresh
 * daemon's first tick then owns `state.json` as usual.
 */
export function clearAuthRejected(cfg: Config): void {
  if (!cfg.accountId) return;
  const stateFile = stateFilePath(cfg.accountId);
  if (!existsSync(stateFile)) return;
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as LocalState;
    if (!state.account?.authRejected) return;
    state.account.authRejected = false;
    writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    // best effort — the fresh daemon's next write will clear it anyway
  }
}

/** SIGTERM the running observer. No console output. */
export function stopDaemonProcess(): "stopped" | "not-running" | "error" {
  const { pidFile } = daemonControlPaths();
  const pid = readPid(pidFile);
  if (pid === null || !isAlive(pid)) return "not-running";
  try {
    process.kill(pid, "SIGTERM");
    return "stopped";
  } catch {
    return "error";
  }
}

/** Last `n` non-empty lines of the daemon log (newest last), or [] if none yet. */
export function tailDaemonLog(n = 8): string[] {
  const { logFile } = daemonControlPaths();
  try {
    return readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

/**
 * Compose the runtime for one account, or null when it has no ccpool profile
 * (the live account isn't pooled — the daemon then goes dormant for it). The
 * name is re-read each tick so a `config set name` hand-off applies live.
 */
async function profileFor(accountId: string): Promise<AccountProfile | null> {
  const cfg = await loadProfile(accountId);
  if (!cfg) return null;
  return {
    accountId,
    sink: makeIngestSink(cfg),
    stateFile: stateFilePath(accountId),
    name: cfg.name,
    resolveName: async () => (await loadProfile(accountId))?.name ?? cfg.name,
  };
}

/** Foreground loop — what the detached process runs. Blocks until signalled. */
export async function runDaemonForeground(): Promise<void> {
  // Manager-level knobs come from whichever profile is active now (they're the
  // same across profiles); defaults keep the daemon running even while dormant.
  const active = await loadConfig();
  const { pidFile } = daemonControlPaths();

  try {
    await startDaemon({
      configDir: resolveConfigDir(),
      loadProfile: profileFor,
      pidFile,
      pollIntervalMs: active?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      logLevel: active?.logLevel,
    });
  } catch (err) {
    // Another daemon already owns the single-instance lock. Expected for a
    // redundant spawn (the TUI re-spawns on a timer) — exit 0 quietly.
    if (err instanceof AlreadyRunningError) {
      console.log(err.message);
      return;
    }
    throw err;
  }
}

/** Spawn the foreground loop detached and return. */
export async function runDaemonStart(): Promise<void> {
  const { pidFile, logFile } = daemonControlPaths();
  const existing = readPid(pidFile);
  if (existing !== null && isAlive(existing)) {
    console.log(`Daemon already running (pid ${existing}).`);
    return;
  }
  sweepLegacyDaemon();
  const cliEntry = cliEntryPath();
  const args = [...process.execArgv, cliEntry, "daemon", "run"];
  const pid = spawnDetached(process.execPath, args, { logFile });
  console.log(`Daemon started (pid ${pid}). Logs: ${logFile}`);
}

export async function runDaemonStop(): Promise<void> {
  const { pidFile } = daemonControlPaths();
  const pid = readPid(pidFile);
  if (pid === null || !isAlive(pid)) {
    console.log("Daemon is not running.");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to daemon (pid ${pid}).`);
  } catch (err) {
    console.error(`Could not stop daemon: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

export async function runDaemonStatus(): Promise<void> {
  const { pidFile } = daemonControlPaths();
  const pid = readPid(pidFile);

  if (pid !== null && isAlive(pid)) {
    console.log(`Daemon running (pid ${pid}).`);
  } else {
    console.log("Daemon not running. Start it with `ccpool daemon start`.");
  }

  const accountId = await activeAccountId();
  if (!accountId) {
    console.log("No live Claude account — nothing to observe.");
    return;
  }
  const stateFile = stateFilePath(accountId);
  if (!existsSync(stateFile)) {
    console.log("This Claude account has no ccpool profile — run `ccpool init` to join.");
    return;
  }
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as LocalState;
    const age = Math.round((Date.now() - Date.parse(state.updatedAt)) / 1000);
    console.log(`Last state update: ${age}s ago (${state.samples.length} caps tracked).`);
    // The clean-sync heartbeat: a failed poll/ingest bumps `updatedAt` but not
    // this, so a growing gap here is the signal that syncs are silently failing.
    if (state.lastSyncAt) {
      const syncAge = Math.round((Date.now() - Date.parse(state.lastSyncAt)) / 1000);
      console.log(`Last full sync: ${syncAge}s ago.`);
    } else {
      console.log("Last full sync: never (no clean poll + ingest yet).");
    }
    if (state.account.authRejected) {
      console.log("Auth rejected by the server — run `ccpool init` to re-authenticate.");
    }
    if (state.account.tokenExpired) {
      console.log("Token expired — waiting for Claude Code to refresh auth.");
    }
  } catch {
    console.log("state.json present but unreadable.");
  }
}

export async function runDaemonRestart(): Promise<void> {
  await runDaemonStop();
  // give the previous instance a moment to release the lock
  await new Promise((r) => setTimeout(r, 500));
  await runDaemonStart();
}

export { AlreadyRunningError };
