import { LibsqlDatabase } from "@ccshare/storage-libsql";
import type { ServerDeps } from "./deps.js";
import { TenantCache } from "./tenants.js";

export interface ServerBackendConfig {
  /** A `file:` path (local SQLite) or a `libsql://…` (remote Turso) URL. */
  url: string;
  /** Auth token for a remote `libsql://` (Turso) database. */
  authToken?: string;
}

/**
 * Read the libSQL connection from the environment: `DATABASE_URL` (a `file:`
 * path or a `libsql://…` Turso URL) and, for a remote database,
 * `CCSHARE_DB_AUTH_TOKEN`.
 */
export function resolveServerBackend(env = process.env): ServerBackendConfig {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL is required — a file: path or a libsql://… (Turso) URL");
  }
  return { url, authToken: env.CCSHARE_DB_AUTH_TOKEN?.trim() || undefined };
}

/**
 * Compose the server's dependencies: ONE {@link LibsqlDatabase} (one client for
 * the whole process — registry and every group's ledger) and a connection-free
 * tenant cache over it.
 */
export function makeServerDeps(cfg: ServerBackendConfig): ServerDeps {
  const db = new LibsqlDatabase(cfg.url, { authToken: cfg.authToken });
  return { db, registry: db.registry, tenants: new TenantCache(db) };
}
