import { afterAll, describe, expect, it } from "vitest";
import { RegistryConflictError, type CreateGroupInput } from "../src/index.js";
import type { LibsqlDatabase } from "@ccshare/storage-libsql";

/**
 * The registry/database contract for `LibsqlDatabase` — the one backend. Proves
 * the composed signup ops are atomic (a lost race writes NOTHING — no group,
 * member, token, or roster row) and that the registry provisions the group's
 * ledger in the same transaction.
 */
export interface RegistryContractHarness {
  name: string;
  /** A fresh, initialized (init() already run) database. */
  fresh(): Promise<LibsqlDatabase>;
}

function input(overrides: Partial<CreateGroupInput> = {}): CreateGroupInput {
  return {
    accountId: "acc-1",
    groupPasswordHash: "group-hash",
    memberName: "sam",
    memberPasswordHash: "member-hash",
    tokenHash: "token-hash-1",
    ...overrides,
  };
}

export function runRegistryContract(h: RegistryContractHarness): void {
  describe(`Registry contract: ${h.name}`, () => {
    const opened: LibsqlDatabase[] = [];
    const open = async () => {
      const db = await h.fresh();
      opened.push(db);
      return db;
    };
    afterAll(async () => {
      await Promise.all(opened.map((db) => db.close().catch(() => {})));
    });

    it("creates a group with its first member, token, and provisioned ledger", async () => {
      const db = await open();
      const { group, member } = await db.registry.createGroupWithMember(input());

      expect(group.accountId).toBe("acc-1");
      expect(member.groupId).toBe(group.id);
      expect(member.name).toBe("sam");

      // Identity lookups agree with what the composed op returned.
      expect(await db.registry.getGroupByAccount("acc-1")).toEqual(group);
      expect(await db.registry.getMember(group.id, "sam")).toEqual(member);
      const resolved = await db.registry.resolveToken("token-hash-1");
      expect(resolved).toEqual({ member, group });

      // The ledger was provisioned in the same transaction: meta row bound to
      // the account, roster carrying the first member.
      const storage = db.forGroup(group.id);
      expect(await storage.inspect()).toMatchObject({ kind: "ccshare", accountId: "acc-1" });
      expect((await storage.getUsers()).map((u) => u.name)).toEqual(["sam"]);
    });

    it("a lost group-create race writes nothing", async () => {
      const db = await open();
      const { group } = await db.registry.createGroupWithMember(input());
      const winnerToken = await db.forGroup(group.id).getChangeToken();

      await expect(
        db.registry.createGroupWithMember(
          input({ memberName: "mallory", tokenHash: "loser-token" })
        )
      ).rejects.toThrow(RegistryConflictError);
      await expect(
        db.registry.createGroupWithMember(input({ tokenHash: "loser-token" }))
      ).rejects.toMatchObject({ kind: "group-exists" });

      // Nothing from the losers survived: token unresolvable, member absent,
      // the winner's roster and change token untouched.
      expect(await db.registry.resolveToken("loser-token")).toBeNull();
      expect(await db.registry.getMember(group.id, "mallory")).toBeNull();
      expect((await db.forGroup(group.id).getUsers()).map((u) => u.name)).toEqual(["sam"]);
      expect(await db.forGroup(group.id).getChangeToken()).toBe(winnerToken);
    });

    it("adds a member atomically: member + roster row + change-token bump + token", async () => {
      const db = await open();
      const { group } = await db.registry.createGroupWithMember(input());
      const before = await db.forGroup(group.id).getChangeToken();

      const member = await db.registry.addMemberWithToken(group.id, "alex", "h2", "token-hash-2");
      expect(member).toMatchObject({ groupId: group.id, name: "alex" });
      expect(await db.registry.resolveToken("token-hash-2")).toEqual({ member, group });
      expect((await db.forGroup(group.id).getUsers()).map((u) => u.name)).toEqual(["alex", "sam"]);
      // The roster changed, so the view cache key must move.
      expect(await db.forGroup(group.id).getChangeToken()).not.toBe(before);
    });

    it("a lost member-name race writes nothing", async () => {
      const db = await open();
      const { group } = await db.registry.createGroupWithMember(input());
      const before = await db.forGroup(group.id).getChangeToken();

      await expect(
        db.registry.addMemberWithToken(group.id, "sam", "other-hash", "loser-token")
      ).rejects.toMatchObject({ kind: "member-exists" });

      expect(await db.registry.resolveToken("loser-token")).toBeNull();
      // The original member's hash is intact and no spurious write moved the token.
      expect((await db.registry.getMember(group.id, "sam"))?.passwordHash).toBe("member-hash");
      expect(await db.forGroup(group.id).getChangeToken()).toBe(before);
    });

    it("mints standalone tokens (login / rejoin) and touches them", async () => {
      const db = await open();
      const { member, group } = await db.registry.createGroupWithMember(input());

      await db.registry.insertToken("token-hash-2", member.id);
      expect(await db.registry.resolveToken("token-hash-2")).toEqual({ member, group });
      await db.registry.touchToken("token-hash-2"); // must not throw; write-only

      expect(await db.registry.resolveToken("no-such-token")).toBeNull();
    });

    it("scopes members and rosters to their group within one Database", async () => {
      const db = await open();
      const a = (await db.registry.createGroupWithMember(input())).group;
      const b = (
        await db.registry.createGroupWithMember(
          input({ accountId: "acc-2", memberName: "bea", tokenHash: "token-hash-b" })
        )
      ).group;

      // Same name in both groups is fine; lookups never cross groups.
      await db.registry.addMemberWithToken(b.id, "sam", "h-b", "token-hash-b2");
      expect((await db.registry.getMember(a.id, "sam"))?.passwordHash).toBe("member-hash");
      expect((await db.registry.getMember(b.id, "sam"))?.passwordHash).toBe("h-b");
      expect(await db.registry.getMember(a.id, "bea")).toBeNull();

      expect((await db.forGroup(a.id).getUsers()).map((u) => u.name)).toEqual(["sam"]);
      expect((await db.forGroup(b.id).getUsers()).map((u) => u.name)).toEqual(["bea", "sam"]);
    });
  });
}
