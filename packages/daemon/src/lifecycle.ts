import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Per-account file locations, keyed by a hash of the Claude config dir (§8). */
export interface DaemonPaths {
  pidFile: string;
  stateFile: string;
  logFile: string;
}

export function daemonPaths(ccshareDir: string, configDir: string): DaemonPaths {
  const h = createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  return {
    pidFile: join(ccshareDir, `daemon-${h}.pid`),
    stateFile: join(ccshareDir, `state-${h}.json`),
    logFile: join(ccshareDir, "logs", `daemon-${h}.log`),
  };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't kill
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readPid(pidFile: string): number | null {
  try {
    const n = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

export class AlreadyRunningError extends Error {
  constructor(public readonly pid: number) {
    super(`daemon already running (pid ${pid})`);
    this.name = "AlreadyRunningError";
  }
}

/** Single-instance lock: refuse if a live daemon already holds the pidfile. */
export function acquireLock(pidFile: string): void {
  const existing = readPid(pidFile);
  if (existing !== null && isAlive(existing)) {
    throw new AlreadyRunningError(existing);
  }
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(process.pid), "utf8");
}

export function releaseLock(pidFile: string): void {
  try {
    // Only remove if it's still ours, to avoid stomping a restart.
    if (readPid(pidFile) === process.pid) unlinkSync(pidFile);
  } catch {
    // already gone
  }
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Minimal leveled logger. stdout is redirected to the log file when detached. */
export function makeLogger(level: LogLevel = "info") {
  const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const log = (l: LogLevel, msg: string) => {
    if (order[l] < order[level]) return;
    process.stdout.write(`${new Date().toISOString()} ${l.toUpperCase()} ${msg}\n`);
  };
  return {
    debug: (m: string) => log("debug", m),
    info: (m: string) => log("info", m),
    warn: (m: string) => log("warn", m),
    error: (m: string) => log("error", m),
  };
}

export type Logger = ReturnType<typeof makeLogger>;
