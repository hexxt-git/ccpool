import type {
  CapKind,
  DbInspection,
  HistoryShare,
  HistoryWindow,
  MessageUsage,
  ResetEvent,
  TickBatch,
  UsageMarker,
  User,
  UsageSample,
} from "../types.js";

/**
 * The schema version this build understands.
 *
 * v1 — the relational baseline. One physical database holds every group's ledger;
 * a `group_id` column on every table (and in the composite keys/indexes) scopes
 * the rows to a group, so a single Postgres or libSQL database backs the whole
 * multi-tenant server. Tables: `ccshare_meta` (per group — the account-binding
 * `accountId`, the change-detection `writeSeq`, `schemaVersion`), `users`,
 * `usage_samples`, `message_usage`, `usage_markers`, `reset_events`. Samples and
 * resets dedup on `(group_id, cap, capturedAt)` / `(group_id, cap, at)`, messages
 * on `(group_id, uuid)`, markers on `(group_id, id)`, so a retried tick can never
 * double-insert.
 *
 * When a future change needs one, bump this and add an additive, idempotent step
 * to each adapter's `migrate` (nullable columns / `CREATE … IF NOT EXISTS`), per
 * the migration rules in CLAUDE.md.
 */
export const SCHEMA_VERSION = 1;

/** The group a storage instance with no explicit group is scoped to. */
export const DEFAULT_GROUP_ID = "default";

/**
 * The one boundary that must stay strict: adapters are interchangeable behind
 * this interface. Async even where local SQLite is synchronous, so a remote
 * adapter fits unchanged. Adapters are dumb — rows in, rows out, no business
 * logic; attribution and view assembly live above this line.
 *
 * **Every instance is scoped to one `groupId`** (bound at construction, injected
 * into every query as `group_id`). All rows a single instance reads or writes
 * belong to its group; the server opens one instance per group over one shared
 * database. The interface below is unchanged by that — callers see a single
 * ledger.
 */
export interface Storage {
  // lifecycle / setup
  inspect(): Promise<DbInspection>; // empty | ccshare (for this group)
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

  // history — immutable summaries of completed cap cycles (ADR-0002/0005)

  /**
   * Persist one frozen window and its per-member shares **atomically** and
   * **idempotently** on `(cap, windowStart)`: a window is written exactly once at
   * freeze time and never mutated, so a re-record is a no-op (the first write
   * wins, like the ledger's retried-tick rule). Bumps the change token once.
   */
  recordHistoryWindow(window: HistoryWindow, shares: HistoryShare[]): Promise<void>;

  /**
   * Closed windows for one cap, **newest first** (`windowStart` DESC). `before`
   * is an exclusive cursor (return windows strictly older than it) for paging;
   * `limit` caps the page (adapter default when omitted). Backs `ccshare history`
   * and the TUI matrix — retention is unbounded (Q6), so callers always page.
   */
  getHistoryWindows(
    cap: CapKind,
    opts?: { before?: string; limit?: number }
  ): Promise<HistoryWindow[]>;

  /** The per-member shares of one closed window (its expansion in the TUI). */
  getHistoryShares(cap: CapKind, windowStart: string): Promise<HistoryShare[]>;
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
