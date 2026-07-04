import { randomUUID } from "node:crypto";
import type { Database } from "../storage/database.js";
import type { Storage } from "../storage/storage.js";
import { MemoryStorage } from "../storage/memory.js";
import {
  RegistryConflictError,
  type CreateGroupInput,
  type GroupRow,
  type MemberRow,
  type Registry,
} from "./registry.js";

/**
 * In-memory Database: the registry maps plus a lazy MemoryStorage per group.
 * The whole server HTTP surface runs against this in tests with zero
 * infrastructure. Composed ops validate uniqueness up front, then apply — the
 * synchronous equivalent of the SQL adapters' rolled-back transaction.
 */
export class MemoryDatabase implements Database {
  private storages = new Map<string, MemoryStorage>();
  private groups = new Map<string, GroupRow>(); // by id
  private members = new Map<string, MemberRow>(); // by id
  private tokens = new Map<string, string>(); // tokenHash -> memberId

  readonly registry: Registry = {
    getGroupByAccount: async (accountId) => {
      for (const g of this.groups.values()) if (g.accountId === accountId) return g;
      return null;
    },

    getMember: async (groupId, name) => {
      for (const m of this.members.values()) {
        if (m.groupId === groupId && m.name === name) return m;
      }
      return null;
    },

    resolveToken: async (tokenHash) => {
      const memberId = this.tokens.get(tokenHash);
      if (!memberId) return null;
      const member = this.members.get(memberId);
      if (!member) return null;
      const group = this.groups.get(member.groupId);
      if (!group) return null;
      return { member, group };
    },

    insertToken: async (tokenHash, memberId) => {
      this.tokens.set(tokenHash, memberId);
    },

    touchToken: async () => {},

    createGroupWithMember: async (input: CreateGroupInput) => {
      if (await this.registry.getGroupByAccount(input.accountId)) {
        throw new RegistryConflictError("group-exists");
      }
      const now = new Date().toISOString();
      const group: GroupRow = {
        id: randomUUID(),
        accountId: input.accountId,
        passwordHash: input.groupPasswordHash,
        createdAt: now,
      };
      const member: MemberRow = {
        id: randomUUID(),
        groupId: group.id,
        name: input.memberName,
        passwordHash: input.memberPasswordHash,
        createdAt: now,
      };
      this.groups.set(group.id, group);
      const storage = this.storage(group.id);
      await storage.initializeSchema(input.accountId);
      await storage.upsertUser(member.name);
      this.members.set(member.id, member);
      this.tokens.set(input.tokenHash, member.id);
      return { group, member };
    },

    addMemberWithToken: async (groupId, name, passwordHash, tokenHash) => {
      if (!this.groups.has(groupId)) throw new Error(`unknown group ${groupId}`); // FK parity
      if (await this.registry.getMember(groupId, name)) {
        throw new RegistryConflictError("member-exists");
      }
      const member: MemberRow = {
        id: randomUUID(),
        groupId,
        name,
        passwordHash,
        createdAt: new Date().toISOString(),
      };
      this.members.set(member.id, member);
      await this.storage(groupId).upsertUser(name); // roster row + the one writeSeq bump
      this.tokens.set(tokenHash, member.id);
      return member;
    },
  };

  async init(): Promise<void> {}

  forGroup(groupId: string): Storage {
    return this.storage(groupId);
  }

  private storage(groupId: string): MemoryStorage {
    let s = this.storages.get(groupId);
    if (!s) {
      s = new MemoryStorage();
      this.storages.set(groupId, s);
    }
    return s;
  }

  async close(): Promise<void> {}
}
