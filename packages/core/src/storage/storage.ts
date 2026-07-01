import type {
  Budget,
  CapKind,
  DbInspection,
  MessageUsage,
  ResetEvent,
  UsageMarker,
  User,
  UsageSample,
} from "../types.js";

/**
 * The current schema version this CLI understands.
 * v2 added `ccshare_meta.accountId` — the Claude account the ledger is bound to,
 * so a daemon on a different account can be refused rather than silently mixing
 * two tanks into one `usage_samples` table.
 * v3 added the `usage_markers` table — daemon activity markers that let attribution
 * credit an otherwise-unexplained local tank rise (endpoint lag, resume re-prime)
 * to the machine's user instead of `unknown` (§7).
 */
export const SCHEMA_VERSION = 3;

/**
 * The one boundary that must stay strict: adapters are interchangeable behind
 * this interface. Async even where local SQLite is synchronous, so a remote
 * adapter fits unchanged.
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
  upsertUser(name: string): Promise<void>;
  getUsers(): Promise<User[]>;

  // shared tank (account-scoped truth)
  recordUsageSample(s: UsageSample): Promise<void>;
  getLatestSamples(): Promise<UsageSample[]>;
  /** The tank trajectory since `since` (all caps, ascending) — drives attribution. */
  getUsageSamplesSince(since: string): Promise<UsageSample[]>;
  recordReset(e: ResetEvent): Promise<void>;
  /** Recorded resets since `since` (all caps) — bound the attribution window. */
  getResetsSince(since: string): Promise<ResetEvent[]>;

  // per-person attribution (Code surface; batch + idempotent on uuid)
  recordMessageUsage(rows: MessageUsage[]): Promise<void>;
  /** Raw measured Code activity since `since`, for time-correlated attribution. */
  getMessageUsageSince(since: string): Promise<MessageUsage[]>;

  // daemon activity markers (fallback attribution; idempotent on id)
  recordUsageMarker(m: UsageMarker): Promise<void>;
  /** Activity markers since `since` — fill rises with no measured activity (§7). */
  getUsageMarkersSince(since: string): Promise<UsageMarker[]>;

  // optional budgets, keyed by name
  setBudget(name: string, cap: CapKind, sharePct: number): Promise<void>;
  getBudgets(): Promise<Budget[]>;
}
