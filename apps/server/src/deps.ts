import type { IngestSink, StorageViewSource } from "@ccshare/core";

/**
 * The server's two injectable dependencies. Routes in app.ts are written against
 * these interfaces so the whole HTTP surface is testable with in-memory
 * implementations (src/memory.ts); production wires the Postgres pair
 * (registry-pg.ts + tenants-pg.ts).
 */

export interface GroupRow {
  id: string;
  /** The Claude accountUuid this group is bound to (unique per server). */
  accountId: string;
  /** scrypt hash of the shared group password. */
  passwordHash: string;
  /** The Postgres schema holding this group's ledger. */
  schemaName: string;
  createdAt: string;
}

export interface MemberRow {
  id: string;
  groupId: string;
  name: string;
  /** scrypt hash of this member's own password. */
  passwordHash: string;
  createdAt: string;
}

/** Groups, members, and tokens — the server-owned tables OUTSIDE `Storage`. */
export interface Registry {
  getGroupByAccount(accountId: string): Promise<GroupRow | null>;
  /** Insert a group row (unique accountId is the concurrency gate). */
  createGroup(accountId: string, passwordHash: string): Promise<GroupRow>;
  /** Compensation for a failed ledger provision — best effort. */
  deleteGroup(id: string): Promise<void>;
  getMember(groupId: string, name: string): Promise<MemberRow | null>;
  createMember(groupId: string, name: string, passwordHash: string): Promise<MemberRow>;
  /** One indexed lookup: token hash -> member + group, or null. */
  resolveToken(tokenHash: string): Promise<{ member: MemberRow; group: GroupRow } | null>;
  insertToken(tokenHash: string, memberId: string): Promise<void>;
  /** Update lastUsedAt (callers throttle; this is just the write). */
  touchToken(tokenHash: string): Promise<void>;
  close(): Promise<void>;
}

/** One group's composed backend: the same core pieces the self-host CLI uses. */
export interface Tenant {
  sink: IngestSink;
  /** StorageViewSource concretely — its cache key doubles as the ETag. */
  view: StorageViewSource;
  upsertUser(name: string): Promise<void>;
}

export interface TenantProvider {
  /** Create the group's ledger (schema + tables), bound to its account. */
  provision(group: GroupRow): Promise<void>;
  /** The (cached) live tenant for a provisioned group. */
  get(group: GroupRow): Promise<Tenant>;
  close(): Promise<void>;
}

export interface ServerDeps {
  registry: Registry;
  tenants: TenantProvider;
}
