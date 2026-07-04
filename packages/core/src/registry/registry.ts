/**
 * The registry: groups, members, and bearer tokens — the server-owned identity
 * tables that live in the same physical database as the per-group ledgers (the
 * ledger tables carry a `group_id` referencing `groups(id)`). Core owns the
 * interface; each storage package implements it over its one shared pool/client
 * so the server never writes SQL.
 *
 * The registry stores opaque hash strings only — password (scrypt) and token
 * (sha256) hashing live in the server; nothing here ever sees a secret.
 */

export interface GroupRow {
  id: string;
  /** The Claude accountUuid this group is bound to (unique per server). */
  accountId: string;
  /** scrypt hash of the shared group password. */
  passwordHash: string;
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

/**
 * A composed registry write lost its uniqueness race. The transaction rolled
 * back — nothing was written (no group, no member, no token).
 */
export class RegistryConflictError extends Error {
  constructor(readonly kind: "group-exists" | "member-exists") {
    super(
      kind === "group-exists" ? "a group for this account already exists" : "member name is taken"
    );
    this.name = "RegistryConflictError";
  }
}

/** Everything `createGroupWithMember` writes, computed by the caller up front. */
export interface CreateGroupInput {
  accountId: string;
  groupPasswordHash: string;
  memberName: string;
  memberPasswordHash: string;
  /** sha256 of the first member's freshly minted bearer. */
  tokenHash: string;
}

/**
 * Signup flows are single transactions: every value (ids, hashes, timestamps)
 * is computable before the write, so each composed op is one atomic statement
 * list — Postgres `sql.begin`, libSQL `batch(..., "write")`, memory
 * validate-then-apply. The composed ops deliberately cross into the ledger
 * tables (the group's `ccshare_meta` row, the `users` roster row, the
 * `writeSeq` bump): provisioning atomically with identity is the point.
 */
export interface Registry {
  getGroupByAccount(accountId: string): Promise<GroupRow | null>;
  getMember(groupId: string, name: string): Promise<MemberRow | null>;
  /** One indexed lookup: token hash -> member + group, or null. */
  resolveToken(tokenHash: string): Promise<{ member: MemberRow; group: GroupRow } | null>;
  /** A lone token mint (login / existing-member rejoin) — single statement. */
  insertToken(tokenHash: string, memberId: string): Promise<void>;
  /** Update lastUsedAt (callers throttle; this is just the write). */
  touchToken(tokenHash: string): Promise<void>;
  /**
   * ONE transaction: the groups row + this group's `ccshare_meta` (bound to
   * `accountId`) + the first member + its `users` roster row + its token.
   * Throws {@link RegistryConflictError}("group-exists") when UNIQUE(accountId)
   * loses the create race; the transaction rolls back and nothing is written.
   */
  createGroupWithMember(input: CreateGroupInput): Promise<{ group: GroupRow; member: MemberRow }>;
  /**
   * ONE transaction: the member + its `users` roster row + the group's
   * `writeSeq` bump + its token. Throws
   * {@link RegistryConflictError}("member-exists") when UNIQUE(groupId, name)
   * loses a same-name race; nothing is written.
   */
  addMemberWithToken(
    groupId: string,
    name: string,
    passwordHash: string,
    tokenHash: string
  ): Promise<MemberRow>;
}
