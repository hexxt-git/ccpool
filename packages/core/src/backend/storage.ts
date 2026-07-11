import type {
  CapKind,
  HistoryShare,
  MessageUsage,
  SharedView,
  TickBatch,
  UsageMarker,
  UsageSample,
} from "../types.js";
import type { Storage } from "../storage/storage.js";
import { isEmptyBatch, SCHEMA_VERSION } from "../storage/storage.js";
import type { HistoryPage, HistoryQuery, HistoryWindowView } from "../types.js";
import {
  assembleSharedView,
  computeSharedView,
  RETENTION_MS,
  viewCacheKey,
} from "../state/view.js";
import { attributeShares } from "../state/shares.js";
import type { LedgerWindow } from "./window.js";
import {
  AccountConflictError,
  type IngestBootstrap,
  type IngestMeta,
  type IngestSink,
} from "./sink.js";
import type { ViewSource } from "./view-source.js";

/** How often one sink sweeps old rows out. Cheap (indexed deletes), so generous. */
const DEFAULT_PRUNE_INTERVAL_MS = 6 * 3600_000;
/**
 * How long after a reset a just-closed window stays amendable before it freezes
 * into history (ADR-0002). Late idempotent re-sends within this window still move
 * its shares; after it, the record is immutable.
 */
const DEFAULT_GRACE_MS = 30 * 60_000;
/** Finalization is checked at most this often per sink — grace is 30 min, so cheap. */
const DEFAULT_FINALIZE_INTERVAL_MS = 60_000;

/**
 * Reduces a daemon's raw per-tick samples to the **monotonic usage envelope** —
 * the only thing attribution consumes (ADR-0004). A sample is kept only when it
 * raises the running max for its cap within the current window; flat readings and
 * dips (clock-skew wobble) are dropped, and a second machine reporting a level the
 * global tank already reached raises nothing, so per-member sample streams collapse
 * into one canonical trajectory. A recorded reset restarts the cap's envelope, so
 * the post-reset baseline sample is always kept. Stateful per sink (one group), so
 * `getLatestSamples()` (the stored envelope top) seeds it across (re)opens.
 */
class EnvelopeFilter {
  private envMax = new Map<CapKind, number>();
  private winStart = new Map<CapKind, string>();

  /** Seed from the stored envelope tops so a reopened sink doesn't re-emit points. */
  seed(latest: UsageSample[]): void {
    for (const s of latest) this.envMax.set(s.cap, s.pct);
  }

  /** A copy of `batch` whose `samples` are only the envelope-raising ones. */
  filter(batch: TickBatch): TickBatch {
    // Resets first: a new reset restarts that cap's envelope at −∞ so the
    // (lower) post-reset baseline sample is kept as the window's new floor.
    for (const r of batch.resets) {
      const cur = this.winStart.get(r.cap);
      if (cur === undefined || r.at > cur) {
        this.winStart.set(r.cap, r.at);
        this.envMax.set(r.cap, -Infinity);
      }
    }
    const kept: UsageSample[] = [];
    // Ascending time so the running max advances correctly within one batch.
    for (const s of [...batch.samples].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))) {
      const ws = this.winStart.get(s.cap);
      if (ws !== undefined && s.capturedAt < ws) continue; // belongs to a prior window
      const max = this.envMax.get(s.cap) ?? -Infinity;
      if (s.pct > max) {
        this.envMax.set(s.cap, s.pct);
        kept.push(s);
      }
    }
    return { ...batch, samples: kept };
  }
}

export interface StorageIngestSinkOptions {
  /** Rows older than this are swept on the next throttled prune. */
  retentionMs?: number;
  pruneIntervalMs?: number;
  /** Grace after a reset before a closed window freezes into history. */
  graceMs?: number;
  /** How often finalization is checked (throttled). */
  finalizeIntervalMs?: number;
  now?: () => number;
  /**
   * The group's in-memory ledger mirror (server-side): every committed batch
   * is appended to it and every prune mirrored, so the paired view source
   * recomputes without re-reading the window from storage.
   */
  window?: LedgerWindow;
}

/**
 * The direct-storage {@link IngestSink}: what the server composes per group
 * behind `POST /v1/ingest`. One
 * `recordBatch` transaction per tick, plus a throttled retention prune.
 */
export class StorageIngestSink implements IngestSink {
  private boundAccountId: string | null = null;
  /** False until bootstrap read the binding — we never enforce blind. */
  private bindingKnown = false;
  private lastPruneMs: number;
  private readonly retentionMs: number;
  private readonly pruneIntervalMs: number;
  private readonly graceMs: number;
  private readonly finalizeIntervalMs: number;
  private lastFinalizeMs = 0;
  /** `${cap} ${windowStart}` of windows already frozen — skip recompute. */
  private readonly frozen = new Set<string>();
  private readonly now: () => number;
  private readonly window: LedgerWindow | undefined;
  private readonly envelope = new EnvelopeFilter();

  constructor(
    private readonly storage: Storage,
    opts: StorageIngestSinkOptions = {}
  ) {
    this.retentionMs = opts.retentionMs ?? RETENTION_MS;
    this.pruneIntervalMs = opts.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.finalizeIntervalMs = opts.finalizeIntervalMs ?? DEFAULT_FINALIZE_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.window = opts.window;
    // Clock starts at construction, not the epoch: a sink is rebuilt on every
    // (re)open, and a 0 here would prune on the very first ingest — turning the
    // once-per-interval sweep into near-per-ingest work under tenant churn.
    this.lastPruneMs = this.now();
  }

  /**
   * Heal the schema to the version this build understands (an update must never
   * require a manual re-init), then report the binding + reset-detection seed.
   * Throws when the DB is unreachable — callers decide how to degrade.
   */
  async bootstrap(): Promise<IngestBootstrap> {
    const info = await this.storage.inspect();
    if (info.kind !== "ccshare") {
      throw new Error(`not a ccshare database (${info.kind}) — run \`ccshare init\``);
    }
    if (info.schemaVersion < SCHEMA_VERSION) {
      await this.storage.migrate(SCHEMA_VERSION);
    }
    // A newer schema than this build is fine: readers use known columns only.
    this.boundAccountId = info.accountId;
    this.bindingKnown = true;
    const latest = await this.storage.getLatestSamples();
    // Seed the envelope from the stored tops so a reopened sink doesn't re-persist
    // points the stored trajectory already has.
    this.envelope.seed(latest);
    return { accountId: info.accountId, samples: latest };
  }

  async ingest(batch: TickBatch, meta: IngestMeta): Promise<void> {
    // Defensive re-check of §1.5 (the daemon already compares against its
    // bootstrap): both sides hydrated/bound and different -> nothing is written.
    if (
      this.bindingKnown &&
      this.boundAccountId !== null &&
      meta.accountId !== null &&
      meta.accountId !== this.boundAccountId
    ) {
      throw new AccountConflictError(this.boundAccountId);
    }
    // Reduce raw samples to envelope-raising points before anything is persisted;
    // messages/markers/resets pass through. A flat tick collapses to an empty batch
    // here — so no-op ticks cost no write and no change-token bump (ADR-0006 §2).
    const reduced = this.envelope.filter(batch);
    if (!isEmptyBatch(reduced)) {
      await this.storage.recordBatch(reduced);
      // Mirror the committed rows into the in-memory window (never before the
      // commit — a failed batch is retained and re-sent by the daemon).
      this.window?.append(reduced);
    }

    const now = this.now();
    await this.maybeFinalize(now);
    if (now - this.lastPruneMs >= this.pruneIntervalMs) {
      this.lastPruneMs = now;
      const before = new Date(now - this.retentionMs).toISOString();
      await this.storage.prune(before);
      this.window?.applyPrune(before);
    }
  }

  /**
   * Freeze any window whose closing reset is now past the grace period into an
   * immutable {@link HistoryWindow} + shares (ADR-0002/0008). Throttled (grace is 30
   * min). A window spans two consecutive resets of the cap (the first opens at the
   * earliest retained sample); shares come from the same `attributeShares` the live
   * view uses. `recordHistoryWindow` is idempotent and `frozen` skips recompute.
   */
  private async maybeFinalize(now: number): Promise<void> {
    if (now - this.lastFinalizeMs < this.finalizeIntervalMs) return;
    this.lastFinalizeMs = now;
    const since = new Date(now - this.retentionMs).toISOString();
    const resets = await this.storage.getResetsSince(since);
    if (resets.length === 0) return;

    const capResets = new Map<CapKind, number[]>();
    for (const r of resets) {
      const t = Date.parse(r.at);
      if (!Number.isFinite(t)) continue;
      const arr = capResets.get(r.cap);
      if (arr) arr.push(t);
      else capResets.set(r.cap, [t]);
    }

    let samples: UsageSample[] | null = null;
    let messages: MessageUsage[] | null = null;
    let markers: UsageMarker[] | null = null;

    for (const [cap, times] of capResets) {
      times.sort((a, b) => a - b);
      for (let i = 0; i < times.length; i++) {
        const endMs = times[i]!;
        if (endMs + this.graceMs > now) continue; // still amendable

        // Load the trajectory/activity once, lazily, only when something freezes.
        if (samples === null) {
          [samples, messages, markers] = await Promise.all([
            this.storage.getUsageSamplesSince(since),
            this.storage.getMessageUsageSince(since),
            this.storage.getUsageMarkersSince(since).catch(() => []),
          ]);
        }

        const capSamples = samples.filter((s) => s.cap === cap);
        // Window start = the previous reset, or the earliest retained sample.
        const startMs =
          i > 0
            ? times[i - 1]!
            : Math.min(...capSamples.map((s) => Date.parse(s.capturedAt)).filter(Number.isFinite));
        if (!Number.isFinite(startMs) || startMs >= endMs) continue;
        const windowStart = new Date(startMs).toISOString();
        const key = `${cap} ${windowStart}`;
        if (this.frozen.has(key)) continue;
        const windowEnd = new Date(endMs).toISOString();

        const inWin = (iso: string) => {
          const t = Date.parse(iso);
          return t >= startMs && t < endMs;
        };
        const winSamples = capSamples.filter((s) => inWin(s.capturedAt));
        if (winSamples.length === 0) {
          this.frozen.add(key);
          continue;
        }
        const winMsgs = messages!.filter((m) => inWin(m.timestamp));
        const winMarkers = markers!.filter((m) => inWin(m.at));
        // Anchor attribution at the window end, bounded by its opening reset.
        const openingReset = [{ cap, at: windowStart, previousPct: 0 }];
        const shares = attributeShares(winSamples, winMsgs, endMs, openingReset, winMarkers).filter(
          (sh) => sh.cap === cap
        );
        const overall = Math.max(...winSamples.map((s) => s.pct));
        const historyShares: HistoryShare[] = shares.map((sh) => ({
          cap,
          windowStart,
          user: sh.user,
          pct: sh.pct,
        }));
        await this.storage.recordHistoryWindow(
          { cap, windowStart, windowEnd, overall, closedAt: new Date(now).toISOString() },
          historyShares
        );
        this.frozen.add(key);
      }
    }
  }

  async close(): Promise<void> {
    await this.storage.close();
  }
}

/**
 * The direct-storage {@link ViewSource}: a 2s refresh costs one single-row
 * change-token read; the heavy 7-day window queries only rerun when the token
 * (or the 60s time bucket) moves. Also composed per group by the server, whose
 * ETag is this same cache key.
 */
export class StorageViewSource implements ViewSource {
  private cache: { key: string; view: SharedView } | null = null;
  private readonly window: LedgerWindow | undefined;

  constructor(
    private readonly storage: Storage,
    opts: { window?: LedgerWindow } = {}
  ) {
    this.window = opts.window;
  }

  /** The key the current view was computed under (the server's ETag). */
  async currentKey(now = Date.now()): Promise<string> {
    return viewCacheKey(await this.storage.getChangeToken(), now);
  }

  async history(query: HistoryQuery): Promise<HistoryPage> {
    const limit = query.limit ?? 100;
    const windows = await this.storage.getHistoryWindows(query.cap, {
      before: query.before,
      limit,
    });
    const view: HistoryWindowView[] = await Promise.all(
      windows.map(async (w) => ({
        cap: w.cap,
        windowStart: w.windowStart,
        windowEnd: w.windowEnd,
        overall: w.overall,
        shares: (await this.storage.getHistoryShares(query.cap, w.windowStart)).map((s) => ({
          user: s.user,
          pct: s.pct,
        })),
      }))
    );
    // A full page implies there may be more; hand back the oldest as the cursor.
    const nextBefore =
      windows.length === limit && windows.length > 0
        ? windows[windows.length - 1]!.windowStart
        : null;
    return { windows: view, nextBefore };
  }

  async fetchView(now = Date.now()): Promise<SharedView> {
    const key = await this.currentKey(now);
    if (this.cache?.key === key) return this.cache.view;
    // With a window, a recompute reads no ledger rows from storage (the mirror
    // holds them; only the tiny roster is fetched) — without one, full scan.
    const view = this.window
      ? assembleSharedView(
          { ...(await this.window.rows(now)), users: await this.storage.getUsers() },
          now
        )
      : await computeSharedView(this.storage, now);
    this.cache = { key, view };
    return view;
  }

  async close(): Promise<void> {
    await this.storage.close();
  }
}
