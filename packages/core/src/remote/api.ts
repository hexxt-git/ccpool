import type { MessageUsage, ResetEvent, SharedView, UsageMarker, UsageSample } from "../types.js";

/**
 * The wire contract between the CLI and the ccpool server. Both ends import
 * these shapes from core, so they can't drift. All
 * bodies are JSON; auth'd endpoints take `Authorization: Bearer <token>`.
 */

/** Enforced by the server on create/join; the CLI pre-checks for better UX. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * GET /v1/groups/lookup?accountId=… — does a group already exist for this
 * Claude account? Unauthenticated (no password needed): it only reveals
 * existence, so the CLI can phrase onboarding as "create" vs "join" and word the
 * group-password prompt before asking for anything.
 */
export interface GroupLookupResponse {
  exists: boolean;
  memberExists?: boolean;
}

/** POST /v1/groups — create the group for this Claude account (first member). */
export interface CreateGroupRequest {
  /** The Claude accountUuid (hydrated only) the group is bound to. */
  accountId: string;
  /** The shared group password every future member must present to join. */
  groupPassword: string;
  memberName: string;
  /** This member's own password — protects the name from impersonation. */
  memberPassword: string;
}

/** POST /v1/groups/join — join (or re-key into) an existing group. */
export interface JoinGroupRequest {
  accountId: string;
  groupPassword: string;
  memberName: string;
  /** New name: sets its password. Existing name: must match its password. */
  memberPassword: string;
}

/** POST /v1/login — re-authenticate an existing member (no group password). */
export interface LoginRequest {
  accountId: string;
  memberName: string;
  memberPassword: string;
}

export interface AuthResponse {
  /** Bearer token, shown once — the server stores only its hash. */
  token: string;
  groupId: string;
  memberName: string;
}

/** POST /v1/ingest — one daemon tick. The server stamps rows with the
 * authenticated member's name; client-supplied `user` fields are overwritten. */
export interface IngestRequest {
  at: string; // ISO 8601 tick time on the sender
  accountId: string | null; // sender's hydrated accountUuid (conflict guard)
  samples: UsageSample[];
  resets: ResetEvent[];
  messages: MessageUsage[];
  markers: UsageMarker[];
}

/** GET /v1/bootstrap — the daemon's startup seed. */
export interface BootstrapResponse {
  accountId: string;
  samples: UsageSample[];
}

/** GET /v1/view — the compact precomputed view (ETag/If-None-Match aware). */
export type ViewResponse = SharedView;

export type ApiErrorCode =
  | "auth" // missing/bad token or wrong password
  | "account-conflict" // ingest for a different Claude account (409)
  | "not-found" // no group for this accountId (join/login)
  | "conflict" // group already exists / name taken with a different password
  | "invalid" // malformed body
  | "rate-limited";

export interface ApiError {
  error: string;
  code: ApiErrorCode;
}
