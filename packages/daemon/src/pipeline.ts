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
  UsageAuthError,
  UsageRequestError,
  type IngestSink,
  type LocalState,
  type MessageUsage,
  type TickBatch,
  type UsageMarker,
  type UsageSample,
} from "@ccpool/core";
import { randomUUID } from "node:crypto";
import { makeLogger, type Logger, type LogLevel } from "./lifecycle.js";

/**
 * Everything one account's observation needs. A {@link Pipeline} is built for the
 * *live* Claude account and only ever observes that account — the manager
 * ({@link ../daemon.Daemon}) rebuilds it on a switch, so a pipeline never has to
 * reason about a foreign account.
 */
export interface PipelineDeps {
  /** The Claude `accountUuid` this pipeline observes and attributes to. */
  accountId: string;
  /** Where observations go: this account's ccpool group over HTTP. */
  sink: IngestSink;
  /** This account's `state.json` snapshot file. */
  stateFile: string;
  /** The Claude config dir this daemon observes (shared across accounts). */
  configDir: string;
  /** Active user name (used for attribution). */
  name: string;
  /** Resolve the active name fresh each tick so hand-offs apply without restart. */
  resolveName?: () => Promise<string> | string;
  logLevel?: LogLevel;
  logger?: Logger;
  // injectable seams for tests
  now?: () => number;
  fetchImpl?: typeof fetch;
  version?: string;
  /**
   * Read the stored OAuth credentials. Injectable so tests can supply a token
   * deterministically instead of falling through to the host's real macOS
   * keychain (readCredentials consults it when the plaintext file is missing or
   * expired). Defaults to core's {@link readCredentials}.
   */
  readCredentials?: typeof readCredentials;
}

/**
 * How recently this machine must have produced Code activity for an
 * otherwise-unexplained tank rise to be marked as its user's (the "Attribution" section). A rise inside
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
 * One account's observer (no IPC). Each tick reads the token, polls the tank,
 * ingests new transcript lines, sends everything to the sink as ONE batch, and
 * writes the local `state.json`. Old transcript history is never backfilled —
 * JSONL ingest baselines at EOF on {@link bootstrap}, and a rebuild (after a
 * switch away and back) re-baselines, so a pipeline never claims activity that
 * accrued while another account was live.
 */
export class Pipeline {
  private prev: UsageSample[] = [];
  private readonly startedAt: string;
  private readonly log: Logger;
  private readonly reader: JsonlReader;
  /** Latched if the server ever refuses our write for a different account (409). */
  private accountConflict = false;
  /** A batch a previous tick failed to send; merged into the next tick's. */
  private pending: TickBatch | null = null;
  /**
   * Latched once the server rejects our bearer (revoked/rotated). The token is
   * fixed at startup, so this can never clear without a restart — surfaced in
   * `state.json` so the TUI logs the user out and routes to `init` (the "server" section).
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
  // this machine's untracked overhead (activity marker, the "Attribution" section). Reset on restart —
  // the reader re-baselines at EOF, so we never mark against stale history.
  private lastLocalActivityMs: number | null = null;
  private lastLocalUser: string | null = null;
  private lastLocalModel: string | null = null;
  private lastLocalWeight = 1;

  constructor(private readonly deps: PipelineDeps) {
    this.log = deps.logger ?? makeLogger(deps.logLevel ?? "info");
    this.startedAt = new Date(this.nowMs()).toISOString();
    this.reader = new JsonlReader(projectsDir(deps.configDir));
  }

  get accountId(): string {
    return this.deps.accountId;
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
   * One observation cycle. Poll, JSONL ingest, and the state.json write are
   * independent: a poll failure never blocks attribution, and state is always
   * refreshed. Everything observed lands in the sink as ONE batch. Returns
   * whether the poll or the ingest failed so the manager can back off.
   */
  async tick(): Promise<{ pollFailed: boolean }> {
    const { configDir, stateFile } = this.deps;

    const nowIso = new Date(this.nowMs()).toISOString();

    const creds = await (this.deps.readCredentials ?? readCredentials)(configDir, {
      now: this.nowMs(),
      onDebug: (m) => this.log.debug(m),
    });

    let tokenExpired = false;
    let pollFailed = false;
    let pollOk = false; // a fresh tank reading landed this tick
    let pollError: LocalState["pollError"] = null; // last poll's failure, surfaced to state.json
    const prevSamples = this.prev;
    let samples = this.prev;
    const batch = emptyBatch();

    if (!creds || isTokenExpired(creds, this.nowMs())) {
      // Skip the poll; Claude Code refreshes on its next run (see "Identity"). Not an error.
      tokenExpired = true;
      this.log.debug("token missing/expired — skipping poll");
    } else {
      try {
        this.log.debug("polling usage endpoint…");
        const fresh = await pollUsage(creds.accessToken, {
          fetchImpl: this.deps.fetchImpl,
          version: this.deps.version,
          capturedAt: nowIso,
        });
        this.log.debug(
          `poll ok: ${fresh.map((s) => `${s.cap}=${s.pct}%`).join(", ") || "no caps"}`
        );
        const resets = detectResets(this.prev, fresh, nowIso);
        for (const e of resets) {
          this.log.info(`reset detected on ${e.cap} (was ${e.previousPct}%)`);
        }
        batch.resets.push(...resets);
        // Report-on-change: only send samples that move the tank vs the last
        // reading for that cap (or that accompany a reset). Flat repeats are what
        // the server's envelope filter would discard anyway, so omitting them spares
        // the request without changing the stored trajectory — a steady tank with no
        // new messages/markers sends no ingest at all.
        const changedSamples = fresh.filter((s) => {
          const prior = this.prev.find((p) => p.cap === s.cap);
          return !prior || prior.pct !== s.pct;
        });
        batch.samples.push(...changedSamples);
        samples = fresh;
        this.prev = fresh;
        pollOk = true;
      } catch (err) {
        if (err instanceof UsageAuthError) {
          // 401 despite a non-expired token (e.g. clock skew). Treat like expiry.
          tokenExpired = true;
          this.log.debug("poll returned 401 — treating as expired");
        } else {
          // Network / non-2xx error: note it for backoff, but carry on with
          // ingest + state. Record *why* so the TUI can explain a stalled sync
          // (a 429 rate-limit is the common one) instead of a silent gap.
          pollFailed = true;
          const status = err instanceof UsageRequestError ? err.status : null;
          const message =
            status === 429
              ? "rate-limited (429)"
              : status !== null
                ? `poll failed (HTTP ${status})`
                : `poll failed (${(err as Error).message})`;
          pollError = { status, message, at: nowIso };
          this.log.warn(`usage poll failed: ${(err as Error).message}`);
        }
      }
    }

    // Attribute new Claude Code activity to the active name (or unknown). Only
    // lines appended since the pipeline came up; the reader baselines at EOF.
    try {
      const name = await this.currentName();
      const rows = await this.reader.collectNew(name);
      batch.messages.push(...rows);
      if (rows.length > 0) this.log.debug(`collected ${rows.length} new message(s)`);

      // Activity marker: the tank rose this tick but no measured message covers it,
      // yet this machine's user was driving Code moments ago. That gap is real
      // local work the transcript doesn't reflect in time (an endpoint-lagged tail,
      // or a resume/compaction re-prime). Credit the rise to that user rather than
      // `unknown` (the "Attribution" section). We decide *before* folding in this tick's activity.
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

    const ingestOk = await this.sendBatch(batch, nowIso);

    // "synced X ago" must reflect a *complete* refresh — a fresh tank reading AND our
    // contribution landing — so only a fully-clean tick advances it. A failed poll or
    // ingest leaves the footer's age growing rather than pretending we're current.
    if (pollOk && ingestOk) this.lastSyncAt = nowIso;
    // A retained batch or a hard auth failure counts as a poll failure for backoff.
    if (this.pending !== null || (this.authRejected && !ingestOk)) pollFailed = true;

    await atomicWriteJson(
      stateFile,
      buildLocalState({
        accountId: this.deps.accountId,
        tokenExpired,
        accountConflict: this.accountConflict,
        authRejected: this.authRejected,
        lastSyncAt: this.lastSyncAt,
        pollError,
        samples,
        pid: process.pid,
        startedAt: this.startedAt,
        now: nowIso,
      })
    );

    return { pollFailed };
  }

  /**
   * ONE ledger write per tick. A previously failed batch is merged in first (rows
   * insert idempotently, so a re-send can't double-count). Returns whether our
   * contribution is up to date (a landed ingest, or nothing to send) — the caller
   * gates the clean-sync heartbeat on it.
   */
  private async sendBatch(batch: TickBatch, nowIso: string): Promise<boolean> {
    const toSend = this.pending ? mergeBatches(this.pending, batch) : batch;
    if (isEmptyBatch(toSend)) {
      // Nothing new observed — our ledger contribution is already up to date.
      return true;
    }
    try {
      this.log.debug(
        `ingest: sending ${toSend.samples.length} sample(s), ${toSend.messages.length} message(s), ` +
          `${toSend.resets.length} reset(s), ${toSend.markers.length} marker(s)` +
          (this.pending ? " (includes a retried batch)" : "")
      );
      await this.deps.sink.ingest(toSend, { at: nowIso, accountId: this.deps.accountId });
      this.log.debug("ingest ok");
      this.pending = null;
      return true;
    } catch (err) {
      if (err instanceof AccountConflictError) {
        // The server's group is bound to a different account than we think we are —
        // should not happen for a per-account profile, but never write into a
        // foreign tank. Flag it and drop the batch.
        this.accountConflict = true;
        this.pending = null;
        this.log.warn(`ledger refused the write: ${err.message}`);
      } else if (isAuthError(err)) {
        // Bearer rejected (revoked, or rotated by a hand-off elsewhere). This
        // pipeline's token is fixed at build time, so retrying can't fix it — drop
        // the batch and surface an actionable error rather than spinning forever.
        this.pending = null;
        this.authRejected = true; // latch: surfaced in state.json → TUI logs out
        this.log.error(
          `shared-mode auth rejected (${err.message}) — your access token was revoked ` +
            "or rotated; re-run `ccpool init` to re-authenticate"
        );
      } else {
        this.pending = toSend;
        this.log.warn(`ingest failed (will retry next tick): ${(err as Error).message}`);
      }
      return false;
    }
  }

  /**
   * Startup: bootstrap the sink and seed the previous reading so a reset that
   * happened while this account wasn't being observed is caught (and recorded) on
   * the very first poll — not silently missed because `prev` started empty. Never
   * throws — an unreachable backend means ticks retry.
   */
  async bootstrap(): Promise<void> {
    try {
      const boot = await this.deps.sink.bootstrap();
      if (this.prev.length === 0) this.prev = boot.samples;
    } catch (err) {
      this.log.warn(`bootstrap failed (continuing): ${(err as Error).message}`);
    }
  }

  /**
   * Flush any retained batch before this pipeline is evicted (the live Claude
   * account switched away), so the outgoing account's ledger is complete up to the
   * switch moment. Best-effort — a failed flush just leaves the pending batch,
   * which a later switch-back would re-send idempotently.
   */
  async flush(): Promise<void> {
    if (!this.pending) return;
    const nowIso = new Date(this.nowMs()).toISOString();
    await this.sendBatch(emptyBatch(), nowIso);
  }

  /** Release the sink. */
  async close(): Promise<void> {
    await this.deps.sink.close().catch(() => {});
  }
}
