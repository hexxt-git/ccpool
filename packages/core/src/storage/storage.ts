import type {
  Budget,
  CapKind,
  DbInspection,
  MessageUsage,
  ResetEvent,
  User,
  UsageSample,
  UserShare,
} from "../types.js";

/** The current schema version this CLI understands. */
export const SCHEMA_VERSION = 1;

/**
 * The one boundary that must stay strict: adapters are interchangeable behind
 * this interface. Async even where local SQLite is synchronous, so a remote
 * adapter fits unchanged.
 */
export interface Storage {
  // lifecycle / setup
  inspect(): Promise<DbInspection>; // empty | ccshare | foreign
  initializeSchema(): Promise<void>; // create tables + write ccshare_meta
  migrate(toVersion: number): Promise<void>;
  close(): Promise<void>;

  // participants — identity is just a name (alphanumeric + hyphens)
  upsertUser(name: string): Promise<void>;
  getUsers(): Promise<User[]>;

  // shared tank (account-scoped truth)
  recordUsageSample(s: UsageSample): Promise<void>;
  getLatestSamples(): Promise<UsageSample[]>;
  recordReset(e: ResetEvent): Promise<void>;

  // per-person attribution (Code surface; batch + idempotent on uuid)
  recordMessageUsage(rows: MessageUsage[]): Promise<void>;
  getShareSince(since: string): Promise<UserShare[]>; // per name, incl. "unknown"

  // optional budgets, keyed by name
  setBudget(name: string, cap: CapKind, sharePct: number): Promise<void>;
  getBudgets(): Promise<Budget[]>;
}
