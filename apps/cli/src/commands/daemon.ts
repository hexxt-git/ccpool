import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AlreadyRunningError,
  daemonPaths,
  isAlive,
  readPid,
  spawnDetached,
  startDaemon,
  type DaemonPaths,
} from "@ccshare/daemon";
import type { Config, LocalState } from "@ccshare/core";
import { ccshareDir } from "../lib/config.js";
import { makeIngestSink } from "../lib/backend.js";
import { loadConfig } from "../lib/config.js";

function pathsFor(cfgConfigDir: string) {
  return daemonPaths(ccshareDir(), cfgConfigDir);
}

// ── quiet, config-taking cores (used by the TUI, which can't print to stdout) ──────

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
    console.error("Not initialized. Run `ccshare init` first.");
    process.exitCode = 1;
    return;
  }
  const configDir = cfg.configDirs[0] ?? process.cwd();

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
}

/** Spawn the foreground loop detached and return. */
export async function runDaemonStart(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) {
    console.error("Not initialized. Run `ccshare init` first.");
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
    console.error("Not initialized. Run `ccshare init` first.");
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
    console.error("Not initialized. Run `ccshare init` first.");
    process.exitCode = 1;
    return;
  }
  const configDir = cfg.configDirs[0] ?? process.cwd();
  const { pidFile, stateFile } = pathsFor(configDir);
  const pid = readPid(pidFile);

  if (pid !== null && isAlive(pid)) {
    console.log(`Daemon running (pid ${pid}).`);
  } else {
    console.log("Daemon not running. Start it with `ccshare daemon start`.");
  }

  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf8")) as LocalState;
      const age = Math.round((Date.now() - Date.parse(state.updatedAt)) / 1000);
      console.log(`Last state update: ${age}s ago (${state.samples.length} caps tracked).`);
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
