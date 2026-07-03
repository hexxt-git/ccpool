import { randomUUID } from "node:crypto";
import { MemoryStorage, StorageIngestSink, StorageViewSource } from "@ccshare/core";
import type { GroupRow, MemberRow, Registry, Tenant, TenantProvider } from "./deps.js";

/**
 * In-memory ServerDeps: the whole HTTP surface runs against these in tests (and
 * in the CLI's ungated end-to-end test) with zero infrastructure. Same contract
 * as the Postgres pair — MemoryStorage plays each group's ledger.
 */

export class MemoryRegistry implements Registry {
  private groups = new Map<string, GroupRow>(); // by id
  private members = new Map<string, MemberRow>(); // by id
  private tokens = new Map<string, string>(); // tokenHash -> memberId

  async getGroupByAccount(accountId: string): Promise<GroupRow | null> {
    for (const g of this.groups.values()) if (g.accountId === accountId) return g;
    return null;
  }

  async createGroup(accountId: string, passwordHash: string): Promise<GroupRow> {
    if (await this.getGroupByAccount(accountId)) {
      throw new Error(`group for account ${accountId} already exists`);
    }
    const id = randomUUID();
    const g: GroupRow = {
      id,
      accountId,
      passwordHash,
      schemaName: "grp_" + id.replaceAll("-", ""),
      createdAt: new Date().toISOString(),
    };
    this.groups.set(id, g);
    return g;
  }

  async deleteGroup(id: string): Promise<void> {
    this.groups.delete(id);
    for (const [mid, m] of this.members) if (m.groupId === id) this.members.delete(mid);
  }

  async getMember(groupId: string, name: string): Promise<MemberRow | null> {
    for (const m of this.members.values()) {
      if (m.groupId === groupId && m.name === name) return m;
    }
    return null;
  }

  async createMember(groupId: string, name: string, passwordHash: string): Promise<MemberRow> {
    if (await this.getMember(groupId, name)) {
      throw new Error(`member ${name} already exists in group ${groupId}`);
    }
    const m: MemberRow = {
      id: randomUUID(),
      groupId,
      name,
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    this.members.set(m.id, m);
    return m;
  }

  async resolveToken(tokenHash: string): Promise<{ member: MemberRow; group: GroupRow } | null> {
    const memberId = this.tokens.get(tokenHash);
    if (!memberId) return null;
    const member = this.members.get(memberId);
    if (!member) return null;
    const group = this.groups.get(member.groupId);
    if (!group) return null;
    return { member, group };
  }

  async insertToken(tokenHash: string, memberId: string): Promise<void> {
    this.tokens.set(tokenHash, memberId);
  }

  async touchToken(): Promise<void> {}

  async close(): Promise<void> {}
}

export class MemoryTenantProvider implements TenantProvider {
  private tenants = new Map<string, Tenant>(); // by group id

  async provision(group: GroupRow): Promise<void> {
    const storage = new MemoryStorage();
    await storage.initializeSchema(group.accountId);
    this.tenants.set(group.id, {
      sink: new StorageIngestSink(storage),
      view: new StorageViewSource(storage),
      upsertUser: (name) => storage.upsertUser(name),
    });
    // Prime the sink's binding knowledge so ingest re-checks work immediately.
    await this.tenants.get(group.id)!.sink.bootstrap();
  }

  async get(group: GroupRow): Promise<Tenant> {
    const t = this.tenants.get(group.id);
    if (!t) throw new Error(`group ${group.id} was never provisioned`);
    return t;
  }

  async close(): Promise<void> {
    await Promise.all([...this.tenants.values()].map((t) => t.sink.close().catch(() => {})));
    this.tenants.clear();
  }
}
