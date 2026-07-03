import postgres, { type Sql } from "postgres";
import { randomUUID } from "node:crypto";
import {
  CAP_KINDS,
  isEmptyBatch,
  SCHEMA_VERSION,
  UNKNOWN_USER,
  type CapKind,
  type DbInspection,
  type MessageUsage,
  type ResetEvent,
  type Storage,
  type TickBatch,
  type UsageMarker,
  type UsageSample,
  type User,
} from "@ccshare/core";

export const DRIVER = "postgres" as const;

export interface PostgresStorageOptions {
  /**
   * Confine this instance to a named schema (its `search_path`). The multi-tenant
   * server gives every group its own schema and reuses this adapter unchanged.
   */
  schema?: string;
  /** Pool size — the server keeps this small (many tenants, one pool each). */
  max?: number;
  /** Seconds an idle pooled connection lives before being reaped. */
  idleTimeoutSecs?: number;
}

/**
 * Second Storage adapter, proving the boundary: flipping `storage.driver` moves a
 * group to Postgres with no call-site changes. camelCase columns are quoted so
 * Postgres preserves their case (and `"user"` is a reserved word).
 */
export class PostgresStorage implements Storage {
  private sql: Sql;

  constructor(url: string, opts: PostgresStorageOptions = {}) {
    this.sql = postgres(url, {
      onnotice: () => {},
      ...(opts.schema ? { connection: { search_path: opts.schema } } : {}),
      ...(opts.max !== undefined ? { max: opts.max } : {}),
      ...(opts.idleTimeoutSecs !== undefined ? { idle_timeout: opts.idleTimeoutSecs } : {}),
    });
  }

  async inspect(): Promise<DbInspection> {
    const rows = await this.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema()`;
    const tables = new Set(rows.map((r) => r.table_name));
    if (tables.size === 0) return { kind: "empty" };
    if (tables.has("ccshare_meta")) {
      // SELECT * so a DB from another build still reads (missing key -> undefined).
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
        "projectId" TEXT NOT NULL, "createdAt" TEXT NOT NULL, "accountId" TEXT,
        "writeSeq" BIGINT NOT NULL DEFAULT 0)`;
      await tx`CREATE TABLE IF NOT EXISTS users (
        name TEXT PRIMARY KEY, "createdAt" TEXT NOT NULL)`;
      await tx`CREATE TABLE IF NOT EXISTS usage_samples (
        cap TEXT NOT NULL, pct DOUBLE PRECISION NOT NULL,
        "resetsAt" TEXT, "capturedAt" TEXT NOT NULL)`;
      await tx`CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_samples_cap
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
      await tx`CREATE INDEX IF NOT EXISTS idx_reset_events_at
        ON reset_events (at)`;
      await tx`CREATE UNIQUE INDEX IF NOT EXISTS idx_reset_events_uniq
        ON reset_events (cap, at)`;
      await tx`INSERT INTO ccshare_meta (app, "schemaVersion", "projectId", "createdAt", "accountId", "writeSeq")
        VALUES ('ccshare', ${SCHEMA_VERSION}, ${randomUUID()}, ${new Date().toISOString()}, ${accountId}, 0)`;
    });
  }

  async bindAccount(accountId: string): Promise<void> {
    // Claim only when currently unbound, so we never overwrite an existing binding.
    await this.sql`UPDATE ccshare_meta SET "accountId" = ${accountId} WHERE "accountId" IS NULL`;
  }

  async migrate(toVersion: number): Promise<void> {
    // v2: make usage_samples/reset_events idempotent on their natural keys.
    // Additive and idempotent — dedup any rows an older build's retries may have
    // duplicated (keep the earliest physical row by ctid), then add the unique
    // indexes. The old non-unique idx_usage_samples_cap is dropped so its name can
    // be reused for the unique one. Safe to run more than once.
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM usage_samples a USING usage_samples b
        WHERE a.ctid < b.ctid AND a.cap = b.cap AND a."capturedAt" = b."capturedAt"`;
      await tx`DROP INDEX IF EXISTS idx_usage_samples_cap`;
      await tx`CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_samples_cap
        ON usage_samples (cap, "capturedAt")`;
      await tx`DELETE FROM reset_events a USING reset_events b
        WHERE a.ctid < b.ctid AND a.cap = b.cap AND a.at = b.at`;
      await tx`CREATE UNIQUE INDEX IF NOT EXISTS idx_reset_events_uniq
        ON reset_events (cap, at)`;
      await tx`UPDATE ccshare_meta SET "schemaVersion" = ${toVersion}`;
    });
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async upsertUser(name: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`INSERT INTO users (name, "createdAt")
        VALUES (${name}, ${new Date().toISOString()})
        ON CONFLICT (name) DO NOTHING`;
      await tx`UPDATE ccshare_meta SET "writeSeq" = "writeSeq" + 1`;
    });
  }

  async getUsers(): Promise<User[]> {
    const rows = await this.sql<{ name: string; createdAt: string }[]>`
      SELECT name, "createdAt" FROM users ORDER BY name`;
    return rows.map((r) => ({ name: r.name, createdAt: r.createdAt }));
  }

  async recordBatch(batch: TickBatch): Promise<void> {
    if (isEmptyBatch(batch)) return;
    await this.sql.begin(async (tx) => {
      for (const s of batch.samples) {
        await tx`INSERT INTO usage_samples (cap, pct, "resetsAt", "capturedAt")
          VALUES (${s.cap}, ${s.pct}, ${s.resetsAt}, ${s.capturedAt})
          ON CONFLICT (cap, "capturedAt") DO NOTHING`;
      }
      for (const e of batch.resets) {
        await tx`INSERT INTO reset_events (cap, at, "previousPct")
          VALUES (${e.cap}, ${e.at}, ${e.previousPct})
          ON CONFLICT (cap, at) DO NOTHING`;
      }
      for (const m of batch.messages) {
        await tx`INSERT INTO message_usage
          (uuid, "user", timestamp, model, "inputTokens", "outputTokens",
           "cacheCreationTokens", "cacheReadTokens")
          VALUES (${m.uuid}, ${m.user}, ${m.timestamp}, ${m.model},
            ${m.inputTokens}, ${m.outputTokens}, ${m.cacheCreationTokens}, ${m.cacheReadTokens})
          ON CONFLICT (uuid) DO NOTHING`;
      }
      for (const m of batch.markers) {
        await tx`INSERT INTO usage_markers (id, "user", at, model, weight)
          VALUES (${m.id}, ${m.user}, ${m.at}, ${m.model}, ${m.weight})
          ON CONFLICT (id) DO NOTHING`;
      }
      await tx`UPDATE ccshare_meta SET "writeSeq" = "writeSeq" + 1`;
    });
  }

  async prune(before: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM usage_samples WHERE "capturedAt" < ${before}`;
      await tx`DELETE FROM reset_events WHERE at < ${before}`;
      await tx`DELETE FROM message_usage WHERE timestamp < ${before}`;
      await tx`DELETE FROM usage_markers WHERE at < ${before}`;
      await tx`UPDATE ccshare_meta SET "writeSeq" = "writeSeq" + 1`;
    });
  }

  async getChangeToken(): Promise<string> {
    try {
      const rows = await this.sql<{ writeSeq: string | number }[]>`
        SELECT "writeSeq" FROM ccshare_meta LIMIT 1`;
      return String(rows[0]?.writeSeq ?? 0);
    } catch (err) {
      throw new Error(
        "this database predates the current schema (no writeSeq) — re-run `ccshare init`",
        { cause: err }
      );
    }
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

  async getResetsSince(since: string): Promise<ResetEvent[]> {
    const rows = await this.sql<{ cap: string; at: string; previousPct: number }[]>`
      SELECT cap, at, "previousPct" FROM reset_events WHERE at >= ${since} ORDER BY at ASC`;
    return rows.map((r) => ({
      cap: r.cap as CapKind,
      at: r.at,
      previousPct: Number(r.previousPct),
    }));
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
}

export { UNKNOWN_USER };
