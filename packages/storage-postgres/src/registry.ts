import type { Sql } from "postgres";
import { randomUUID } from "node:crypto";
import {
  RegistryConflictError,
  SCHEMA_VERSION,
  type CreateGroupInput,
  type GroupRow,
  type MemberRow,
  type Registry,
} from "@ccshare/core";

/** Postgres duplicate-key SQLSTATE — the only conflict the composed ops race on. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === UNIQUE_VIOLATION;
}

/**
 * The Postgres registry, over the ONE pool its `PostgresDatabase` owns. The
 * composed signup ops are single transactions that deliberately cross into the
 * ledger tables (this group's `ccshare_meta` / `users` roster / `writeSeq`):
 * identity and provisioning commit or roll back together.
 */
export class PgRegistry implements Registry {
  constructor(private readonly sql: Sql) {}

  async getGroupByAccount(accountId: string): Promise<GroupRow | null> {
    const rows = await this.sql<GroupRow[]>`
      SELECT id, "accountId", "passwordHash", "createdAt"
      FROM groups WHERE "accountId" = ${accountId}`;
    return rows[0] ?? null;
  }

  async getMember(groupId: string, name: string): Promise<MemberRow | null> {
    const rows = await this.sql<MemberRow[]>`
      SELECT id, "groupId", name, "passwordHash", "createdAt"
      FROM members WHERE "groupId" = ${groupId} AND name = ${name}`;
    return rows[0] ?? null;
  }

  async resolveToken(tokenHash: string): Promise<{ member: MemberRow; group: GroupRow } | null> {
    const rows = await this.sql<
      {
        memberId: string;
        groupId: string;
        name: string;
        memberHash: string;
        memberCreatedAt: string;
        gid: string;
        accountId: string;
        groupHash: string;
        groupCreatedAt: string;
      }[]
    >`SELECT m.id AS "memberId", m."groupId" AS "groupId", m.name,
             m."passwordHash" AS "memberHash", m."createdAt" AS "memberCreatedAt",
             g.id AS gid, g."accountId" AS "accountId", g."passwordHash" AS "groupHash",
             g."createdAt" AS "groupCreatedAt"
      FROM tokens t
      JOIN members m ON m.id = t."memberId"
      JOIN groups g ON g.id = m."groupId"
      WHERE t."tokenHash" = ${tokenHash}`;
    const r = rows[0];
    if (!r) return null;
    return {
      member: {
        id: r.memberId,
        groupId: r.groupId,
        name: r.name,
        passwordHash: r.memberHash,
        createdAt: r.memberCreatedAt,
      },
      group: {
        id: r.gid,
        accountId: r.accountId,
        passwordHash: r.groupHash,
        createdAt: r.groupCreatedAt,
      },
    };
  }

  async insertToken(tokenHash: string, memberId: string): Promise<void> {
    await this.sql`INSERT INTO tokens ("tokenHash", "memberId", "createdAt")
      VALUES (${tokenHash}, ${memberId}, ${new Date().toISOString()})`;
  }

  async touchToken(tokenHash: string): Promise<void> {
    await this.sql`UPDATE tokens SET "lastUsedAt" = ${new Date().toISOString()}
      WHERE "tokenHash" = ${tokenHash}`;
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
    try {
      await this.sql.begin(async (tx) => {
        // The UNIQUE("accountId") constraint is the create-race arbiter.
        await tx`INSERT INTO groups (id, "accountId", "passwordHash", "createdAt")
          VALUES (${group.id}, ${group.accountId}, ${group.passwordHash}, ${group.createdAt})`;
        // Provision the group's ledger in the same transaction. writeSeq starts
        // at 1: the roster insert below is this ledger's first observable write.
        await tx`INSERT INTO ccshare_meta
          (group_id, app, "schemaVersion", "projectId", "createdAt", "accountId", "writeSeq")
          VALUES (${group.id}, 'ccshare', ${SCHEMA_VERSION}, ${randomUUID()}, ${now},
                  ${input.accountId}, 1)`;
        await tx`INSERT INTO users (group_id, name, "createdAt")
          VALUES (${group.id}, ${member.name}, ${now})`;
        await tx`INSERT INTO members (id, "groupId", name, "passwordHash", "createdAt")
          VALUES (${member.id}, ${member.groupId}, ${member.name}, ${member.passwordHash},
                  ${member.createdAt})`;
        await tx`INSERT INTO tokens ("tokenHash", "memberId", "createdAt")
          VALUES (${input.tokenHash}, ${member.id}, ${now})`;
      });
    } catch (err) {
      // The group id / member id / meta row are all fresh uuids scoped to the new
      // group — the only insert that can realistically conflict is groups.accountId.
      if (isUniqueViolation(err)) throw new RegistryConflictError("group-exists");
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
    try {
      await this.sql.begin(async (tx) => {
        // UNIQUE("groupId", name) is the same-name-race arbiter.
        await tx`INSERT INTO members (id, "groupId", name, "passwordHash", "createdAt")
          VALUES (${member.id}, ${member.groupId}, ${member.name}, ${member.passwordHash},
                  ${member.createdAt})`;
        await tx`INSERT INTO users (group_id, name, "createdAt")
          VALUES (${groupId}, ${name}, ${now})
          ON CONFLICT (group_id, name) DO NOTHING`;
        await tx`UPDATE ccshare_meta SET "writeSeq" = "writeSeq" + 1
          WHERE group_id = ${groupId}`;
        await tx`INSERT INTO tokens ("tokenHash", "memberId", "createdAt")
          VALUES (${tokenHash}, ${member.id}, ${now})`;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new RegistryConflictError("member-exists");
      throw err;
    }
    return member;
  }
}
