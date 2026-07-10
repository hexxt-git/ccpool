import type { Client, InStatement, InValue } from "@libsql/client";
import { randomUUID } from "node:crypto";
import {
  CAP_KINDS,
  DEFAULT_GROUP_ID,
  isEmptyBatch,
  SCHEMA_VERSION,
  type CapKind,
  type DbInspection,
  type HistoryShare,
  type HistoryWindow,
  type MessageUsage,
  type ResetEvent,
  type Storage,
  type TickBatch,
  type UsageMarker,
  type UsageSample,
  type User,
} from "@ccshare/core";
import { LEDGER_DDL } from "./ddl.js";

/**
 * Default Storage adapter. Runs on Node and Bun, and speaks both `file:` (local
 * SQLite) and `libsql://` (remote Turso). A cheap group-scoped facade over the
 * ONE client its `LibsqlDatabase` owns — every query is confined to `groupId`
 * via a `group_id` column on every table.
 */
export class LibsqlStorage implements Storage {
  constructor(
    private readonly client: Client,
    private readonly groupId: string = DEFAULT_GROUP_ID
  ) {}

  async inspect(): Promise<DbInspection> {
    const { rows } = await this.client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%'"
    );
    const tables = new Set(rows.map((r) => String(r.name)));
    if (!tables.has("ccshare_meta")) return { kind: "empty" };
    // SELECT * (not named columns) so a DB from another build still reads —
    // a missing column simply comes back undefined, not an error.
    const meta = await this.client.execute({
      sql: "SELECT * FROM ccshare_meta WHERE group_id = ? LIMIT 1",
      args: [this.groupId],
    });
    const row = meta.rows[0];
    // The ledger tables exist but this group has no meta row yet — safe to init it.
    if (!row) return { kind: "empty" };
    return {
      kind: "ccshare",
      schemaVersion: Number(row.schemaVersion ?? SCHEMA_VERSION),
      accountId: row.accountId == null ? null : String(row.accountId),
    };
  }

  async initializeSchema(accountId: string | null = null): Promise<void> {
    // Tables are shared across groups (created once, IF NOT EXISTS); the per-group
    // meta row is what makes this group's ledger exist.
    await this.client.batch(
      [
        ...LEDGER_DDL,
        {
          sql: `INSERT INTO ccshare_meta (group_id, app, schemaVersion, projectId, createdAt, accountId, writeSeq)
                VALUES (?, 'ccshare', ?, ?, ?, ?, 0)
                ON CONFLICT(group_id) DO NOTHING`,
          args: [this.groupId, SCHEMA_VERSION, randomUUID(), new Date().toISOString(), accountId],
        },
      ],
      "write"
    );
  }

  async bindAccount(accountId: string): Promise<void> {
    // Claim only when currently unbound, so we never overwrite an existing binding.
    await this.client.execute({
      sql: "UPDATE ccshare_meta SET accountId = ? WHERE group_id = ? AND accountId IS NULL",
      args: [accountId, this.groupId],
    });
  }

  async migrate(toVersion: number): Promise<void> {
    // v1 is the baseline; a fresh DB is already current. migrate re-ensures the
    // idempotency indexes (safe under a multi-machine race) and records the
    // version this build wrote, so it stays additive and rerunnable.
    await this.client.batch(
      [
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_samples_cap ON usage_samples (group_id, cap, capturedAt)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_reset_events_uniq ON reset_events (group_id, cap, at)`,
        // Additive: an older DB gains the history tables here (fresh DBs get them
        // from LEDGER_DDL at init). Kept in sync with ddl.ts.
        `CREATE TABLE IF NOT EXISTS history_windows (
           group_id TEXT NOT NULL, cap TEXT NOT NULL, windowStart TEXT NOT NULL,
           windowEnd TEXT NOT NULL, overall REAL NOT NULL, closedAt TEXT NOT NULL,
           PRIMARY KEY (group_id, cap, windowStart))`,
        `CREATE TABLE IF NOT EXISTS history_shares (
           group_id TEXT NOT NULL, cap TEXT NOT NULL, windowStart TEXT NOT NULL,
           user TEXT NOT NULL, pct REAL NOT NULL,
           PRIMARY KEY (group_id, cap, windowStart, user))`,
        {
          sql: "UPDATE ccshare_meta SET schemaVersion = ? WHERE group_id = ?",
          args: [toVersion, this.groupId],
        },
      ],
      "write"
    );
  }

  /** No-op: the client belongs to the `LibsqlDatabase`; only it tears down. */
  async close(): Promise<void> {}

  async upsertUser(name: string): Promise<void> {
    await this.client.batch(
      [
        {
          sql: `INSERT INTO users (group_id, name, createdAt) VALUES (?, ?, ?)
                ON CONFLICT(group_id, name) DO NOTHING`,
          args: [this.groupId, name, new Date().toISOString()],
        },
        this.bumpWriteSeq(),
      ],
      "write"
    );
  }

  async getUsers(): Promise<User[]> {
    const { rows } = await this.client.execute({
      sql: "SELECT name, createdAt FROM users WHERE group_id = ? ORDER BY name",
      args: [this.groupId],
    });
    return rows.map((r) => ({ name: String(r.name), createdAt: String(r.createdAt) }));
  }

  async recordBatch(batch: TickBatch): Promise<void> {
    if (isEmptyBatch(batch)) return;
    const g = this.groupId;
    const stmts: InStatement[] = [];
    for (const s of batch.samples) {
      stmts.push({
        sql: `INSERT INTO usage_samples (group_id, cap, pct, resetsAt, capturedAt) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(group_id, cap, capturedAt) DO NOTHING`,
        args: [g, s.cap, s.pct, s.resetsAt, s.capturedAt] satisfies InValue[],
      });
    }
    for (const e of batch.resets) {
      stmts.push({
        sql: `INSERT INTO reset_events (group_id, cap, at, previousPct) VALUES (?, ?, ?, ?)
              ON CONFLICT(group_id, cap, at) DO NOTHING`,
        args: [g, e.cap, e.at, e.previousPct] satisfies InValue[],
      });
    }
    for (const m of batch.messages) {
      stmts.push({
        sql: `INSERT INTO message_usage
                (group_id, uuid, user, timestamp, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(group_id, uuid) DO NOTHING`,
        args: [
          g,
          m.uuid,
          m.user,
          m.timestamp,
          m.model,
          m.inputTokens,
          m.outputTokens,
          m.cacheCreationTokens,
          m.cacheReadTokens,
        ] satisfies InValue[],
      });
    }
    for (const m of batch.markers) {
      stmts.push({
        sql: `INSERT INTO usage_markers (group_id, id, user, at, model, weight)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(group_id, id) DO NOTHING`,
        args: [g, m.id, m.user, m.at, m.model, m.weight] satisfies InValue[],
      });
    }
    stmts.push(this.bumpWriteSeq());
    await this.client.batch(stmts, "write");
  }

  async prune(before: string): Promise<void> {
    const g = this.groupId;
    await this.client.batch(
      [
        {
          sql: `DELETE FROM usage_samples WHERE group_id = ? AND capturedAt < ?`,
          args: [g, before],
        },
        { sql: `DELETE FROM reset_events WHERE group_id = ? AND at < ?`, args: [g, before] },
        {
          sql: `DELETE FROM message_usage WHERE group_id = ? AND timestamp < ?`,
          args: [g, before],
        },
        { sql: `DELETE FROM usage_markers WHERE group_id = ? AND at < ?`, args: [g, before] },
        this.bumpWriteSeq(),
      ],
      "write"
    );
  }

  async getChangeToken(): Promise<string> {
    try {
      const { rows } = await this.client.execute({
        sql: "SELECT writeSeq FROM ccshare_meta WHERE group_id = ? LIMIT 1",
        args: [this.groupId],
      });
      return String(rows[0]?.writeSeq ?? 0);
    } catch (err) {
      throw new Error(
        "this database predates the current schema (no writeSeq) — re-run `ccshare init`",
        { cause: err }
      );
    }
  }

  async getLatestSamples(): Promise<UsageSample[]> {
    const { rows } = await this.client.execute({
      sql: `SELECT cap, pct, resetsAt, capturedAt FROM usage_samples s
            WHERE group_id = ?1
              AND capturedAt = (SELECT MAX(capturedAt) FROM usage_samples
                                WHERE cap = s.cap AND group_id = ?1)`,
      args: [this.groupId],
    });
    const byCap = new Map<CapKind, UsageSample>();
    for (const r of rows) {
      byCap.set(r.cap as CapKind, {
        cap: r.cap as CapKind,
        pct: Number(r.pct),
        resetsAt: r.resetsAt == null ? null : String(r.resetsAt),
        capturedAt: String(r.capturedAt),
      });
    }
    return CAP_KINDS.map((c) => byCap.get(c)).filter((s): s is UsageSample => !!s);
  }

  async getUsageSamplesSince(since: string): Promise<UsageSample[]> {
    const { rows } = await this.client.execute({
      sql: `SELECT cap, pct, resetsAt, capturedAt FROM usage_samples
            WHERE group_id = ? AND capturedAt >= ? ORDER BY capturedAt ASC`,
      args: [this.groupId, since],
    });
    return rows.map((r) => ({
      cap: r.cap as CapKind,
      pct: Number(r.pct),
      resetsAt: r.resetsAt == null ? null : String(r.resetsAt),
      capturedAt: String(r.capturedAt),
    }));
  }

  async getResetsSince(since: string): Promise<ResetEvent[]> {
    const { rows } = await this.client.execute({
      sql: `SELECT cap, at, previousPct FROM reset_events
            WHERE group_id = ? AND at >= ? ORDER BY at ASC`,
      args: [this.groupId, since],
    });
    return rows.map((r) => ({
      cap: r.cap as CapKind,
      at: String(r.at),
      previousPct: Number(r.previousPct),
    }));
  }

  async getMessageUsageSince(since: string): Promise<MessageUsage[]> {
    const { rows } = await this.client.execute({
      sql: `SELECT uuid, user, timestamp, model, inputTokens, outputTokens,
                   cacheCreationTokens, cacheReadTokens
            FROM message_usage WHERE group_id = ? AND timestamp >= ?`,
      args: [this.groupId, since],
    });
    return rows.map((r) => ({
      uuid: String(r.uuid),
      user: String(r.user),
      timestamp: String(r.timestamp),
      model: r.model == null ? null : String(r.model),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      cacheCreationTokens: Number(r.cacheCreationTokens),
      cacheReadTokens: Number(r.cacheReadTokens),
    }));
  }

  async getUsageMarkersSince(since: string): Promise<UsageMarker[]> {
    const { rows } = await this.client.execute({
      sql: `SELECT id, user, at, model, weight FROM usage_markers
            WHERE group_id = ? AND at >= ?`,
      args: [this.groupId, since],
    });
    return rows.map((r) => ({
      id: String(r.id),
      user: String(r.user),
      at: String(r.at),
      model: r.model == null ? null : String(r.model),
      weight: Number(r.weight),
    }));
  }

  async recordHistoryWindow(window: HistoryWindow, shares: HistoryShare[]): Promise<void> {
    const g = this.groupId;
    const stmts: InStatement[] = [
      {
        sql: `INSERT INTO history_windows (group_id, cap, windowStart, windowEnd, overall, closedAt)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(group_id, cap, windowStart) DO NOTHING`,
        args: [
          g,
          window.cap,
          window.windowStart,
          window.windowEnd,
          window.overall,
          window.closedAt,
        ],
      },
    ];
    for (const sh of shares) {
      stmts.push({
        sql: `INSERT INTO history_shares (group_id, cap, windowStart, user, pct)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(group_id, cap, windowStart, user) DO NOTHING`,
        args: [g, sh.cap, sh.windowStart, sh.user, sh.pct],
      });
    }
    stmts.push(this.bumpWriteSeq());
    await this.client.batch(stmts, "write");
  }

  async getHistoryWindows(
    cap: CapKind,
    opts: { before?: string; limit?: number } = {}
  ): Promise<HistoryWindow[]> {
    const limit = opts.limit ?? 100;
    const before = opts.before ?? null;
    const { rows } = await this.client.execute({
      sql: `SELECT cap, windowStart, windowEnd, overall, closedAt FROM history_windows
            WHERE group_id = ?1 AND cap = ?2 AND (?3 IS NULL OR windowStart < ?3)
            ORDER BY windowStart DESC LIMIT ?4`,
      args: [this.groupId, cap, before, limit],
    });
    return rows.map((r) => ({
      cap: r.cap as CapKind,
      windowStart: String(r.windowStart),
      windowEnd: String(r.windowEnd),
      overall: Number(r.overall),
      closedAt: String(r.closedAt),
    }));
  }

  async getHistoryShares(cap: CapKind, windowStart: string): Promise<HistoryShare[]> {
    const { rows } = await this.client.execute({
      sql: `SELECT cap, windowStart, user, pct FROM history_shares
            WHERE group_id = ? AND cap = ? AND windowStart = ?`,
      args: [this.groupId, cap, windowStart],
    });
    return rows.map((r) => ({
      cap: r.cap as CapKind,
      windowStart: String(r.windowStart),
      user: String(r.user),
      pct: Number(r.pct),
    }));
  }

  /** Every write batch ends with this so one tick bumps this group's token once. */
  private bumpWriteSeq(): InStatement {
    return {
      sql: "UPDATE ccshare_meta SET writeSeq = writeSeq + 1 WHERE group_id = ?",
      args: [this.groupId],
    };
  }
}
