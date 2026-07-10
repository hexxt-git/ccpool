/**
 * Idempotent DDL, shared by `LibsqlDatabase.init()` (run once at boot) and
 * `LibsqlStorage.initializeSchema` (per-group provisioning re-ensures it).
 * Tables are shared across groups; a `group_id` column scopes every row.
 */
export const LEDGER_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS ccshare_meta (
     group_id TEXT PRIMARY KEY,
     app TEXT NOT NULL,
     schemaVersion INTEGER NOT NULL,
     projectId TEXT NOT NULL,
     createdAt TEXT NOT NULL,
     accountId TEXT,
     writeSeq INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS users (
     group_id TEXT NOT NULL,
     name TEXT NOT NULL,
     createdAt TEXT NOT NULL,
     PRIMARY KEY (group_id, name)
   )`,
  `CREATE TABLE IF NOT EXISTS usage_samples (
     group_id TEXT NOT NULL,
     cap TEXT NOT NULL,
     pct REAL NOT NULL,
     resetsAt TEXT,
     capturedAt TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_samples_cap ON usage_samples (group_id, cap, capturedAt)`,
  `CREATE TABLE IF NOT EXISTS message_usage (
     group_id TEXT NOT NULL,
     uuid TEXT NOT NULL,
     user TEXT NOT NULL,
     timestamp TEXT NOT NULL,
     model TEXT,
     inputTokens INTEGER NOT NULL,
     outputTokens INTEGER NOT NULL,
     cacheCreationTokens INTEGER NOT NULL,
     cacheReadTokens INTEGER NOT NULL,
     PRIMARY KEY (group_id, uuid)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_message_usage_ts ON message_usage (group_id, timestamp)`,
  `CREATE TABLE IF NOT EXISTS usage_markers (
     group_id TEXT NOT NULL,
     id TEXT NOT NULL,
     user TEXT NOT NULL,
     at TEXT NOT NULL,
     model TEXT,
     weight REAL NOT NULL,
     PRIMARY KEY (group_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_usage_markers_at ON usage_markers (group_id, at)`,
  `CREATE TABLE IF NOT EXISTS reset_events (
     group_id TEXT NOT NULL,
     cap TEXT NOT NULL,
     at TEXT NOT NULL,
     previousPct REAL NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_reset_events_at ON reset_events (group_id, at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_reset_events_uniq ON reset_events (group_id, cap, at)`,
  // Immutable history of completed cap cycles (ADR-0002/0005). Retained unbounded.
  `CREATE TABLE IF NOT EXISTS history_windows (
     group_id TEXT NOT NULL,
     cap TEXT NOT NULL,
     windowStart TEXT NOT NULL,
     windowEnd TEXT NOT NULL,
     overall REAL NOT NULL,
     closedAt TEXT NOT NULL,
     PRIMARY KEY (group_id, cap, windowStart)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_history_windows_start ON history_windows (group_id, cap, windowStart)`,
  `CREATE TABLE IF NOT EXISTS history_shares (
     group_id TEXT NOT NULL,
     cap TEXT NOT NULL,
     windowStart TEXT NOT NULL,
     user TEXT NOT NULL,
     pct REAL NOT NULL,
     PRIMARY KEY (group_id, cap, windowStart, user)
   )`,
];

/** The registry tables (groups / members / tokens), same database. */
export const REGISTRY_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS groups (
     id TEXT PRIMARY KEY,
     accountId TEXT UNIQUE NOT NULL,
     passwordHash TEXT NOT NULL,
     createdAt TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS members (
     id TEXT PRIMARY KEY,
     groupId TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     passwordHash TEXT NOT NULL,
     createdAt TEXT NOT NULL,
     UNIQUE (groupId, name)
   )`,
  `CREATE TABLE IF NOT EXISTS tokens (
     tokenHash TEXT PRIMARY KEY,
     memberId TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
     createdAt TEXT NOT NULL,
     lastUsedAt TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tokens_member ON tokens (memberId)`,
];
