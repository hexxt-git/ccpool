import type { SharedView, TickBatch } from "../types.js";
import type { Storage } from "../storage/storage.js";
import { isEmptyBatch, SCHEMA_VERSION } from "../storage/storage.js";
import {
  assembleSharedView,
  computeSharedView,
  RETENTION_MS,
  viewCacheKey,
} from "../state/view.js";
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

export interface StorageIngestSinkOptions {
  /** Rows older than this are swept on the next throttled prune. */
  retentionMs?: number;
  pruneIntervalMs?: number;
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
  private readonly now: () => number;
  private readonly window: LedgerWindow | undefined;

  constructor(
    private readonly storage: Storage,
    opts: StorageIngestSinkOptions = {}
  ) {
    this.retentionMs = opts.retentionMs ?? RETENTION_MS;
    this.pruneIntervalMs = opts.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.window = opts.window;
    // Start the retention clock at construction, not the epoch. A sink is rebuilt
    // on every (re)open — a daemon restart, or the server reopening an
    // LRU-evicted tenant — and a 0 here would make the very first ingest prune
    // immediately. Under tenant churn that turns prune (4 DELETEs + a change-token
    // bump that moves the view ETag) into near-per-ingest work instead of the
    // intended once-per-interval sweep.
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
    return { accountId: info.accountId, samples: await this.storage.getLatestSamples() };
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
    if (!isEmptyBatch(batch)) {
      await this.storage.recordBatch(batch);
      // Mirror the committed rows into the in-memory window (never before the
      // commit — a failed batch is retained and re-sent by the daemon).
      this.window?.append(batch);
    }

    const now = this.now();
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
