import { createClient, type Client, type InValue } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
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
  type UsageSample,
  type User,
} from "@ccshare/core";
import { randomUUID } from "node:crypto";

export const DRIVER = "libsql" as const;

/**
 * Default Storage adapter. Runs on Node and Bun, and speaks both `file:` (local
 * SQLite) and `libsql://` (remote Turso) through the same client and the same
 * URL the user typed at init.
 */
export class LibsqlStorage implements Storage {
  private client: Client;

  constructor(url: string, authToken?: string) {
    const normalized = normalizeUrl(url);
    ensureFileDir(normalized);
    this.client = createClient(authToken ? { url: normalized, authToken } : { url: normalized });
  }

  async inspect(): Promise<DbInspection> {
    const { rows } = await this.client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%'"
    );
    const tables = new Set(rows.map((r) => String(r.name)));
    if (tables.size === 0) return { kind: "empty" };
    if (tables.has("ccshare_meta")) {
      const meta = await this.client.execute("SELECT schemaVersion FROM ccshare_meta LIMIT 1");
      const v = meta.rows[0]?.schemaVersion;
      return { kind: "ccshare", schemaVersion: Number(v ?? SCHEMA_VERSION) };
    }
    return { kind: "foreign" };
  }

  async initializeSchema(): Promise<void> {
    const inspection = await this.inspect();
    if (inspection.kind === "foreign") {
      throw new Error("refusing to initialize schema over a foreign database");
    }
    await this.client.batch(
      [
        `CREATE TABLE IF NOT EXISTS ccshare_meta (
           app TEXT NOT NULL,
           schemaVersion INTEGER NOT NULL,
           projectId TEXT NOT NULL,
           createdAt TEXT NOT NULL
         )`,
        `CREATE TABLE IF NOT EXISTS users (
           name TEXT PRIMARY KEY,
           createdAt TEXT NOT NULL
         )`,
        `CREATE TABLE IF NOT EXISTS usage_samples (
           cap TEXT NOT NULL,
           pct REAL NOT NULL,
           resetsAt TEXT,
           capturedAt TEXT NOT NULL
         )`,
        `CREATE INDEX IF NOT EXISTS idx_usage_samples_cap ON usage_samples (cap, capturedAt)`,
        `CREATE TABLE IF NOT EXISTS message_usage (
           uuid TEXT PRIMARY KEY,
           user TEXT NOT NULL,
           timestamp TEXT NOT NULL,
           model TEXT,
           inputTokens INTEGER NOT NULL,
           outputTokens INTEGER NOT NULL,
           cacheCreationTokens INTEGER NOT NULL,
           cacheReadTokens INTEGER NOT NULL
         )`,
        `CREATE INDEX IF NOT EXISTS idx_message_usage_ts ON message_usage (timestamp)`,
        `CREATE TABLE IF NOT EXISTS reset_events (
           cap TEXT NOT NULL,
           at TEXT NOT NULL,
           previousPct REAL NOT NULL
         )`,
        `CREATE TABLE IF NOT EXISTS budgets (
           name TEXT NOT NULL,
           cap TEXT NOT NULL,
           sharePct REAL NOT NULL,
           PRIMARY KEY (name, cap)
         )`,
        {
          sql: `INSERT INTO ccshare_meta (app, schemaVersion, projectId, createdAt)
                VALUES ('ccshare', ?, ?, ?)`,
          args: [SCHEMA_VERSION, randomUUID(), new Date().toISOString()],
        },
      ],
      "write"
    );
  }

  async migrate(toVersion: number): Promise<void> {
    // Only v1 exists today; future migrations branch on the current version here.
    await this.client.execute({
      sql: "UPDATE ccshare_meta SET schemaVersion = ?",
      args: [toVersion],
    });
  }

  async close(): Promise<void> {
    this.client.close();
  }

  async upsertUser(name: string): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO users (name, createdAt) VALUES (?, ?)
            ON CONFLICT(name) DO NOTHING`,
      args: [name, new Date().toISOString()],
    });
  }

  async getUsers(): Promise<User[]> {
    const { rows } = await this.client.execute("SELECT name, createdAt FROM users ORDER BY name");
    return rows.map((r) => ({ name: String(r.name), createdAt: String(r.createdAt) }));
  }

  async recordUsageSample(s: UsageSample): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO usage_samples (cap, pct, resetsAt, capturedAt) VALUES (?, ?, ?, ?)`,
      args: [s.cap, s.pct, s.resetsAt, s.capturedAt],
    });
  }

  async getLatestSamples(): Promise<UsageSample[]> {
    const { rows } = await this.client.execute(
      `SELECT cap, pct, resetsAt, capturedAt FROM usage_samples s
       WHERE capturedAt = (SELECT MAX(capturedAt) FROM usage_samples WHERE cap = s.cap)`
    );
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
            WHERE capturedAt >= ? ORDER BY capturedAt ASC`,
      args: [since],
    });
    return rows.map((r) => ({
      cap: r.cap as CapKind,
      pct: Number(r.pct),
      resetsAt: r.resetsAt == null ? null : String(r.resetsAt),
      capturedAt: String(r.capturedAt),
    }));
  }

  async recordReset(e: ResetEvent): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO reset_events (cap, at, previousPct) VALUES (?, ?, ?)`,
      args: [e.cap, e.at, e.previousPct],
    });
  }

  async getResetsSince(since: string): Promise<ResetEvent[]> {
    const { rows } = await this.client.execute({
      sql: `SELECT cap, at, previousPct FROM reset_events WHERE at >= ? ORDER BY at ASC`,
      args: [since],
    });
    return rows.map((r) => ({
      cap: r.cap as CapKind,
      at: String(r.at),
      previousPct: Number(r.previousPct),
    }));
  }

  async recordMessageUsage(rows: MessageUsage[]): Promise<void> {
    if (rows.length === 0) return;
    await this.client.batch(
      rows.map((m) => ({
        sql: `INSERT INTO message_usage
                (uuid, user, timestamp, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(uuid) DO NOTHING`,
        args: [
          m.uuid,
          m.user,
          m.timestamp,
          m.model,
          m.inputTokens,
          m.outputTokens,
          m.cacheCreationTokens,
          m.cacheReadTokens,
        ] satisfies InValue[],
      })),
      "write"
    );
  }

  async getMessageUsageSince(since: string): Promise<MessageUsage[]> {
    const { rows } = await this.client.execute({
      sql: `SELECT uuid, user, timestamp, model, inputTokens, outputTokens,
                   cacheCreationTokens, cacheReadTokens
            FROM message_usage WHERE timestamp >= ?`,
      args: [since],
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

  async setBudget(name: string, cap: CapKind, sharePct: number): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO budgets (name, cap, sharePct) VALUES (?, ?, ?)
            ON CONFLICT(name, cap) DO UPDATE SET sharePct = excluded.sharePct`,
      args: [name, cap, sharePct],
    });
  }

  async getBudgets(): Promise<Budget[]> {
    const { rows } = await this.client.execute(
      "SELECT name, cap, sharePct FROM budgets ORDER BY name, cap"
    );
    return rows.map((r) => ({
      name: String(r.name),
      cap: r.cap as CapKind,
      sharePct: Number(r.sharePct),
    }));
  }
}

/**
 * Normalize a storage URL before passing it to libsql:
 * - Bare paths (no scheme) are treated as `file:` URLs.
 * - Leading `~` is expanded to the home directory in `file:` URLs.
 */
function normalizeUrl(url: string): string {
  if (url === ":memory:") return url;
  if (!url.includes("://") && !url.startsWith("file:")) {
    url = "file:" + url;
  }
  if (url.startsWith("file:")) {
    let path = url.slice("file:".length);
    if (path.startsWith("//")) path = path.slice(2);
    if (path.startsWith("~")) path = homedir() + path.slice(1);
    return "file:" + path;
  }
  return url;
}

/** For a `file:` URL, make sure the parent directory exists before opening it. */
function ensureFileDir(url: string): void {
  if (!url.startsWith("file:")) return;
  let path = url.slice("file:".length);
  if (path.startsWith("//")) path = path.slice(2);
  if (path.length === 0 || path === ":memory:") return;
  const dir = dirname(path);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
}

export { UNKNOWN_USER, normalizeUrl };
