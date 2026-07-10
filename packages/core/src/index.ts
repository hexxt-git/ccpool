// @ccshare/core — pure domain logic, runtime-agnostic. No UI, no process.

export * from "./types.js";
export * from "./storage/storage.js";

// Registry data types + the atomic-signup conflict error. The registry itself is
// implemented concretely by the server's backend (@ccshare/storage-libsql); core
// only owns the shared row/error shapes and the group-scoped `Storage` boundary.
export { RegistryConflictError } from "./registry/registry.js";
export type { CreateGroupInput, GroupRow, MemberRow } from "./registry/registry.js";
export { attributeShares, CAP_WINDOW_MS } from "./state/shares.js";
export { summarizeMembers, isActive, ACTIVE_WINDOW_MS } from "./state/members.js";
export type { MemberSummary } from "./state/members.js";
export { bar, countdown, pctLabel, CAP_LABEL } from "./state/format.js";
export { assembleSharedView, computeSharedView, viewCacheKey, RETENTION_MS } from "./state/view.js";
export type { LedgerRows } from "./state/view.js";

// HTTP client (talks to apps/server over the wire contract below)
export { ApiRequestError, CcshareClient, HttpIngestSink, HttpViewSource } from "./remote/client.js";

// wire contract (imported by both the server and the client)
export { MIN_PASSWORD_LENGTH } from "./remote/api.js";
export type {
  ApiError,
  ApiErrorCode,
  AuthResponse,
  BootstrapResponse,
  CreateGroupRequest,
  IngestRequest,
  JoinGroupRequest,
  LoginRequest,
  ViewResponse,
} from "./remote/api.js";

// backend boundary (what daemons write through / views read through)
export { AccountConflictError } from "./backend/sink.js";
export type { IngestSink, IngestBootstrap, IngestMeta } from "./backend/sink.js";
export type { ViewSource } from "./backend/view-source.js";
export { StorageIngestSink, StorageViewSource } from "./backend/storage.js";
export type { StorageIngestSinkOptions } from "./backend/storage.js";
export { LedgerWindow } from "./backend/window.js";

// identity
export { resolveConfigDir, projectsDir, globalConfigPath } from "./identity/paths.js";
export { readCredentials, isTokenExpired } from "./identity/credentials.js";
export type { Credentials } from "./identity/credentials.js";
export { resolveAccount } from "./identity/resolver.js";
export type { AccountIdentity } from "./identity/resolver.js";

// usage
export {
  pollUsage,
  parseUsage,
  UsageAuthError,
  UsageRequestError,
  USAGE_URL,
  OAUTH_BETA,
} from "./usage/poller.js";
export type { PollOptions } from "./usage/poller.js";
export { detectResets } from "./usage/resets.js";

// state
export { buildLocalState, atomicWriteJson } from "./state/snapshot.js";
export type { SnapshotInput } from "./state/snapshot.js";

// jsonl
export { JsonlReader, parseLine } from "./jsonl/reader.js";
