import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
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

/**
 * Single-instance lock — the one guarantee that stops a fleet of daemons piling up.
 *
 * The pidfile is created with `openSync(…, "wx")`, i.e. `O_CREAT | O_EXCL`: the
 * kernel creates the file **only if it does not already exist, in one indivisible
 * step**. This is what makes duplicates impossible. The previous implementation
 * read the pid, checked liveness, then wrote — three separate steps, so two daemons
 * booting inside that window (tsx takes a second or two to start, and several TUIs /
 * dev servers each spawn one) both saw "no live owner" and both proceeded. With an
 * atomic create, exactly one racer wins the create; every other gets `EEXIST`, sees
 * the live owner, and refuses.
 *
 * A stale lock (owner crashed with SIGKILL, so `releaseLock` never ran, or a
 * half-written file) is reclaimed: if the recorded pid is dead we clear it and retry
 * the same atomic create. We re-read immediately before unlinking and only remove a
 * file that still holds the *same dead* pid, so we can't delete a fresh lock a
 * racing starter just created. Bounded retries; a live owner always wins.
 */
export function acquireLock(pidFile: string): void {
  mkdirSync(dirname(pidFile), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = openSync(pidFile, "wx"); // O_CREAT | O_EXCL — atomic create-or-fail
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return; // we hold the lock
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = readPid(pidFile);
      if (owner !== null && isAlive(owner)) {
        throw new AlreadyRunningError(owner); // a live daemon already owns it
      }
      // Stale (dead owner) or empty (crash mid-write): reclaim it and retry, but
      // only if it hasn't just been re-created by another starter.
      try {
        if (readPid(pidFile) === owner) unlinkSync(pidFile);
      } catch {
        // already removed/replaced by another starter — the retry re-checks
      }
    }
  }
  // Lost the reclaim race five times over — treat the incumbent as the owner.
  throw new AlreadyRunningError(readPid(pidFile) ?? -1);
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
