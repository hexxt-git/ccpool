import {
  atomicWriteJson,
  buildLocalState,
  detectResets,
  isTokenExpired,
  JsonlReader,
  pollUsage,
  projectsDir,
  readCredentials,
  resolveAccount,
  SCHEMA_VERSION,
  UsageAuthError,
  type MessageUsage,
  type Storage,
  type UsageMarker,
  type UsageSample,
} from "@ccshare/core";
import { randomUUID } from "node:crypto";
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
  /** Resolve the active name fresh each tick so hand-offs apply without restart. */
  resolveName?: () => Promise<string> | string;
  // injectable seams for tests
  now?: () => number;
  fetchImpl?: typeof fetch;
  version?: string;
}

const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * How recently this machine must have produced Code activity for an
 * otherwise-unexplained tank rise to be marked as its user's (§7). A rise inside
 * this window of the last local message is treated as that user's untracked
 * overhead (endpoint-lagged tail, or a resume/compaction re-prime the transcript
 * under-reports). Beyond it, the rise stays `unknown` — the conservative bias, so
 * a genuinely idle machine never claims mobile/web/chat usage.
 */
const MARKER_ACTIVITY_WINDOW_MS = 3 * 60_000;

/** Sub-point wobble that isn't a real rise (matches reset detection's epsilon). */
const MARKER_RISE_EPSILON = 0.5;

/** The same reliable, comparable weight attribution uses (cache + output). */
function messageWeight(m: MessageUsage): number {
  return Math.max(0, m.cacheCreationTokens + m.cacheReadTokens + m.outputTokens);
}

/** True if any cap in `next` rose beyond wobble vs the same cap in `prev`. */
function anyCapRose(prev: UsageSample[], next: UsageSample[]): boolean {
  const before = new Map(prev.map((s) => [s.cap, s.pct]));
  return next.some((s) => {
    const p = before.get(s.cap);
    return p !== undefined && s.pct > p + MARKER_RISE_EPSILON;
  });
}

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
  private readonly reader: JsonlReader;
  /** The Claude account the shared DB is bound to (§1.5); null = unbound. */
  private boundAccount: string | null = null;
  /** False until we've read the binding — while false we never enforce. */
  private boundAccountKnown = false;
  // Most-recent local Code activity, for deciding when an unexplained tank rise is
  // this machine's untracked overhead (activity marker, §7). Reset on restart —
  // the reader re-baselines at EOF, so we never mark against stale history.
  private lastLocalActivityMs: number | null = null;
  private lastLocalUser: string | null = null;
  private lastLocalModel: string | null = null;
  private lastLocalWeight = 1;

  constructor(private readonly deps: DaemonDeps) {
    this.log = deps.logger ?? makeLogger(deps.logLevel ?? "info");
    this.startedAt = new Date(this.nowMs()).toISOString();
    this.reader = new JsonlReader(projectsDir(deps.configDir));
  }

  private async currentName(): Promise<string> {
    return (await this.deps.resolveName?.()) ?? this.deps.name;
  }

  private nowMs(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Record the most-recent Code activity this machine saw, so the next tick can
   * tell whether an unexplained tank rise is this user's untracked overhead. Uses
   * the latest row's user/model and the batch's summed weight (a rough throughput,
   * floored at 1) to break ties if two machines mark the same interval.
   */
  private rememberActivity(rows: MessageUsage[]): void {
    if (rows.length === 0) return;
    let weight = 0;
    let latest = this.lastLocalActivityMs ?? -Infinity;
    for (const r of rows) {
      weight += messageWeight(r);
      const parsed = Date.parse(r.timestamp);
      // Clamp a future-dated row to now so clock skew can't push the window out.
      const t = Number.isFinite(parsed) ? Math.min(parsed, this.nowMs()) : this.nowMs();
      if (t >= latest) {
        latest = t;
        this.lastLocalUser = r.user;
        this.lastLocalModel = r.model;
      }
    }
    this.lastLocalActivityMs = latest === -Infinity ? this.nowMs() : latest;
    this.lastLocalWeight = Math.max(1, weight);
  }

  /**
   * Heal the shared DB's schema to the version this build understands, so a CLI
   * update never leaves the user running a manual `init --reconfigure`. Migrations
   * are additive (nullable columns), so this is forward-safe and multi-machine
   * safe: an older daemon keeps writing the columns it knows. If the DB is *newer*
   * than this build we log and continue rather than take the observer offline.
   */
  private async ensureSchemaCurrent(): Promise<void> {
    try {
      const info = await this.deps.storage.inspect();
      if (info.kind !== "ccshare") return;
      if (info.schemaVersion < SCHEMA_VERSION) {
        this.log.info(`migrating shared DB schema v${info.schemaVersion} → v${SCHEMA_VERSION}`);
        await this.deps.storage.migrate(SCHEMA_VERSION);
      } else if (info.schemaVersion > SCHEMA_VERSION) {
        this.log.warn(
          `shared DB schema is v${info.schemaVersion}, newer than this build (v${SCHEMA_VERSION}); ` +
            `continuing on known columns — consider updating ccshare`
        );
      }
    } catch {
      /* DB unreachable at startup — ticks will retry, and init already migrated */
    }
  }

  /** Read the account the shared DB is bound to, once. DB unreachable → stay
   * "unknown" so we fail open (writes would fail anyway) rather than block. */
  private async loadBoundAccount(): Promise<void> {
    try {
      const info = await this.deps.storage.inspect();
      this.boundAccount = info.kind === "ccshare" ? info.accountId : null;
      this.boundAccountKnown = true;
    } catch {
      this.boundAccountKnown = false;
    }
  }

  /**
   * True when this machine's Claude account differs from the account the ledger is
   * bound to. Only a *hydrated* (onboarded) account has a real accountUuid to
   * compare — an unbound ledger or an unhydrated local account never conflicts.
   */
  private isAccountConflict(account: { id: string; hydrated: boolean } | null): boolean {
    if (!this.boundAccountKnown || this.boundAccount == null) return false;
    if (!account || !account.hydrated) return false;
    return account.id !== this.boundAccount;
  }

  /**
   * One observation cycle. Poll, JSONL ingest, and the state.json write are
   * independent: a poll failure never blocks attribution, and state is always
   * refreshed. Returns whether the poll failed so {@link run} can back off.
   */
  async tick(): Promise<{ pollFailed: boolean }> {
    const { storage, configDir, paths } = this.deps;
    const nowIso = new Date(this.nowMs()).toISOString();

    const account = await resolveAccount(configDir);
    const creds = await readCredentials(configDir);

    // Guard: never write into a ledger bound to a *different* Claude account —
    // interleaving two tanks in one `usage_samples` table corrupts attribution and
    // reset detection (§1.5). We still poll so the local user sees their own tank in
    // state.json, but skip every shared-DB write while the conflict holds.
    const accountConflict = this.isAccountConflict(account);
    if (accountConflict) {
      this.log.warn(
        `account mismatch: this machine's Claude account (${account?.id}) differs from ` +
          `the shared DB's (${this.boundAccount}); NOT writing to the ledger`
      );
    }

    let tokenExpired = false;
    let pollFailed = false;
    const prevSamples = this.prev;
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
        if (!accountConflict) {
          const resets = detectResets(this.prev, fresh, nowIso);
          for (const e of resets) {
            this.log.info(`reset detected on ${e.cap} (was ${e.previousPct}%)`);
            await storage.recordReset(e);
          }
          for (const s of fresh) await storage.recordUsageSample(s);
        }
        samples = fresh;
        this.prev = fresh;
      } catch (err) {
        if (err instanceof UsageAuthError) {
          // 401 despite a non-expired token (e.g. clock skew). Treat like expiry.
          tokenExpired = true;
          this.log.debug("poll returned 401 — treating as expired");
        } else {
          // Network error: note it for backoff, but carry on with ingest + state.
          pollFailed = true;
          this.log.warn(`usage poll failed: ${(err as Error).message}`);
        }
      }
    }

    // Attribute new Claude Code activity to the active name (or unknown). Only
    // lines appended since the daemon came up; the reader baselines at EOF.
    try {
      const name = await this.currentName();
      const rows = await this.reader.collectNew(name);
      // Advance the reader's offsets even on conflict (rows are consumed), but don't
      // record them — they'd land in the wrong account's ledger.
      if (rows.length > 0 && !accountConflict) {
        await storage.recordMessageUsage(rows);
        this.log.debug(`ingested ${rows.length} message(s)`);
      }

      // Activity marker: the tank rose this tick but no measured message covers it,
      // yet this machine's user was driving Code moments ago. That gap is real
      // local work the transcript doesn't reflect in time (an endpoint-lagged tail,
      // or a resume/compaction re-prime). Credit the rise to that user rather than
      // `unknown` (§7). We decide *before* folding in this tick's activity, and skip
      // when a message already covers the interval or on an account conflict.
      if (
        rows.length === 0 &&
        !accountConflict &&
        anyCapRose(prevSamples, samples) &&
        this.lastLocalActivityMs !== null &&
        this.nowMs() - this.lastLocalActivityMs <= MARKER_ACTIVITY_WINDOW_MS
      ) {
        const marker: UsageMarker = {
          id: randomUUID(),
          user: this.lastLocalUser ?? name,
          at: nowIso,
          model: this.lastLocalModel,
          weight: this.lastLocalWeight,
        };
        await storage.recordUsageMarker(marker);
        this.log.debug(`activity marker for ${marker.user}: tank rose with no in-interval message`);
      }

      this.rememberActivity(rows);
    } catch (err) {
      this.log.warn(`jsonl ingest failed: ${(err as Error).message}`);
    }

    await atomicWriteJson(
      paths.stateFile,
      buildLocalState({
        accountId: account?.id ?? null,
        tokenExpired,
        accountConflict,
        samples,
        pid: process.pid,
        startedAt: this.startedAt,
        now: nowIso,
      })
    );

    return { pollFailed };
  }

  /** Run until {@link stop}. Backs off exponentially on poll failures. */
  async run(): Promise<void> {
    this.log.info(`daemon up (pid ${process.pid}, name ${this.deps.name})`);
    // Auto-heal the schema first (adds any new columns), then read the binding.
    await this.ensureSchemaCurrent();
    // Read which account the ledger is bound to before touching it (§1.5).
    await this.loadBoundAccount();
    // Seed the previous reading from the shared DB so a reset that happened while
    // this daemon was down is caught (and recorded) on the very first poll — not
    // silently missed because `prev` started empty. Skip it on an account conflict:
    // those samples belong to a *different* account and would poison detection.
    const startupAccount = await resolveAccount(this.deps.configDir).catch(() => null);
    if (this.prev.length === 0 && !this.isAccountConflict(startupAccount)) {
      try {
        this.prev = await this.deps.storage.getLatestSamples();
      } catch {
        /* DB unreachable at startup — fall back to detecting from the first poll on */
      }
    }
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
