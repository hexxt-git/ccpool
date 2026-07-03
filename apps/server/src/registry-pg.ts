import postgres, { type Sql } from "postgres";
import { randomUUID } from "node:crypto";
import type { GroupRow, MemberRow, Registry } from "./deps.js";

/**
 * The server-owned registry tables (groups / members / tokens) in the server
 * database's default schema. These live OUTSIDE the `Storage` interface — the
 * per-group ledgers (in their own schemas) never know tenancy exists.
 */
export class PgRegistry implements Registry {
  private sql: Sql;

  constructor(url: string) {
    this.sql = postgres(url, { onnotice: () => {}, max: 10 });
  }

  /** Create/verify the registry tables. Idempotent; run once at startup. */
  async ensure(): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        "accountId" TEXT UNIQUE NOT NULL,
        "passwordHash" TEXT NOT NULL,
        "schemaName" TEXT UNIQUE NOT NULL,
        "createdAt" TEXT NOT NULL)`;
      await tx`CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        "groupId" TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        "passwordHash" TEXT NOT NULL,
        "createdAt" TEXT NOT NULL,
        UNIQUE ("groupId", name))`;
      await tx`CREATE TABLE IF NOT EXISTS tokens (
        "tokenHash" TEXT PRIMARY KEY,
        "memberId" TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        "createdAt" TEXT NOT NULL,
        "lastUsedAt" TEXT)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_tokens_member ON tokens ("memberId")`;
    });
  }

  async getGroupByAccount(accountId: string): Promise<GroupRow | null> {
    const rows = await this.sql<GroupRow[]>`
      SELECT id, "accountId", "passwordHash", "schemaName", "createdAt"
      FROM groups WHERE "accountId" = ${accountId}`;
    return rows[0] ?? null;
  }

  async createGroup(accountId: string, passwordHash: string): Promise<GroupRow> {
    const id = randomUUID();
    const g: GroupRow = {
      id,
      accountId,
      passwordHash,
      schemaName: "grp_" + id.replaceAll("-", ""),
      createdAt: new Date().toISOString(),
    };
    // The UNIQUE("accountId") constraint is the create-race arbiter.
    await this.sql`INSERT INTO groups (id, "accountId", "passwordHash", "schemaName", "createdAt")
      VALUES (${g.id}, ${g.accountId}, ${g.passwordHash}, ${g.schemaName}, ${g.createdAt})`;
    return g;
  }

  async deleteGroup(id: string): Promise<void> {
    await this.sql`DELETE FROM groups WHERE id = ${id}`; // members/tokens cascade
  }

  async getMember(groupId: string, name: string): Promise<MemberRow | null> {
    const rows = await this.sql<MemberRow[]>`
      SELECT id, "groupId", name, "passwordHash", "createdAt"
      FROM members WHERE "groupId" = ${groupId} AND name = ${name}`;
    return rows[0] ?? null;
  }

  async createMember(groupId: string, name: string, passwordHash: string): Promise<MemberRow> {
    const m: MemberRow = {
      id: randomUUID(),
      groupId,
      name,
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    await this.sql`INSERT INTO members (id, "groupId", name, "passwordHash", "createdAt")
      VALUES (${m.id}, ${m.groupId}, ${m.name}, ${m.passwordHash}, ${m.createdAt})`;
    return m;
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
        schemaName: string;
        groupCreatedAt: string;
      }[]
    >`SELECT m.id AS "memberId", m."groupId" AS "groupId", m.name,
             m."passwordHash" AS "memberHash", m."createdAt" AS "memberCreatedAt",
             g.id AS gid, g."accountId" AS "accountId", g."passwordHash" AS "groupHash",
             g."schemaName" AS "schemaName", g."createdAt" AS "groupCreatedAt"
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
        schemaName: r.schemaName,
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

  async close(): Promise<void> {
    await this.sql.end();
  }
}
