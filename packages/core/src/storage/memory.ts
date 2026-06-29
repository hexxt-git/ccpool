import type {
  Budget,
  CapKind,
  DbInspection,
  MessageUsage,
  ResetEvent,
  User,
  UsageSample,
  UserShare,
} from "../types.js";
import { CAP_KINDS, UNKNOWN_USER } from "../types.js";
import { apportionShares } from "../state/shares.js";
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

  async recordReset(e: ResetEvent): Promise<void> {
    this.resets.push(e);
  }

  async recordMessageUsage(rows: MessageUsage[]): Promise<void> {
    for (const r of rows) {
      // idempotent on uuid
      if (!this.messages.has(r.uuid)) this.messages.set(r.uuid, r);
    }
  }

  async getShareSince(since: string): Promise<UserShare[]> {
    // Raw measured weight per (user, cap). A message contributes to every cap
    // whose window it falls within; opus-only caps additionally filter by model.
    const weights: { user: string; cap: CapKind; weight: number }[] = [];
    const perUser = new Map<string, number>();
    for (const m of this.messages.values()) {
      if (m.timestamp < since) continue;
      const w = messageWeight(m);
      perUser.set(m.user, (perUser.get(m.user) ?? 0) + w);
    }
    for (const cap of CAP_KINDS) {
      for (const [user, weight] of perUser) {
        weights.push({ user, cap, weight });
      }
    }
    return apportionShares(await this.getLatestSamples(), weights);
  }

  async setBudget(name: string, cap: CapKind, sharePct: number): Promise<void> {
    this.budgets.set(`${name}:${cap}`, { name, cap, sharePct });
  }

  async getBudgets(): Promise<Budget[]> {
    return [...this.budgets.values()];
  }
}

/** Cache fields are reliable; raw input/output undercount — sum them all. */
function messageWeight(m: MessageUsage): number {
  return m.inputTokens + m.outputTokens + m.cacheCreationTokens + m.cacheReadTokens;
}

export { UNKNOWN_USER };
