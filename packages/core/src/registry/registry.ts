/**
 * The registry's shared shapes: groups, members, and the atomic-signup inputs —
 * the server-owned identity tables that live in the same physical database as the
 * per-group ledgers (the ledger tables carry a `group_id` referencing
 * `groups(id)`). Core owns these row/input/error shapes; the concrete registry
 * (the SQL) lives in `@ccshare/storage-libsql` on `LibsqlDatabase`.
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

// The concrete registry (`LibsqlRegistry` in `@ccshare/storage-libsql`) exposes:
//   getGroupByAccount, getMember, resolveToken, insertToken, touchToken, and the
//   two composed atomic-signup ops createGroupWithMember / addMemberWithToken.
// Each composed op is one `batch(..., "write")` — every value is known up front —
// and deliberately crosses into the ledger tables (the group's `ccshare_meta`
// row, the `users` roster row, the `writeSeq` bump): provisioning atomically with
// identity is the point. A lost UNIQUE race throws {@link RegistryConflictError}
// and writes nothing.
