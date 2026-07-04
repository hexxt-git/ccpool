import type { Sql } from "postgres";
import { randomUUID } from "node:crypto";
import {
  CAP_KINDS,
  DEFAULT_GROUP_ID,
  isEmptyBatch,
  SCHEMA_VERSION,
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
import { runLedgerDdl } from "./ddl.js";

/**
 * Second Storage adapter, proving the boundary: the same relational model as the
 * libSQL adapter, backed by Postgres. A cheap group-scoped facade over the ONE
 * pool its `PostgresDatabase` owns — every query is confined to `groupId` via a
 * `group_id` column on every table.
 */
export class PostgresStorage implements Storage {
  constructor(
    private readonly sql: Sql,
    private readonly groupId: string = DEFAULT_GROUP_ID
  ) {}

  async inspect(): Promise<DbInspection> {
    const rows = await this.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema()`;
    const tables = new Set(rows.map((r) => r.table_name));
    if (!tables.has("ccshare_meta")) return { kind: "empty" };
    // SELECT * so a DB from another build still reads (missing key -> undefined).
    const meta = await this.sql<
      { schemaVersion: number; accountId?: string | null }[]
    >`SELECT * FROM ccshare_meta WHERE group_id = ${this.groupId} LIMIT 1`;
    // The ledger tables exist but this group has no meta row yet — safe to init it.
    if (!meta[0]) return { kind: "empty" };
    return {
      kind: "ccshare",
      schemaVersion: Number(meta[0].schemaVersion ?? SCHEMA_VERSION),
      accountId: meta[0].accountId ?? null,
    };
  }

  async initializeSchema(accountId: string | null = null): Promise<void> {
    // Tables are shared across groups (created once, IF NOT EXISTS); the per-group
    // meta row is what makes this group's ledger exist.
    await this.sql.begin(async (tx) => {
      await runLedgerDdl(tx);
      await tx`INSERT INTO ccshare_meta
        (group_id, app, "schemaVersion", "projectId", "createdAt", "accountId", "writeSeq")
        VALUES (${this.groupId}, 'ccshare', ${SCHEMA_VERSION}, ${randomUUID()},
                ${new Date().toISOString()}, ${accountId}, 0)
        ON CONFLICT (group_id) DO NOTHING`;
    });
  }

  async bindAccount(accountId: string): Promise<void> {
    // Claim only when currently unbound, so we never overwrite an existing binding.
    await this.sql`UPDATE ccshare_meta SET "accountId" = ${accountId}
      WHERE group_id = ${this.groupId} AND "accountId" IS NULL`;
  }

  async migrate(toVersion: number): Promise<void> {
    // v1 is the baseline; a fresh DB is already current. migrate re-ensures the
    // idempotency indexes (safe under a multi-machine race) and records the version
    // this build wrote, so it stays additive and rerunnable.
    await this.sql.begin(async (tx) => {
      await tx`CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_samples_cap
        ON usage_samples (group_id, cap, "capturedAt")`;
      await tx`CREATE UNIQUE INDEX IF NOT EXISTS idx_reset_events_uniq
        ON reset_events (group_id, cap, at)`;
      await tx`UPDATE ccshare_meta SET "schemaVersion" = ${toVersion}
        WHERE group_id = ${this.groupId}`;
    });
  }

  /** No-op: the pool belongs to the `PostgresDatabase`; only it tears down. */
  async close(): Promise<void> {}

  async upsertUser(name: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`INSERT INTO users (group_id, name, "createdAt")
        VALUES (${this.groupId}, ${name}, ${new Date().toISOString()})
        ON CONFLICT (group_id, name) DO NOTHING`;
      await tx`UPDATE ccshare_meta SET "writeSeq" = "writeSeq" + 1
        WHERE group_id = ${this.groupId}`;
    });
  }

  async getUsers(): Promise<User[]> {
    const rows = await this.sql<{ name: string; createdAt: string }[]>`
      SELECT name, "createdAt" FROM users WHERE group_id = ${this.groupId} ORDER BY name`;
    return rows.map((r) => ({ name: r.name, createdAt: r.createdAt }));
  }

  async recordBatch(batch: TickBatch): Promise<void> {
    if (isEmptyBatch(batch)) return;
    const g = this.groupId;
    await this.sql.begin(async (tx) => {
      for (const s of batch.samples) {
        await tx`INSERT INTO usage_samples (group_id, cap, pct, "resetsAt", "capturedAt")
          VALUES (${g}, ${s.cap}, ${s.pct}, ${s.resetsAt}, ${s.capturedAt})
          ON CONFLICT (group_id, cap, "capturedAt") DO NOTHING`;
      }
      for (const e of batch.resets) {
        await tx`INSERT INTO reset_events (group_id, cap, at, "previousPct")
          VALUES (${g}, ${e.cap}, ${e.at}, ${e.previousPct})
          ON CONFLICT (group_id, cap, at) DO NOTHING`;
      }
      for (const m of batch.messages) {
        await tx`INSERT INTO message_usage
          (group_id, uuid, "user", timestamp, model, "inputTokens", "outputTokens",
           "cacheCreationTokens", "cacheReadTokens")
          VALUES (${g}, ${m.uuid}, ${m.user}, ${m.timestamp}, ${m.model},
            ${m.inputTokens}, ${m.outputTokens}, ${m.cacheCreationTokens}, ${m.cacheReadTokens})
          ON CONFLICT (group_id, uuid) DO NOTHING`;
      }
      for (const m of batch.markers) {
        await tx`INSERT INTO usage_markers (group_id, id, "user", at, model, weight)
          VALUES (${g}, ${m.id}, ${m.user}, ${m.at}, ${m.model}, ${m.weight})
          ON CONFLICT (group_id, id) DO NOTHING`;
      }
      await tx`UPDATE ccshare_meta SET "writeSeq" = "writeSeq" + 1 WHERE group_id = ${g}`;
    });
  }

  async prune(before: string): Promise<void> {
    const g = this.groupId;
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM usage_samples WHERE group_id = ${g} AND "capturedAt" < ${before}`;
      await tx`DELETE FROM reset_events WHERE group_id = ${g} AND at < ${before}`;
      await tx`DELETE FROM message_usage WHERE group_id = ${g} AND timestamp < ${before}`;
      await tx`DELETE FROM usage_markers WHERE group_id = ${g} AND at < ${before}`;
      await tx`UPDATE ccshare_meta SET "writeSeq" = "writeSeq" + 1 WHERE group_id = ${g}`;
    });
  }

  async getChangeToken(): Promise<string> {
    try {
      const rows = await this.sql<{ writeSeq: string | number }[]>`
        SELECT "writeSeq" FROM ccshare_meta WHERE group_id = ${this.groupId} LIMIT 1`;
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
      FROM usage_samples WHERE group_id = ${this.groupId} ORDER BY cap, "capturedAt" DESC`;
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
      WHERE group_id = ${this.groupId} AND "capturedAt" >= ${since} ORDER BY "capturedAt" ASC`;
    return rows.map((r) => ({
      cap: r.cap as CapKind,
      pct: Number(r.pct),
      resetsAt: r.resetsAt,
      capturedAt: r.capturedAt,
    }));
  }

  async getResetsSince(since: string): Promise<ResetEvent[]> {
    const rows = await this.sql<{ cap: string; at: string; previousPct: number }[]>`
      SELECT cap, at, "previousPct" FROM reset_events
      WHERE group_id = ${this.groupId} AND at >= ${since} ORDER BY at ASC`;
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
      FROM message_usage WHERE group_id = ${this.groupId} AND timestamp >= ${since}`;
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
    >`SELECT id, "user", at, model, weight FROM usage_markers
      WHERE group_id = ${this.groupId} AND at >= ${since}`;
    return rows.map((r) => ({
      id: r.id,
      user: r.user,
      at: r.at,
      model: r.model,
      weight: Number(r.weight),
    }));
  }
}
