import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AlreadyRunningError,
  daemonPaths,
  isAlive,
  readPid,
  spawnDetached,
  startDaemon,
} from "@ccshare/daemon";
import type { LocalState } from "@ccshare/core";
import { ccshareDir } from "../lib/config.js";
import { requireInit } from "../lib/guard.js";
import { loadConfig } from "../lib/config.js";

function pathsFor(cfgConfigDir: string) {
  return daemonPaths(ccshareDir(), cfgConfigDir);
}

/** Foreground loop — what the detached process runs. Blocks until signalled. */
export async function runDaemonForeground(): Promise<void> {
  const ctx = await requireInit();
  if (!ctx) return;
  const { cfg, storage } = ctx;
  const configDir = cfg.configDirs[0] ?? process.cwd();

  await startDaemon({
    storage,
    paths: pathsFor(configDir),
    configDir,
    name: cfg.name,
    pollIntervalMs: cfg.pollIntervalMs,
    logLevel: cfg.logLevel,
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

  const cliEntry = fileURLToPath(new URL("../cli.js", import.meta.url));
  const pid = spawnDetached(process.execPath, [cliEntry, "daemon", "run"], {
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
