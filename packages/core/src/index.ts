// @ccshare/core — pure domain logic, runtime-agnostic. No UI, no process.

export * from "./types.js";
export * from "./storage/storage.js";
export { MemoryStorage } from "./storage/memory.js";
export { apportionShares } from "./state/shares.js";
export type { RawWeight } from "./state/shares.js";
