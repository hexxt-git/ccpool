// ── domain types ──────────────────────────────────────────────────────────────
// Pure data. No I/O, no UI, no process concerns. Shared by every package.

/** Anthropic reports three independent caps, each with its own reset clock. */
export type CapKind = "five_hour" | "seven_day" | "seven_day_opus";

export const CAP_KINDS: readonly CapKind[] = ["five_hour", "seven_day", "seven_day_opus"];

/** The reserved name that absorbs unattributed activity. */
export const UNKNOWN_USER = "unknown";

/** Names are the only identity. Alphanumeric + hyphens so they're safe as keys. */
export const NAME_PATTERN = /^[A-Za-z0-9-]+$/;

export function isValidName(name: string): boolean {
  if (!NAME_PATTERN.test(name)) return false;
  // `unknown` is the reserved row that absorbs unattributed usage — a real person
  // can't claim it, or their share would silently merge into the unknown bucket.
  // Case-insensitive: "Unknown" rendered next to "unknown" would be just as confusing.
  return name.toLowerCase() !== UNKNOWN_USER;
}

/** A participant in the shared ledger. Identity is just a name. */
export interface User {
  name: string;
  createdAt: string; // ISO 8601
}

/**
 * A single reading of one account-wide cap, as returned by the usage endpoint.
 * `pct` is authoritative; never estimate it from tokens.
 */
export interface UsageSample {
  cap: CapKind;
  pct: number; // 0..100
  resetsAt: string | null; // ISO 8601; unreliable for reset detection
  capturedAt: string; // ISO 8601, when the daemon read it
}

/** Recorded when a cap's pct drops vs the last stored reading (a reset). */
export interface ResetEvent {
  cap: CapKind;
  at: string; // ISO 8601, when the drop was observed
  previousPct: number;
}

/**
 * One attributable Claude Code message, credited to the active name at ingest.
 * Cache fields are reliable; raw input/output undercount — kept but flagged.
 */
export interface MessageUsage {
  uuid: string; // PK; dedup key across files
  user: string; // active name at ingest, or UNKNOWN_USER
  timestamp: string; // ISO 8601 from the transcript
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/**
 * A daemon-emitted **activity marker**: this machine observed the tank rise while
 * *its own* user was actively driving Claude Code, yet no transcript usage line
 * landed in that interval. That gap is real local work whose token cost the
 * transcript doesn't reflect in time — an endpoint-lagged tail of a heavy session,
 * or a resume/compaction re-prime that rebuilds a cold cache. The marker lets
 * attribution credit the otherwise-unexplained rise to that user instead of
 * `unknown`, but only as a **fallback**: any real {@link MessageUsage} in the same
 * interval always wins, so a marker can never dilute measured attribution (§7).
 */
export interface UsageMarker {
  id: string; // PK; dedup key
  user: string; // the active name on this machine when the rise was seen
  at: string; // ISO 8601 — the sample instant the rise was observed (tick time)
  model: string | null; // model of the recent local activity (for opus filtering)
  /** Relative weight if two machines both mark the same empty interval. */
  weight: number;
}

/** Per-name share of one window, apportioned across the header percentage. */
export interface UserShare {
  user: string;
  cap: CapKind;
  /** This name's slice of the window's overall percentage. Rows sum to the tank. */
  pct: number;
}

/** Optional fair-share target, keyed by name. */
export interface Budget {
  name: string;
  cap: CapKind;
  sharePct: number; // 0..100, this name's allotment of the window
}

// ── storage inspection ────────────────────────────────────────────────────────

/** Result of inspecting a target database before init. */
export type DbInspection =
  | { kind: "empty" } // zero tables -> prompt to init
  | {
      kind: "ccshare"; // ours -> join (maybe migrate)
      schemaVersion: number;
      /**
       * The Claude account this ledger is bound to (`oauthAccount.accountUuid`),
       * or null when unbound (pre-v2 DB, or created before onboarding). A daemon
       * observing a *different* account must not write here — see §1.5.
       */
      accountId: string | null;
    }
  | { kind: "foreign" }; // has tables, not ours -> refuse

// ── config ────────────────────────────────────────────────────────────────────

export type StorageDriver = "libsql" | "postgres" | "sqlite" | "memory";

export interface StorageConfig {
  driver: StorageDriver;
  url: string;
  /** Token lives in the OS keychain or a 0600 file, never in committed config. */
  token?: string;
}

export interface Config {
  storage: StorageConfig;
  /** Active user; alphanumeric + hyphens. Changeable with `config set name`. */
  name: string;
  pollIntervalMs: number;
  configDirs: string[];
  logLevel: "debug" | "info" | "warn" | "error";
}

// ── state.json (local snapshot, written atomically by the daemon) ──────────────

/** The local account's latest snapshot, for fast/no-network reads. */
export interface LocalState {
  updatedAt: string; // ISO 8601
  account: {
    id: string | null; // oauthAccount uuid/email, never the person
    tokenExpired: boolean;
    /**
     * True when this machine's Claude account differs from the account the shared
     * DB is bound to. The daemon halts all ledger writes while this holds, and the
     * views surface it — a mismatch would interleave two different tanks (§1.5).
     */
    conflict?: boolean;
  };
  samples: UsageSample[]; // latest per cap from this machine's poll
  daemon: {
    pid: number;
    startedAt: string;
  };
}
