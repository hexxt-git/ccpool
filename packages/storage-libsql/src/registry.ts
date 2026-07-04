import type { Client, InStatement } from "@libsql/client";
import { randomUUID } from "node:crypto";
import {
  RegistryConflictError,
  SCHEMA_VERSION,
  type CreateGroupInput,
  type GroupRow,
  type MemberRow,
  type Registry,
} from "@ccshare/core";

/**
 * libSQL surfaces every uniqueness/FK failure as a SQLITE_CONSTRAINT* code; a
 * failed statement rolls the whole `batch(..., "write")` back.
 */
function isConstraintViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

/**
 * The libSQL registry, over the ONE client its `LibsqlDatabase` owns. The
 * composed signup ops are single `batch(..., "write")` statement lists (every
 * value is known up front, so no interactive transaction is needed) that
 * deliberately cross into the ledger tables (this group's `ccshare_meta` /
 * `users` roster / `writeSeq`): identity and provisioning commit or roll back
 * together.
 */
export class LibsqlRegistry implements Registry {
  constructor(private readonly client: Client) {}

  async getGroupByAccount(accountId: string): Promise<GroupRow | null> {
    const { rows } = await this.client.execute({
      sql: `SELECT id, accountId, passwordHash, createdAt FROM groups WHERE accountId = ?`,
      args: [accountId],
    });
    return rows[0] ? toGroup(rows[0]) : null;
  }

  async getMember(groupId: string, name: string): Promise<MemberRow | null> {
    const { rows } = await this.client.execute({
      sql: `SELECT id, groupId, name, passwordHash, createdAt
            FROM members WHERE groupId = ? AND name = ?`,
      args: [groupId, name],
    });
    return rows[0] ? toMember(rows[0]) : null;
  }

  async resolveToken(tokenHash: string): Promise<{ member: MemberRow; group: GroupRow } | null> {
    const { rows } = await this.client.execute({
      sql: `SELECT m.id AS memberId, m.groupId AS memberGroupId, m.name AS name,
                   m.passwordHash AS memberHash, m.createdAt AS memberCreatedAt,
                   g.id AS gid, g.accountId AS accountId, g.passwordHash AS groupHash,
                   g.createdAt AS groupCreatedAt
            FROM tokens t
            JOIN members m ON m.id = t.memberId
            JOIN groups g ON g.id = m.groupId
            WHERE t.tokenHash = ?`,
      args: [tokenHash],
    });
    const r = rows[0];
    if (!r) return null;
    return {
      member: {
        id: String(r.memberId),
        groupId: String(r.memberGroupId),
        name: String(r.name),
        passwordHash: String(r.memberHash),
        createdAt: String(r.memberCreatedAt),
      },
      group: {
        id: String(r.gid),
        accountId: String(r.accountId),
        passwordHash: String(r.groupHash),
        createdAt: String(r.groupCreatedAt),
      },
    };
  }

  async insertToken(tokenHash: string, memberId: string): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO tokens (tokenHash, memberId, createdAt) VALUES (?, ?, ?)`,
      args: [tokenHash, memberId, new Date().toISOString()],
    });
  }

  async touchToken(tokenHash: string): Promise<void> {
    await this.client.execute({
      sql: `UPDATE tokens SET lastUsedAt = ? WHERE tokenHash = ?`,
      args: [new Date().toISOString(), tokenHash],
    });
  }

  async createGroupWithMember(
    input: CreateGroupInput
  ): Promise<{ group: GroupRow; member: MemberRow }> {
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
    const stmts: InStatement[] = [
      // The UNIQUE(accountId) constraint is the create-race arbiter.
      {
        sql: `INSERT INTO groups (id, accountId, passwordHash, createdAt) VALUES (?, ?, ?, ?)`,
        args: [group.id, group.accountId, group.passwordHash, group.createdAt],
      },
      // Provision the group's ledger in the same transaction. writeSeq starts
      // at 1: the roster insert below is this ledger's first observable write.
      {
        sql: `INSERT INTO ccshare_meta (group_id, app, schemaVersion, projectId, createdAt, accountId, writeSeq)
              VALUES (?, 'ccshare', ?, ?, ?, ?, 1)`,
        args: [group.id, SCHEMA_VERSION, randomUUID(), now, input.accountId],
      },
      {
        sql: `INSERT INTO users (group_id, name, createdAt) VALUES (?, ?, ?)`,
        args: [group.id, member.name, now],
      },
      {
        sql: `INSERT INTO members (id, groupId, name, passwordHash, createdAt) VALUES (?, ?, ?, ?, ?)`,
        args: [member.id, member.groupId, member.name, member.passwordHash, member.createdAt],
      },
      {
        sql: `INSERT INTO tokens (tokenHash, memberId, createdAt) VALUES (?, ?, ?)`,
        args: [input.tokenHash, member.id, now],
      },
    ];
    try {
      await this.client.batch(stmts, "write");
    } catch (err) {
      // The group id / member id / meta row are all fresh uuids scoped to the new
      // group — the only insert that can realistically conflict is groups.accountId.
      if (isConstraintViolation(err)) throw new RegistryConflictError("group-exists");
      throw err;
    }
    return { group, member };
  }

  async addMemberWithToken(
    groupId: string,
    name: string,
    passwordHash: string,
    tokenHash: string
  ): Promise<MemberRow> {
    const now = new Date().toISOString();
    const member: MemberRow = {
      id: randomUUID(),
      groupId,
      name,
      passwordHash,
      createdAt: now,
    };
    const stmts: InStatement[] = [
      // UNIQUE(groupId, name) is the same-name-race arbiter.
      {
        sql: `INSERT INTO members (id, groupId, name, passwordHash, createdAt) VALUES (?, ?, ?, ?, ?)`,
        args: [member.id, member.groupId, member.name, member.passwordHash, member.createdAt],
      },
      {
        sql: `INSERT INTO users (group_id, name, createdAt) VALUES (?, ?, ?)
              ON CONFLICT(group_id, name) DO NOTHING`,
        args: [groupId, name, now],
      },
      {
        sql: `UPDATE ccshare_meta SET writeSeq = writeSeq + 1 WHERE group_id = ?`,
        args: [groupId],
      },
      {
        sql: `INSERT INTO tokens (tokenHash, memberId, createdAt) VALUES (?, ?, ?)`,
        args: [tokenHash, member.id, now],
      },
    ];
    try {
      await this.client.batch(stmts, "write");
    } catch (err) {
      if (isConstraintViolation(err)) throw new RegistryConflictError("member-exists");
      throw err;
    }
    return member;
  }
}

function toGroup(r: Record<string, unknown>): GroupRow {
  return {
    id: String(r.id),
    accountId: String(r.accountId),
    passwordHash: String(r.passwordHash),
    createdAt: String(r.createdAt),
  };
}

function toMember(r: Record<string, unknown>): MemberRow {
  return {
    id: String(r.id),
    groupId: String(r.groupId),
    name: String(r.name),
    passwordHash: String(r.passwordHash),
    createdAt: String(r.createdAt),
  };
}
