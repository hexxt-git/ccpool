// @ccshare/storage-libsql — default adapter (Node + Bun; file: and libsql://).
// Real implementation lands in Phase 2; this keeps the package buildable.

export const DRIVER = "libsql" as const;
