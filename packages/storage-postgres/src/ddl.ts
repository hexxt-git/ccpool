import type { TransactionSql } from "postgres";

/**
 * Idempotent DDL, shared by `PostgresDatabase.init()` (run once at boot) and
 * `PostgresStorage.initializeSchema` (per-group provisioning re-ensures it).
 * Tables are shared across groups; a `group_id` column scopes every row.
 * camelCase columns are quoted so Postgres preserves their case (and `"user"`
 * is a reserved word).
 */
export async function runLedgerDdl(tx: TransactionSql): Promise<void> {
  await tx`CREATE TABLE IF NOT EXISTS ccshare_meta (
    group_id TEXT PRIMARY KEY, app TEXT NOT NULL, "schemaVersion" INTEGER NOT NULL,
    "projectId" TEXT NOT NULL, "createdAt" TEXT NOT NULL, "accountId" TEXT,
    "writeSeq" BIGINT NOT NULL DEFAULT 0)`;
  await tx`CREATE TABLE IF NOT EXISTS users (
    group_id TEXT NOT NULL, name TEXT NOT NULL, "createdAt" TEXT NOT NULL,
    PRIMARY KEY (group_id, name))`;
  await tx`CREATE TABLE IF NOT EXISTS usage_samples (
    group_id TEXT NOT NULL, cap TEXT NOT NULL, pct DOUBLE PRECISION NOT NULL,
    "resetsAt" TEXT, "capturedAt" TEXT NOT NULL)`;
  await tx`CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_samples_cap
    ON usage_samples (group_id, cap, "capturedAt")`;
  await tx`CREATE TABLE IF NOT EXISTS message_usage (
    group_id TEXT NOT NULL, uuid TEXT NOT NULL, "user" TEXT NOT NULL,
    timestamp TEXT NOT NULL, model TEXT,
    "inputTokens" BIGINT NOT NULL, "outputTokens" BIGINT NOT NULL,
    "cacheCreationTokens" BIGINT NOT NULL, "cacheReadTokens" BIGINT NOT NULL,
    PRIMARY KEY (group_id, uuid))`;
  await tx`CREATE INDEX IF NOT EXISTS idx_message_usage_ts
    ON message_usage (group_id, timestamp)`;
  await tx`CREATE TABLE IF NOT EXISTS usage_markers (
    group_id TEXT NOT NULL, id TEXT NOT NULL, "user" TEXT NOT NULL, at TEXT NOT NULL,
    model TEXT, weight DOUBLE PRECISION NOT NULL, PRIMARY KEY (group_id, id))`;
  await tx`CREATE INDEX IF NOT EXISTS idx_usage_markers_at
    ON usage_markers (group_id, at)`;
  await tx`CREATE TABLE IF NOT EXISTS reset_events (
    group_id TEXT NOT NULL, cap TEXT NOT NULL, at TEXT NOT NULL,
    "previousPct" DOUBLE PRECISION NOT NULL)`;
  await tx`CREATE INDEX IF NOT EXISTS idx_reset_events_at
    ON reset_events (group_id, at)`;
  await tx`CREATE UNIQUE INDEX IF NOT EXISTS idx_reset_events_uniq
    ON reset_events (group_id, cap, at)`;
  // Immutable history of completed cap cycles (ADR-0002/0005). Retained unbounded.
  await tx`CREATE TABLE IF NOT EXISTS history_windows (
    group_id TEXT NOT NULL, cap TEXT NOT NULL, "windowStart" TEXT NOT NULL,
    "windowEnd" TEXT NOT NULL, overall DOUBLE PRECISION NOT NULL, "closedAt" TEXT NOT NULL,
    PRIMARY KEY (group_id, cap, "windowStart"))`;
  await tx`CREATE INDEX IF NOT EXISTS idx_history_windows_start
    ON history_windows (group_id, cap, "windowStart")`;
  await tx`CREATE TABLE IF NOT EXISTS history_shares (
    group_id TEXT NOT NULL, cap TEXT NOT NULL, "windowStart" TEXT NOT NULL,
    "user" TEXT NOT NULL, pct DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (group_id, cap, "windowStart", "user"))`;
}

/** The registry tables (groups / members / tokens), same database. */
export async function runRegistryDdl(tx: TransactionSql): Promise<void> {
  await tx`CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    "accountId" TEXT UNIQUE NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL)`;
  await tx`CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    "groupId" TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    UNIQUE ("groupId", name))`;
  await tx`CREATE TABLE IF NOT EXISTS tokens (
    "tokenHash" TEXT PRIMARY KEY,
    "memberId" TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    "createdAt" TEXT NOT NULL,
    "lastUsedAt" TEXT)`;
  await tx`CREATE INDEX IF NOT EXISTS idx_tokens_member ON tokens ("memberId")`;
}
