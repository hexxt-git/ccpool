import type {
  DbInspection,
  MessageUsage,
  ResetEvent,
  TickBatch,
  UsageMarker,
  User,
  UsageSample,
} from "../types.js";

/**
 * The schema version this CLI understands.
 *
 * v1 — the baseline: `ccshare_meta` (with the account-binding `accountId` and the
 * change-detection `writeSeq`), `users`, `usage_samples`, `message_usage`,
 * `usage_markers`, `reset_events` (indexed on `at`), created up front by
 * `initializeSchema`. (Redefined pre-production: the retired `budgets` table is
 * gone, `writeSeq` and the reset index are in.)
 *
 * v2 — makes `usage_samples` and `reset_events` idempotent on their natural keys
 * (`(cap, capturedAt)` and `(cap, at)`), so a retried tick can't double-insert
 * them. Before v2 only `message_usage`/`usage_markers` deduped (uuid/id), so an
 * at-least-once re-send (server committed but the response was lost) duplicated
 * samples/resets — polluting the tank trajectory and reset detection. The v2
 * `migrate` step drops any pre-existing duplicates, then adds the unique indexes.
 *
 * When a future change needs one, bump this and add an additive, idempotent step
 * to each adapter's `migrate` (nullable columns / `CREATE … IF NOT EXISTS`), per
 * the migration rules in CLAUDE.md.
 */
export const SCHEMA_VERSION = 2;

/**
 * The one boundary that must stay strict: adapters are interchangeable behind
 * this interface. Async even where local SQLite is synchronous, so a remote
 * adapter fits unchanged. Adapters are dumb — rows in, rows out, no business
 * logic; attribution and view assembly live above this line.
 */
export interface Storage {
  // lifecycle / setup
  inspect(): Promise<DbInspection>; // empty | ccshare | foreign
  /** Create tables + write ccshare_meta, binding the ledger to `accountId` (§1.5). */
  initializeSchema(accountId?: string | null): Promise<void>;
  /** Claim an unbound ledger for `accountId` (only sets it when currently null). */
  bindAccount(accountId: string): Promise<void>;
  migrate(toVersion: number): Promise<void>;
  close(): Promise<void>;

  // participants — identity is just a name (alphanumeric + hyphens)
  upsertUser(name: string): Promise<void>; // bumps the change token
  getUsers(): Promise<User[]>;

  /**
   * Persist one daemon tick atomically: every row inserted idempotently —
   * samples on `(cap, capturedAt)`, resets on `(cap, at)`, messages on `uuid`,
   * markers on `id` — and the change token bumped once. Idempotency is what makes
   * a retried tick (server committed but the response was lost) safe to re-send.
   * The only ledger write path besides `upsertUser`.
   */
  recordBatch(batch: TickBatch): Promise<void>;

  /**
   * Retention: delete samples, resets, messages, and markers older than `before`
   * (ISO 8601). Everything the view needs lives inside the widest cap window, so
   * pruning past it keeps every table bounded without touching attribution.
   */
  prune(before: string): Promise<void>;

  /**
   * Opaque change token: differs whenever ledger data changed, constant when it
   * didn't. A single-row read — the cheap thing a 2s view refresh may poll so the
   * heavy window queries only run when something actually changed.
   */
  getChangeToken(): Promise<string>;

  // reads
  getLatestSamples(): Promise<UsageSample[]>;
  /** The tank trajectory since `since` (all caps, ascending) — drives attribution. */
  getUsageSamplesSince(since: string): Promise<UsageSample[]>;
  /** Recorded resets since `since` (all caps) — bound the attribution window. */
  getResetsSince(since: string): Promise<ResetEvent[]>;
  /** Raw measured Code activity since `since`, for time-correlated attribution. */
  getMessageUsageSince(since: string): Promise<MessageUsage[]>;
  /** Activity markers since `since` — fill rises with no measured activity (§7). */
  getUsageMarkersSince(since: string): Promise<UsageMarker[]>;
}

/** An empty batch — convenient default; recording it is a no-op for adapters. */
export function emptyBatch(): TickBatch {
  return { samples: [], resets: [], messages: [], markers: [] };
}

/** True when a batch holds nothing to persist (adapters may skip the write). */
export function isEmptyBatch(b: TickBatch): boolean {
  return (
    b.samples.length === 0 &&
    b.resets.length === 0 &&
    b.messages.length === 0 &&
    b.markers.length === 0
  );
}
