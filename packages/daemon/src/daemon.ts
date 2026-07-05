import {
  AccountConflictError,
  ApiRequestError,
  atomicWriteJson,
  buildLocalState,
  detectResets,
  emptyBatch,
  isEmptyBatch,
  isTokenExpired,
  JsonlReader,
  pollUsage,
  projectsDir,
  readCredentials,
  resolveAccount,
  UsageAuthError,
  type IngestSink,
  type MessageUsage,
  type TickBatch,
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
  /** Where observations go: the ccshare server over HTTP. */
  sink: IngestSink;
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

/**
 * A failed tick's batch is kept and merged into the next one (every row is
 * inserted idempotently — samples/resets on their natural key, messages/markers
 * on uuid/id — so the re-send can't double-count), but bounded so an extended
 * sink outage can't grow memory without limit. Newest rows win — they're the
 * ones attribution still needs.
 */
const PENDING_CAP = { samples: 5_000, resets: 100, messages: 5_000, markers: 500 };

/** A shared-mode ingest rejected for bad/revoked credentials (not transient). */
function isAuthError(err: unknown): err is ApiRequestError {
  return err instanceof ApiRequestError && (err.status === 401 || err.code === "auth");
}

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

/** Fold `pending` into `next` (older rows first), clamped to {@link PENDING_CAP}. */
function mergeBatches(pending: TickBatch, next: TickBatch): TickBatch {
  return {
    samples: [...pending.samples, ...next.samples].slice(-PENDING_CAP.samples),
    resets: [...pending.resets, ...next.resets].slice(-PENDING_CAP.resets),
    messages: [...pending.messages, ...next.messages].slice(-PENDING_CAP.messages),
    markers: [...pending.markers, ...next.markers].slice(-PENDING_CAP.markers),
  };
}

/**
 * The long-running observer (no IPC). Each tick reads the token, polls the tank,
 * ingests new transcript lines, sends everything to the sink as ONE batch, and
 * writes the local `state.json`. Old transcript history is never backfilled —
 * JSONL ingest baselines at EOF on start.
 */
export class Daemon {
  private prev: UsageSample[] = [];
  private readonly startedAt: string;
  private stopped = false;
  private wake: (() => void) | null = null;
  private failures = 0;
  private readonly log: Logger;
  private readonly reader: JsonlReader;
  /** The Claude account the ledger is bound to (§1.5); null = unbound. */
  private boundAccount: string | null = null;
  /** False until we've read the binding — while false we never enforce. */
  private boundAccountKnown = false;
  /** A batch a previous tick failed to send; merged into the next tick's. */
  private pending: TickBatch | null = null;
  /**
   * Latched once the server rejects our bearer (revoked/rotated). The token is
   * fixed at startup, so this can never clear without a restart — surfaced in
   * `state.json` so the TUI logs the user out and routes to `init` (§13).
   */
  private authRejected = false;
  /**
   * ISO 8601 of the last tick that fully synced (fresh poll + landed ingest).
   * Advances only on a clean tick, so the reader's "synced X ago" grows while
   * polls (429) or ingests (401/unreachable) fail rather than resetting every
   * tick. Persisted to `state.json`; null until the first clean sync.
   */
  private lastSyncAt: string | null = null;
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
   * refreshed. Everything observed lands in the sink as ONE batch. Returns
   * whether the poll or the ingest failed so {@link run} can back off.
   */
  async tick(): Promise<{ pollFailed: boolean }> {
    const { configDir, paths } = this.deps;
    const nowIso = new Date(this.nowMs()).toISOString();

    const account = await resolveAccount(configDir);
    const creds = await readCredentials(configDir);

    // Guard: never write into a ledger bound to a *different* Claude account —
    // interleaving two tanks in one `usage_samples` table corrupts attribution and
    // reset detection (§1.5). We still poll so the local user sees their own tank in
    // state.json, but skip the ledger write while the conflict holds.
    let accountConflict = this.isAccountConflict(account);
    if (accountConflict) {
      this.log.warn(
        `account mismatch: this machine's Claude account (${account?.id}) differs from ` +
          `the ledger's (${this.boundAccount}); NOT writing to the ledger`
      );
    }

    let tokenExpired = false;
    let pollFailed = false;
    let pollOk = false; // a fresh tank reading landed this tick
    const prevSamples = this.prev;
    let samples = this.prev;
    const batch = emptyBatch();

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
        }
        batch.resets.push(...resets);
        batch.samples.push(...fresh);
        samples = fresh;
        this.prev = fresh;
        pollOk = true;
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
      batch.messages.push(...rows);
      if (rows.length > 0) this.log.debug(`collected ${rows.length} new message(s)`);

      // Activity marker: the tank rose this tick but no measured message covers it,
      // yet this machine's user was driving Code moments ago. That gap is real
      // local work the transcript doesn't reflect in time (an endpoint-lagged tail,
      // or a resume/compaction re-prime). Credit the rise to that user rather than
      // `unknown` (§7). We decide *before* folding in this tick's activity.
      if (
        rows.length === 0 &&
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
        batch.markers.push(marker);
        this.log.debug(`activity marker for ${marker.user}: tank rose with no in-interval message`);
      }

      this.rememberActivity(rows);
    } catch (err) {
      this.log.warn(`jsonl ingest failed: ${(err as Error).message}`);
    }

    // ONE ledger write per tick. A previously failed batch is merged in first so
    // a transient outage never drops transcript rows (every row inserts
    // idempotently, so the re-send can't double-count). On an account conflict
    // everything observed this tick is consumed but deliberately dropped — it
    // belongs to a different tank.
    //
    // `ingestOk` tracks whether our contribution is current — a landed ingest, or
    // nothing new to send. It stays false on any conflict/failure, gating the clean-
    // sync heartbeat (`lastSyncAt`) below.
    let ingestOk = false;
    if (accountConflict) {
      this.pending = null;
    } else {
      const toSend = this.pending ? mergeBatches(this.pending, batch) : batch;
      if (!isEmptyBatch(toSend)) {
        try {
          await this.deps.sink.ingest(toSend, {
            at: nowIso,
            accountId: account?.hydrated ? account.id : null,
          });
          this.pending = null;
          ingestOk = true;
        } catch (err) {
          if (err instanceof AccountConflictError) {
            // The sink knows the binding better than we do (the server's 409).
            // Adopt it, flag the conflict, drop the batch.
            accountConflict = true;
            this.boundAccount = err.boundAccountId;
            this.boundAccountKnown = err.boundAccountId != null;
            this.pending = null;
            this.log.warn(`ledger refused the write: ${err.message}`);
          } else if (isAuthError(err)) {
            // Shared-mode: the bearer was rejected (revoked, or rotated by a
            // hand-off on another machine). This daemon's token is fixed at
            // startup, so retrying can't fix it — re-auth (`ccshare init`)
            // restarts the daemon with a fresh token. Drop the doomed batch and
            // surface an actionable error instead of silently spinning forever.
            this.pending = null;
            pollFailed = true; // back off hard rather than hammering every tick
            this.authRejected = true; // latch: surfaced in state.json → TUI logs out
            this.log.error(
              `shared-mode auth rejected (${err.message}) — your access token was revoked ` +
                "or rotated; re-run `ccshare init` to re-authenticate"
            );
          } else {
            this.pending = toSend;
            pollFailed = true; // count it for backoff like a poll failure
            this.log.warn(`ingest failed (will retry next tick): ${(err as Error).message}`);
          }
        }
      } else {
        // Nothing new observed — our ledger contribution is already up to date.
        ingestOk = true;
      }
    }

    // "synced X ago" must reflect a *complete* refresh: a fresh tank reading AND our
    // contribution landing on the ledger. Only a fully-clean tick advances it, so a
    // failed poll (429) or ingest (401/unreachable) leaves the footer's age growing
    // instead of resetting to zero and pretending the account picture is current.
    if (pollOk && ingestOk) this.lastSyncAt = nowIso;

    await atomicWriteJson(
      paths.stateFile,
      buildLocalState({
        accountId: account?.id ?? null,
        tokenExpired,
        accountConflict,
        authRejected: this.authRejected,
        lastSyncAt: this.lastSyncAt,
        samples,
        pid: process.pid,
        startedAt: this.startedAt,
        now: nowIso,
      })
    );

    return { pollFailed };
  }

  /**
   * Startup: bootstrap the sink, learn the binding (§1.5), and seed
   * the previous reading so a reset that happened while this daemon was down is
   * caught (and recorded) on the very first poll — not silently missed because
   * `prev` started empty. Skip the seed on an account conflict: those samples
   * belong to a *different* account and would poison detection. Never throws —
   * an unreachable backend means ticks retry, and we never enforce a binding we
   * haven't read (fail open, like writes would fail).
   */
  private async bootstrap(): Promise<void> {
    try {
      const boot = await this.deps.sink.bootstrap();
      this.boundAccount = boot.accountId;
      this.boundAccountKnown = true;
      const startupAccount = await resolveAccount(this.deps.configDir).catch(() => null);
      if (this.prev.length === 0 && !this.isAccountConflict(startupAccount)) {
        this.prev = boot.samples;
      }
    } catch (err) {
      this.boundAccountKnown = false;
      this.log.warn(`bootstrap failed (continuing): ${(err as Error).message}`);
    }
  }

  /** Run until {@link stop}. Backs off exponentially on poll failures. */
  async run(): Promise<void> {
    this.log.info(`daemon up (pid ${process.pid}, name ${this.deps.name})`);
    await this.bootstrap();
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
 * always release the lock + close the sink on the way out. This is what the
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
    await deps.sink.close().catch(() => {});
    releaseLock(deps.paths.pidFile);
  }
}
