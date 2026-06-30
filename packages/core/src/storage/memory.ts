import type {
  Budget,
  CapKind,
  DbInspection,
  MessageUsage,
  ResetEvent,
  User,
  UsageSample,
} from "../types.js";
import { CAP_KINDS, UNKNOWN_USER } from "../types.js";
import type { Storage } from "./storage.js";
import { SCHEMA_VERSION } from "./storage.js";

/**
 * In-memory Storage for tests and the storage contract suite. Models the same
 * empty/ccshare/foreign lifecycle a real adapter sees.
 */
export class MemoryStorage implements Storage {
  private initialized = false;
  /** Simulate a database that already contains another project's tables. */
  private foreign: boolean;
  private schemaVersion = SCHEMA_VERSION;

  private users = new Map<string, User>();
  private samples: UsageSample[] = [];
  private resets: ResetEvent[] = [];
  private messages = new Map<string, MessageUsage>();
  private budgets = new Map<string, Budget>();

  constructor(opts: { foreign?: boolean } = {}) {
    this.foreign = opts.foreign ?? false;
  }

  async inspect(): Promise<DbInspection> {
    if (this.initialized) return { kind: "ccshare", schemaVersion: this.schemaVersion };
    if (this.foreign) return { kind: "foreign" };
    return { kind: "empty" };
  }

  async initializeSchema(): Promise<void> {
    if (this.foreign) throw new Error("refusing to initialize over a foreign database");
    this.initialized = true;
    this.schemaVersion = SCHEMA_VERSION;
  }

  async migrate(toVersion: number): Promise<void> {
    this.schemaVersion = toVersion;
  }

  async close(): Promise<void> {}

  async upsertUser(name: string): Promise<void> {
    if (!this.users.has(name)) {
      this.users.set(name, { name, createdAt: new Date().toISOString() });
    }
  }

  async getUsers(): Promise<User[]> {
    return [...this.users.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async recordUsageSample(s: UsageSample): Promise<void> {
    this.samples.push(s);
  }

  async getLatestSamples(): Promise<UsageSample[]> {
    const latest = new Map<CapKind, UsageSample>();
    for (const s of this.samples) {
      const cur = latest.get(s.cap);
      if (!cur || s.capturedAt >= cur.capturedAt) latest.set(s.cap, s);
    }
    return CAP_KINDS.map((c) => latest.get(c)).filter((s): s is UsageSample => !!s);
  }

  async getUsageSamplesSince(since: string): Promise<UsageSample[]> {
    return this.samples
      .filter((s) => s.capturedAt >= since)
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }

  async recordReset(e: ResetEvent): Promise<void> {
    this.resets.push(e);
  }

  async getResetsSince(since: string): Promise<ResetEvent[]> {
    return this.resets.filter((e) => e.at >= since);
  }

  async recordMessageUsage(rows: MessageUsage[]): Promise<void> {
    for (const r of rows) {
      // idempotent on uuid
      if (!this.messages.has(r.uuid)) this.messages.set(r.uuid, r);
    }
  }

  async getMessageUsageSince(since: string): Promise<MessageUsage[]> {
    return [...this.messages.values()].filter((m) => m.timestamp >= since);
  }

  async setBudget(name: string, cap: CapKind, sharePct: number): Promise<void> {
    this.budgets.set(`${name}:${cap}`, { name, cap, sharePct });
  }

  async getBudgets(): Promise<Budget[]> {
    return [...this.budgets.values()];
  }
}

export { UNKNOWN_USER };
