import {
  atomicWriteJson,
  buildLocalState,
  detectResets,
  isTokenExpired,
  pollUsage,
  readCredentials,
  resolveAccount,
  UsageAuthError,
  type Storage,
  type UsageSample,
} from "@ccshare/core";
import {
  acquireLock,
  makeLogger,
  releaseLock,
  type DaemonPaths,
  type Logger,
  type LogLevel,
} from "./lifecycle.js";

export interface DaemonDeps {
  storage: Storage;
  paths: DaemonPaths;
  /** The Claude config dir this daemon observes. */
  configDir: string;
  /** Active user name (used for attribution in Phase 5). */
  name: string;
  pollIntervalMs: number;
  logLevel?: LogLevel;
  logger?: Logger;
  // injectable seams for tests
  now?: () => number;
  fetchImpl?: typeof fetch;
  version?: string;
}

const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * The long-running observer (no IPC). Each tick reads the token, polls the tank,
 * records samples + resets to the shared DB, and writes the local `state.json`.
 * Old transcript history is never backfilled — JSONL ingest (Phase 5) baselines
 * at EOF on start.
 */
export class Daemon {
  private prev: UsageSample[] = [];
  private readonly startedAt: string;
  private stopped = false;
  private wake: (() => void) | null = null;
  private failures = 0;
  private readonly log: Logger;

  constructor(private readonly deps: DaemonDeps) {
    this.log = deps.logger ?? makeLogger(deps.logLevel ?? "info");
    this.startedAt = new Date(this.nowMs()).toISOString();
  }

  private nowMs(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** One observation cycle. Throws only on unexpected (network) errors. */
  async tick(): Promise<void> {
    const { storage, configDir, paths } = this.deps;
    const nowIso = new Date(this.nowMs()).toISOString();

    const account = await resolveAccount(configDir);
    const creds = await readCredentials(configDir);

    let tokenExpired = false;
    let samples = this.prev;

    if (!creds || isTokenExpired(creds, this.nowMs())) {
      // Skip the poll; Claude Code refreshes on its next run (§8). Not an error.
      tokenExpired = true;
      this.log.debug("token missing/expired — skipping poll");
    } else {
      try {
        const fresh = await pollUsage(creds.accessToken, {
          fetchImpl: this.deps.fetchImpl,
          version: this.deps.version,
          capturedAt: nowIso,
        });
        const resets = detectResets(this.prev, fresh, nowIso);
        for (const e of resets) {
          this.log.info(`reset detected on ${e.cap} (was ${e.previousPct}%)`);
          await storage.recordReset(e);
        }
        for (const s of fresh) await storage.recordUsageSample(s);
        samples = fresh;
        this.prev = fresh;
      } catch (err) {
        if (err instanceof UsageAuthError) {
          // 401 despite a non-expired token (e.g. clock skew). Treat like expiry,
          // still write state; don't back off.
          tokenExpired = true;
          this.log.debug("poll returned 401 — treating as expired");
        } else {
          throw err; // network error -> caller backs off
        }
      }
    }

    await atomicWriteJson(
      paths.stateFile,
      buildLocalState({
        accountId: account?.id ?? null,
        tokenExpired,
        samples,
        pid: process.pid,
        startedAt: this.startedAt,
        now: nowIso,
      })
    );
  }

  /** Run until {@link stop}. Backs off exponentially on network failures. */
  async run(): Promise<void> {
    this.log.info(`daemon up (pid ${process.pid}, name ${this.deps.name})`);
    while (!this.stopped) {
      let delay = this.deps.pollIntervalMs;
      try {
        await this.tick();
        this.failures = 0;
      } catch (err) {
        if (err instanceof UsageAuthError) {
          this.failures = 0; // expected; next tick will skip cleanly
        } else {
          this.failures++;
          delay = Math.min(MAX_BACKOFF_MS, this.deps.pollIntervalMs * 2 ** this.failures);
          this.log.warn(`tick failed (${(err as Error).message}); backing off ${delay}ms`);
        }
      }
      if (this.stopped) break;
      await this.sleep(jitter(delay));
    }
    this.log.info("daemon stopped");
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(t);
        this.wake = null;
        resolve();
      };
    });
  }
}

/** ±10% so a fleet of daemons doesn't hammer the endpoint in lockstep. */
function jitter(ms: number): number {
  return Math.round(ms * (0.9 + Math.random() * 0.2));
}

/**
 * Acquire the single-instance lock, install signal handlers, run the loop, and
 * always release the lock + close storage on the way out. This is what the
 * `ccshare daemon run` process calls.
 */
export async function startDaemon(deps: DaemonDeps): Promise<void> {
  acquireLock(deps.paths.pidFile);
  const daemon = new Daemon(deps);

  const shutdown = (sig: string) => {
    deps.logger?.info?.(`received ${sig}`);
    daemon.stop();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await daemon.run();
  } finally {
    await deps.storage.close().catch(() => {});
    releaseLock(deps.paths.pidFile);
  }
}
