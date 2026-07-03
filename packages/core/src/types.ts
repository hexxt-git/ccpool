// ── domain types ──────────────────────────────────────────────────────────────
// Pure data. No I/O, no UI, no process concerns. Shared by every package.

/** Anthropic reports three independent caps, each with its own reset clock. */
export type CapKind = "five_hour" | "seven_day" | "seven_day_opus";

export const CAP_KINDS: readonly CapKind[] = ["five_hour", "seven_day", "seven_day_opus"];

/** The reserved name that absorbs unattributed activity. */
export const UNKNOWN_USER = "unknown";

/**
 * Names are the only identity. Alphanumeric + hyphens so they're safe as keys.
 * The negated character class (not an anchored `$`) is deliberate: `/^[…]+$/`
 * would also accept a trailing newline, since JS `$` matches before a final
 * `\n` without the `m` flag — enough to sneak "unknown\n" or a look-alike name
 * past validation. Testing for any disallowed char rejects newlines anywhere.
 */
export const NAME_DISALLOWED = /[^A-Za-z0-9-]/;

/**
 * Upper bound on a name's length. Names key the ledger and head the member
 * columns, so an unbounded name would bloat rows and wreck the TUI layout — the
 * server accepts whatever `isValidName` accepts, so the cap has to live here.
 */
export const MAX_NAME_LENGTH = 32;

export function isValidName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return false;
  if (NAME_DISALLOWED.test(name)) return false;
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

/**
 * Everything one daemon tick observed, persisted atomically as a single write.
 * `messages`/`markers` stay idempotent on uuid/id, so re-sending a batch (e.g. a
 * retry after a failed ingest) can never double-count.
 */
export interface TickBatch {
  samples: UsageSample[]; // 0..3 (empty when the poll was skipped or failed)
  resets: ResetEvent[];
  messages: MessageUsage[];
  markers: UsageMarker[];
}

// ── the shared view ───────────────────────────────────────────────────────────

/** Per-name rollup of measured Code activity: total tokens and last seen. */
export interface MemberSummary {
  user: string;
  /** input + output + cache (creation + read) across the window. */
  tokens: number;
  /** ISO 8601 of the most recent message, or null if none parsed. */
  lastActivityAt: string | null;
}

/**
 * The compact, precomputed shared picture — everything `status`/`tui` need from
 * the ledger, and the only thing that crosses the network in shared mode (a few
 * KB, never raw rows). Assembled by `computeSharedView`, cached by change token.
 */
export interface SharedView {
  generatedAt: string; // ISO 8601, when this view was computed
  samples: UsageSample[]; // latest per cap
  shares: UserShare[]; // per-person split of each cap window
  members: MemberSummary[]; // per-name measured activity (tokens, last seen)
  users: User[]; // the roster, so `ccshare users` works in both modes
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

/**
 * How this machine reaches the shared ledger:
 * - `shared`   — through the hosted HTTP server (two-password auth, bearer token).
 * - `selfhost` — directly against a storage adapter URL the group runs itself.
 */
export type Mode = "shared" | "selfhost";

export interface Config {
  mode: Mode;
  /** selfhost only: the adapter this machine talks to directly. */
  storage?: StorageConfig;
  /** shared only: the ccshare server. The bearer token lives in the 0600 token file. */
  server?: { url: string; token?: string };
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
