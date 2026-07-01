import postgres, { type Sql } from "postgres";
import { randomUUID } from "node:crypto";
import {
  CAP_KINDS,
  SCHEMA_VERSION,
  UNKNOWN_USER,
  type Budget,
  type CapKind,
  type DbInspection,
  type MessageUsage,
  type ResetEvent,
  type Storage,
  type UsageMarker,
  type UsageSample,
  type User,
} from "@ccshare/core";

export const DRIVER = "postgres" as const;

/**
 * Second Storage adapter, proving the boundary: flipping `storage.driver` moves a
 * group to Postgres with no call-site changes. camelCase columns are quoted so
 * Postgres preserves their case (and `"user"` is a reserved word).
 */
export class PostgresStorage implements Storage {
  private sql: Sql;

  constructor(url: string) {
    this.sql = postgres(url, { onnotice: () => {} });
  }

  async inspect(): Promise<DbInspection> {
    const rows = await this.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema()`;
    const tables = new Set(rows.map((r) => r.table_name));
    if (tables.size === 0) return { kind: "empty" };
    if (tables.has("ccshare_meta")) {
      // SELECT * so a pre-v2 DB without `accountId` still reads (undefined key).
      const meta = await this.sql<
        { schemaVersion: number; accountId?: string | null }[]
      >`SELECT * FROM ccshare_meta LIMIT 1`;
      return {
        kind: "ccshare",
        schemaVersion: Number(meta[0]?.schemaVersion ?? SCHEMA_VERSION),
        accountId: meta[0]?.accountId ?? null,
      };
    }
    return { kind: "foreign" };
  }

  async initializeSchema(accountId: string | null = null): Promise<void> {
    if ((await this.inspect()).kind === "foreign") {
      throw new Error("refusing to initialize schema over a foreign database");
    }
    await this.sql.begin(async (tx) => {
      await tx`CREATE TABLE IF NOT EXISTS ccshare_meta (
        app TEXT NOT NULL, "schemaVersion" INTEGER NOT NULL,
        "projectId" TEXT NOT NULL, "createdAt" TEXT NOT NULL, "accountId" TEXT)`;
      await tx`CREATE TABLE IF NOT EXISTS users (
        name TEXT PRIMARY KEY, "createdAt" TEXT NOT NULL)`;
      await tx`CREATE TABLE IF NOT EXISTS usage_samples (
        cap TEXT NOT NULL, pct DOUBLE PRECISION NOT NULL,
        "resetsAt" TEXT, "capturedAt" TEXT NOT NULL)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_usage_samples_cap
        ON usage_samples (cap, "capturedAt")`;
      await tx`CREATE TABLE IF NOT EXISTS message_usage (
        uuid TEXT PRIMARY KEY, "user" TEXT NOT NULL, timestamp TEXT NOT NULL, model TEXT,
        "inputTokens" BIGINT NOT NULL, "outputTokens" BIGINT NOT NULL,
        "cacheCreationTokens" BIGINT NOT NULL, "cacheReadTokens" BIGINT NOT NULL)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_message_usage_ts
        ON message_usage (timestamp)`;
      await tx`CREATE TABLE IF NOT EXISTS usage_markers (
        id TEXT PRIMARY KEY, "user" TEXT NOT NULL, at TEXT NOT NULL, model TEXT,
        weight DOUBLE PRECISION NOT NULL)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_usage_markers_at
        ON usage_markers (at)`;
      await tx`CREATE TABLE IF NOT EXISTS reset_events (
        cap TEXT NOT NULL, at TEXT NOT NULL, "previousPct" DOUBLE PRECISION NOT NULL)`;
      await tx`CREATE TABLE IF NOT EXISTS budgets (
        name TEXT NOT NULL, cap TEXT NOT NULL, "sharePct" DOUBLE PRECISION NOT NULL,
        PRIMARY KEY (name, cap))`;
      await tx`INSERT INTO ccshare_meta (app, "schemaVersion", "projectId", "createdAt", "accountId")
        VALUES ('ccshare', ${SCHEMA_VERSION}, ${randomUUID()}, ${new Date().toISOString()}, ${accountId})`;
    });
  }

  async bindAccount(accountId: string): Promise<void> {
    // Claim only when currently unbound, so we never overwrite an existing binding.
    await this.sql`UPDATE ccshare_meta SET "accountId" = ${accountId} WHERE "accountId" IS NULL`;
  }

  async migrate(toVersion: number): Promise<void> {
    // v1 -> v2: add the account-binding column (idempotent).
    await this.sql`ALTER TABLE ccshare_meta ADD COLUMN IF NOT EXISTS "accountId" TEXT`;
    // v2 -> v3: add the activity-markers table (idempotent).
    await this.sql`CREATE TABLE IF NOT EXISTS usage_markers (
      id TEXT PRIMARY KEY, "user" TEXT NOT NULL, at TEXT NOT NULL, model TEXT,
      weight DOUBLE PRECISION NOT NULL)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_usage_markers_at ON usage_markers (at)`;
    await this.sql`UPDATE ccshare_meta SET "schemaVersion" = ${toVersion}`;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async upsertUser(name: string): Promise<void> {
    await this.sql`INSERT INTO users (name, "createdAt")
      VALUES (${name}, ${new Date().toISOString()})
      ON CONFLICT (name) DO NOTHING`;
  }

  async getUsers(): Promise<User[]> {
    const rows = await this.sql<{ name: string; createdAt: string }[]>`
      SELECT name, "createdAt" FROM users ORDER BY name`;
    return rows.map((r) => ({ name: r.name, createdAt: r.createdAt }));
  }

  async recordUsageSample(s: UsageSample): Promise<void> {
    await this.sql`INSERT INTO usage_samples (cap, pct, "resetsAt", "capturedAt")
      VALUES (${s.cap}, ${s.pct}, ${s.resetsAt}, ${s.capturedAt})`;
  }

  async getLatestSamples(): Promise<UsageSample[]> {
    const rows = await this.sql<
      { cap: string; pct: number; resetsAt: string | null; capturedAt: string }[]
    >`SELECT DISTINCT ON (cap) cap, pct, "resetsAt", "capturedAt"
      FROM usage_samples ORDER BY cap, "capturedAt" DESC`;
    const byCap = new Map<CapKind, UsageSample>();
    for (const r of rows) {
      byCap.set(r.cap as CapKind, {
        cap: r.cap as CapKind,
        pct: Number(r.pct),
        resetsAt: r.resetsAt,
        capturedAt: r.capturedAt,
      });
    }
    return CAP_KINDS.map((c) => byCap.get(c)).filter((s): s is UsageSample => !!s);
  }

  async getUsageSamplesSince(since: string): Promise<UsageSample[]> {
    const rows = await this.sql<
      { cap: string; pct: number; resetsAt: string | null; capturedAt: string }[]
    >`SELECT cap, pct, "resetsAt", "capturedAt" FROM usage_samples
      WHERE "capturedAt" >= ${since} ORDER BY "capturedAt" ASC`;
    return rows.map((r) => ({
      cap: r.cap as CapKind,
      pct: Number(r.pct),
      resetsAt: r.resetsAt,
      capturedAt: r.capturedAt,
    }));
  }

  async recordReset(e: ResetEvent): Promise<void> {
    await this.sql`INSERT INTO reset_events (cap, at, "previousPct")
      VALUES (${e.cap}, ${e.at}, ${e.previousPct})`;
  }

  async getResetsSince(since: string): Promise<ResetEvent[]> {
    const rows = await this.sql<{ cap: string; at: string; previousPct: number }[]>`
      SELECT cap, at, "previousPct" FROM reset_events WHERE at >= ${since} ORDER BY at ASC`;
    return rows.map((r) => ({
      cap: r.cap as CapKind,
      at: r.at,
      previousPct: Number(r.previousPct),
    }));
  }

  async recordMessageUsage(rows: MessageUsage[]): Promise<void> {
    if (rows.length === 0) return;
    await this.sql.begin(async (tx) => {
      for (const m of rows) {
        await tx`INSERT INTO message_usage
          (uuid, "user", timestamp, model, "inputTokens", "outputTokens",
           "cacheCreationTokens", "cacheReadTokens")
          VALUES (${m.uuid}, ${m.user}, ${m.timestamp}, ${m.model},
            ${m.inputTokens}, ${m.outputTokens}, ${m.cacheCreationTokens}, ${m.cacheReadTokens})
          ON CONFLICT (uuid) DO NOTHING`;
      }
    });
  }

  async getMessageUsageSince(since: string): Promise<MessageUsage[]> {
    const rows = await this.sql<
      {
        uuid: string;
        user: string;
        timestamp: string;
        model: string | null;
        inputTokens: string;
        outputTokens: string;
        cacheCreationTokens: string;
        cacheReadTokens: string;
      }[]
    >`SELECT uuid, "user", timestamp, model, "inputTokens", "outputTokens",
             "cacheCreationTokens", "cacheReadTokens"
      FROM message_usage WHERE timestamp >= ${since}`;
    return rows.map((r) => ({
      uuid: r.uuid,
      user: r.user,
      timestamp: r.timestamp,
      model: r.model,
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      cacheCreationTokens: Number(r.cacheCreationTokens),
      cacheReadTokens: Number(r.cacheReadTokens),
    }));
  }

  async recordUsageMarker(m: UsageMarker): Promise<void> {
    await this.sql`INSERT INTO usage_markers (id, "user", at, model, weight)
      VALUES (${m.id}, ${m.user}, ${m.at}, ${m.model}, ${m.weight})
      ON CONFLICT (id) DO NOTHING`;
  }

  async getUsageMarkersSince(since: string): Promise<UsageMarker[]> {
    const rows = await this.sql<
      { id: string; user: string; at: string; model: string | null; weight: number }[]
    >`SELECT id, "user", at, model, weight FROM usage_markers WHERE at >= ${since}`;
    return rows.map((r) => ({
      id: r.id,
      user: r.user,
      at: r.at,
      model: r.model,
      weight: Number(r.weight),
    }));
  }

  async setBudget(name: string, cap: CapKind, sharePct: number): Promise<void> {
    await this.sql`INSERT INTO budgets (name, cap, "sharePct")
      VALUES (${name}, ${cap}, ${sharePct})
      ON CONFLICT (name, cap) DO UPDATE SET "sharePct" = EXCLUDED."sharePct"`;
  }

  async getBudgets(): Promise<Budget[]> {
    const rows = await this.sql<{ name: string; cap: string; sharePct: number }[]>`
      SELECT name, cap, "sharePct" FROM budgets ORDER BY name, cap`;
    return rows.map((r) => ({
      name: r.name,
      cap: r.cap as CapKind,
      sharePct: Number(r.sharePct),
    }));
  }
}

export { UNKNOWN_USER };
