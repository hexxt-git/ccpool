import { resolveAccount, type IngestSink, type readCredentials } from "@ccpool/core";
import { Pipeline } from "./pipeline.js";
import {
  acquireLock,
  makeLogger,
  reassertLock,
  releaseLock,
  type Logger,
  type LogLevel,
} from "./lifecycle.js";

/**
 * One account's runtime pieces, composed by the CLI (which owns the on-disk
 * profile layout and the HTTP backend). The manager combines these with its
 * shared observation seams to build a {@link Pipeline}. A `null` from a
 * {@link ProfileLoader} means "the live account has no ccpool profile" — the
 * manager then goes dormant for it (the personal-Pro case).
 */
export interface AccountProfile {
  /** The Claude `accountUuid` this profile belongs to. */
  accountId: string;
  /** This account's ledger sink (its own group, its own bearer). */
  sink: IngestSink;
  /** This account's `state.json` snapshot file. */
  stateFile: string;
  /** Active user name for attribution. */
  name: string;
  /** Resolve the active name fresh each tick (for `config set name` hand-offs). */
  resolveName?: () => Promise<string> | string;
}

export type ProfileLoader = (accountId: string) => Promise<AccountProfile | null>;

export interface DaemonDeps {
  /** The Claude config dir this daemon observes (one live account at a time). */
  configDir: string;
  /** Compose the runtime for an account, or null when it has no ccpool profile. */
  loadProfile: ProfileLoader;
  /** The single machine-wide pidfile — the daemon follows the live account. */
  pidFile: string;
  pollIntervalMs: number;
  logLevel?: LogLevel;
  logger?: Logger;
  /**
   * Re-assert single-instance ownership. Called at the very top of every tick — a
   * `false` return means a live peer owns the lock, so this instance is a duplicate
   * and must surrender before doing any work. Wired to {@link reassertLock} by
   * {@link startDaemon}; omitted in unit tests. Its absence disables the gate.
   */
  ensureOwner?: () => boolean;
  // injectable seams for tests, threaded into each pipeline
  now?: () => number;
  fetchImpl?: typeof fetch;
  version?: string;
  readCredentials?: typeof readCredentials;
}

const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * How often {@link startDaemon} re-verifies single-instance ownership, independent
 * of the poll interval and its exponential backoff — so a duplicate exits within
 * seconds even while the loop sleeps through a long backoff.
 */
const LOCK_GUARD_INTERVAL_MS = 5_000;

/**
 * The long-running observer (no IPC), now multi-account: one machine can be
 * logged into ccpool under several Claude accounts at once, but Claude Code only
 * ever has ONE hydrated `oauthAccount` live at a time. So the daemon *follows*
 * the live account — each tick it re-resolves who's live and routes the tick to
 * that account's {@link Pipeline}, lazily building it and evicting the previous
 * one (flush-then-evict). Only the active pipeline ever polls or writes, so an
 * inactive account's state simply waits for a switch back.
 */
export class Daemon {
  private stopped = false;
  private wake: (() => void) | null = null;
  private failures = 0;
  private readonly log: Logger;
  /** The pipeline for the account currently live, or null when dormant. */
  private active: Pipeline | null = null;
  /** The live account id the current `active` reflects (null = none resolved yet). */
  private activeId: string | null = null;
  /** Whether we've resolved the live account at least once. */
  private resolved = false;

  constructor(private readonly deps: DaemonDeps) {
    this.log = deps.logger ?? makeLogger(deps.logLevel ?? "info");
  }

  private nowMs(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** For tests/introspection: the account the daemon is currently observing. */
  activeAccountId(): string | null {
    return this.active?.accountId ?? null;
  }

  /**
   * Bring `active` in line with `liveId` (the account live right now). On a change:
   * flush-then-evict the outgoing pipeline, then lazily build the incoming one from
   * its profile (bootstrapping the sink + re-baselining the reader at EOF). When the
   * live account has no profile, `active` becomes null — the daemon goes dormant for
   * it (no poll, no write).
   */
  private async syncActive(liveId: string | null): Promise<void> {
    if (this.resolved && liveId === this.activeId) return;

    if (this.active) {
      const outgoing = this.active;
      this.log.info(`switching away from account ${this.activeId} — flushing`);
      await outgoing.flush().catch((err) => this.log.warn(`flush failed: ${err.message}`));
      await outgoing.close();
      this.active = null;
    }

    this.activeId = liveId;
    this.resolved = true;

    if (!liveId) {
      this.log.debug("no live Claude account — dormant");
      return;
    }

    const profile = await this.deps.loadProfile(liveId).catch((err) => {
      this.log.warn(`loading profile for ${liveId} failed: ${err.message}`);
      return null;
    });
    if (!profile) {
      this.log.info(`live account ${liveId} has no ccpool profile — dormant`);
      return;
    }

    const pipeline = new Pipeline({
      accountId: profile.accountId,
      sink: profile.sink,
      stateFile: profile.stateFile,
      name: profile.name,
      resolveName: profile.resolveName,
      configDir: this.deps.configDir,
      logger: this.log,
      now: this.deps.now,
      fetchImpl: this.deps.fetchImpl,
      version: this.deps.version,
      readCredentials: this.deps.readCredentials,
    });
    await pipeline.bootstrap();
    this.active = pipeline;
    this.log.info(`now observing account ${liveId} (name ${profile.name})`);
  }

  /**
   * One cycle: gate on single-instance ownership, resolve the live account,
   * hot-swap the active pipeline if it changed, then delegate the tick. A dormant
   * daemon (no live account or no profile for it) does nothing and never fails.
   */
  async tick(): Promise<{ pollFailed: boolean }> {
    // Single-instance gate: before touching anything, make sure we still own the
    // lock. If a live peer holds it we are a duplicate — surrender immediately.
    if (this.deps.ensureOwner && !this.deps.ensureOwner()) {
      this.log.warn("another daemon owns the lock — this instance is a duplicate; exiting");
      this.stopped = true;
      return { pollFailed: false };
    }

    const account = await resolveAccount(this.deps.configDir);
    const liveId = account?.hydrated ? account.id : null;
    this.log.debug(`live account: ${liveId ?? "none"}`);
    await this.syncActive(liveId);

    if (!this.active) return { pollFailed: false };
    return this.active.tick();
  }

  /** Run until {@link stop}. Backs off exponentially on poll failures. */
  async run(): Promise<void> {
    this.log.info(`daemon up (pid ${process.pid})`);
    while (!this.stopped) {
      let delay = this.deps.pollIntervalMs;
      try {
        const { pollFailed } = await this.tick();
        if (pollFailed) {
          this.failures++;
          delay = Math.min(MAX_BACKOFF_MS, this.deps.pollIntervalMs * 2 ** this.failures);
        } else {
          this.failures = 0;
        }
      } catch (err) {
        // Unexpected (non-poll) error — back off and keep running.
        this.failures++;
        delay = Math.min(MAX_BACKOFF_MS, this.deps.pollIntervalMs * 2 ** this.failures);
        this.log.warn(`tick failed (${(err as Error).message}); backing off ${delay}ms`);
      }
      if (this.stopped) break;
      await this.sleep(jitter(delay));
    }
    // Flush and release the active account on the way out.
    if (this.active) {
      await this.active.flush().catch(() => {});
      await this.active.close();
      this.active = null;
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
 * always release the lock on the way out. This is what the `ccpool daemon run`
 * process calls.
 */
export async function startDaemon(deps: DaemonDeps): Promise<void> {
  const { pidFile } = deps;
  acquireLock(pidFile);
  const daemon = new Daemon({ ...deps, ensureOwner: () => reassertLock(pidFile) });

  const shutdown = (sig: string) => {
    deps.logger?.info?.(`received ${sig}`);
    daemon.stop();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const guard = setInterval(() => {
    if (!reassertLock(pidFile)) {
      deps.logger?.warn?.("lost single-instance lock to a live peer — exiting as duplicate");
      daemon.stop();
    }
  }, LOCK_GUARD_INTERVAL_MS);
  guard.unref?.(); // never keep the process alive just for the guard

  try {
    await daemon.run();
  } finally {
    clearInterval(guard);
    releaseLock(pidFile);
  }
}
