import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AlreadyRunningError,
  daemonPaths,
  isAlive,
  readPid,
  spawnDetached,
  startDaemon,
  type DaemonPaths,
} from "@ccpool/daemon";
import type { Config, LocalState } from "@ccpool/core";
import { ccpoolDir } from "../lib/config.js";
import { makeIngestSink } from "../lib/backend.js";
import { loadConfig } from "../lib/config.js";

function pathsFor(cfgConfigDir: string) {
  return daemonPaths(ccpoolDir(), cfgConfigDir);
}

// quiet, config-taking cores (used by the TUI, which cannot print to stdout)

/** Daemon file locations for a config. */
export function daemonPathsFor(cfg: Config): DaemonPaths {
  return pathsFor(cfg.configDirs[0] ?? process.cwd());
}

/** Whether a live daemon owns the pidfile for this config. */
export function isDaemonRunning(cfg: Config): boolean {
  const pid = readPid(daemonPathsFor(cfg).pidFile);
  return pid !== null && isAlive(pid);
}

/** Spawn the detached observer. No console output. */
export function spawnDaemon(cfg: Config): { pid: number } | { already: number } {
  const paths = daemonPathsFor(cfg);
  const existing = readPid(paths.pidFile);
  if (existing !== null && isAlive(existing)) return { already: existing };
  const isDev = import.meta.url.endsWith(".ts") || import.meta.url.endsWith(".tsx");
  const cliEntry = fileURLToPath(new URL(isDev ? "../cli.tsx" : "../cli.js", import.meta.url));
  const args = [...process.execArgv, cliEntry, "daemon", "run"];
  const pid = spawnDetached(process.execPath, args, {
    logFile: paths.logFile,
  });
  return { pid };
}

/**
 * Clear the `authRejected` latch in each config dir's `state.json`.
 *
 * The daemon latches `authRejected` when the server rejects its bearer (§13); it
 * lives in `state.json` until the daemon's next clean write. On a fresh re-init that
 * latch is stale — a new, valid token has just been minted — but the TUI reads
 * `state.json` every 2s and, seeing the stale latch, routes straight back to the
 * re-init screen (stopping the just-spawned daemon before it can clear the latch
 * itself). That loops forever. Clearing the latch here breaks the loop; the fresh
 * daemon's first tick then owns `state.json` as usual.
 */
export function clearAuthRejected(cfg: Config): void {
  const dirs = cfg.configDirs.length ? cfg.configDirs : [process.cwd()];
  for (const dir of dirs) {
    const { stateFile } = pathsFor(dir);
    if (!existsSync(stateFile)) continue;
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf8")) as LocalState;
      if (!state.account?.authRejected) continue;
      state.account.authRejected = false;
      writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
    } catch {
      // best effort — the fresh daemon's next write will clear it anyway
    }
  }
}

/** SIGTERM the running observer. No console output. */
export function stopDaemonProcess(cfg: Config): "stopped" | "not-running" | "error" {
  const { pidFile } = daemonPathsFor(cfg);
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
export function tailDaemonLog(cfg: Config, n = 8): string[] {
  const { logFile } = daemonPathsFor(cfg);
  try {
    return readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

/** Foreground loop — what the detached process runs. Blocks until signalled. */
export async function runDaemonForeground(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) {
    console.error("Not initialized. Run `ccpool init` first.");
    process.exitCode = 1;
    return;
  }
  const configDir = cfg.configDirs[0] ?? process.cwd();

  try {
    await startDaemon({
      // Uninitialized/unreachable backends surface through the sink's bootstrap
      // (logged, retried) rather than blocking here — same failure path as ticks.
      sink: makeIngestSink(cfg),
      paths: pathsFor(configDir),
      configDir,
      name: cfg.name,
      pollIntervalMs: cfg.pollIntervalMs,
      logLevel: cfg.logLevel,
      // re-read the name each tick so `config set name` hand-offs apply live
      resolveName: async () => (await loadConfig())?.name ?? cfg.name,
    });
  } catch (err) {
    // Another daemon already owns the single-instance lock. This is the expected,
    // healthy outcome for a redundant spawn (the TUI re-spawns on a timer, and
    // several may fire before one wins the lock) — exit 0 quietly, don't crash.
    if (err instanceof AlreadyRunningError) {
      console.log(err.message);
      return;
    }
    throw err;
  }
}

/** Spawn the foreground loop detached and return. */
export async function runDaemonStart(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) {
    console.error("Not initialized. Run `ccpool init` first.");
    process.exitCode = 1;
    return;
  }
  const configDir = cfg.configDirs[0] ?? process.cwd();
  const paths = pathsFor(configDir);

  const existing = readPid(paths.pidFile);
  if (existing !== null && isAlive(existing)) {
    console.log(`Daemon already running (pid ${existing}).`);
    return;
  }

  const isDev = import.meta.url.endsWith(".ts") || import.meta.url.endsWith(".tsx");
  const cliEntry = fileURLToPath(new URL(isDev ? "../cli.tsx" : "../cli.js", import.meta.url));
  const args = [...process.execArgv, cliEntry, "daemon", "run"];
  const pid = spawnDetached(process.execPath, args, {
    logFile: paths.logFile,
  });
  console.log(`Daemon started (pid ${pid}). Logs: ${paths.logFile}`);
}

export async function runDaemonStop(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) {
    console.error("Not initialized. Run `ccpool init` first.");
    process.exitCode = 1;
    return;
  }
  const configDir = cfg.configDirs[0] ?? process.cwd();
  const { pidFile } = pathsFor(configDir);
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
  const cfg = await loadConfig();
  if (!cfg) {
    console.error("Not initialized. Run `ccpool init` first.");
    process.exitCode = 1;
    return;
  }
  const configDir = cfg.configDirs[0] ?? process.cwd();
  const { pidFile, stateFile } = pathsFor(configDir);
  const pid = readPid(pidFile);

  if (pid !== null && isAlive(pid)) {
    console.log(`Daemon running (pid ${pid}).`);
  } else {
    console.log("Daemon not running. Start it with `ccpool daemon start`.");
  }

  if (existsSync(stateFile)) {
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
}

export async function runDaemonRestart(): Promise<void> {
  await runDaemonStop();
  // give the previous instance a moment to release the lock
  await new Promise((r) => setTimeout(r, 500));
  await runDaemonStart();
}

export { AlreadyRunningError };
