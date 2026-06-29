// @ccshare/core — pure domain logic, runtime-agnostic. No UI, no process.

export * from "./types.js";
export * from "./storage/storage.js";
export { MemoryStorage } from "./storage/memory.js";
export { apportionShares } from "./state/shares.js";
export type { RawWeight } from "./state/shares.js";
export { bar, countdown, pctLabel, CAP_LABEL } from "./state/format.js";

// identity
export { resolveConfigDir, projectsDir, globalConfigPath } from "./identity/paths.js";
export { readCredentials, isTokenExpired } from "./identity/credentials.js";
export type { Credentials } from "./identity/credentials.js";
export { resolveAccount } from "./identity/resolver.js";
export type { AccountIdentity } from "./identity/resolver.js";

// usage
export { pollUsage, parseUsage, UsageAuthError, USAGE_URL, OAUTH_BETA } from "./usage/poller.js";
export type { PollOptions } from "./usage/poller.js";
export { detectResets } from "./usage/resets.js";

// state
export { buildLocalState, atomicWriteJson } from "./state/snapshot.js";
export type { SnapshotInput } from "./state/snapshot.js";
