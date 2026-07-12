import type { CapKind, SharedView, TickBatch, UsageSample } from "../types.js";
import type { Storage } from "../storage/storage.js";
import { isEmptyBatch, SCHEMA_VERSION } from "../storage/storage.js";
import type { HistoryPage, HistoryQuery, HistoryWindowView } from "../types.js";
import {
  assembleSharedView,
  computeSharedView,
  RETENTION_MS,
  viewCacheKey,
} from "../state/view.js";
import { HistoryFinalizer } from "./finalizer.js";
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
 * Reduces a daemon's raw per-tick samples to the **monotonic usage envelope** —
 * the only thing attribution consumes. A sample is kept only when it raises the
 * running max for its cap within the current window; flat readings and dips
 * (clock-skew wobble) are dropped, so per-member streams collapse into one
 * canonical trajectory. A recorded reset restarts the cap's envelope, keeping the
 * post-reset baseline. Stateful per sink, seeded from `getLatestSamples()` across
 * (re)opens.
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
  /**
   * The group's shared history finalizer. Inject the same instance the read path
   * ticks so windows freeze from whichever side sees activity first; omitted, the
   * sink builds a private one from `graceMs`/`finalizeIntervalMs`/`retentionMs`.
   */
  finalizer?: HistoryFinalizer;
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
  private readonly now: () => number;
  private readonly window: LedgerWindow | undefined;
  private readonly finalizer: HistoryFinalizer;
  private readonly envelope = new EnvelopeFilter();

  constructor(
    private readonly storage: Storage,
    opts: StorageIngestSinkOptions = {}
  ) {
    this.retentionMs = opts.retentionMs ?? RETENTION_MS;
    this.pruneIntervalMs = opts.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.window = opts.window;
    this.finalizer =
      opts.finalizer ??
      new HistoryFinalizer(storage, {
        graceMs: opts.graceMs,
        finalizeIntervalMs: opts.finalizeIntervalMs,
        retentionMs: opts.retentionMs,
        now: opts.now,
      });
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
    if (info.kind !== "ccpool") {
      throw new Error(`not a ccpool database (${info.kind}) — run \`ccpool init\``);
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
    // Defensive re-check of the "Account binding" section (the daemon already compares against its
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
    // here — so no-op ticks cost no write and no change-token bump (report-on-change).
    const reduced = this.envelope.filter(batch);
    if (!isEmptyBatch(reduced)) {
      await this.storage.recordBatch(reduced);
      // Mirror the committed rows into the in-memory window (never before the
      // commit — a failed batch is retained and re-sent by the daemon).
      this.window?.append(reduced);
    }

    const now = this.now();
    await this.finalizer.maybeFinalize(now);
    if (now - this.lastPruneMs >= this.pruneIntervalMs) {
      this.lastPruneMs = now;
      const before = new Date(now - this.retentionMs).toISOString();
      await this.storage.prune(before);
      this.window?.applyPrune(before);
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
    // All the page's shares in ONE query (not one per window), grouped in memory.
    const shares = await this.storage.getHistorySharesForWindows(
      query.cap,
      windows.map((w) => w.windowStart)
    );
    const byWindow = new Map<string, { user: string; pct: number }[]>();
    for (const s of shares) {
      const arr = byWindow.get(s.windowStart);
      if (arr) arr.push({ user: s.user, pct: s.pct });
      else byWindow.set(s.windowStart, [{ user: s.user, pct: s.pct }]);
    }
    const view: HistoryWindowView[] = windows.map((w) => ({
      cap: w.cap,
      windowStart: w.windowStart,
      windowEnd: w.windowEnd,
      overall: w.overall,
      shares: byWindow.get(w.windowStart) ?? [],
    }));
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
