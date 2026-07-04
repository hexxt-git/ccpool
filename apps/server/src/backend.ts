import { LibsqlDatabase } from "@ccshare/storage-libsql";
import { PostgresDatabase } from "@ccshare/storage-postgres";
import type { ServerDeps } from "./deps.js";
import { TenantCache } from "./tenants.js";

/** The databases the server can run on. Both use the same relational group_id model. */
export type ServerDriver = "postgres" | "libsql";

export interface ServerBackendConfig {
  driver: ServerDriver;
  /** postgres://… (postgres) or file:/libsql://… (libsql). */
  url: string;
  /** libsql only: auth token for a remote Turso database. */
  authToken?: string;
  /** postgres only: size of the ONE process-wide pool. */
  pgPoolMax?: number;
}

/**
 * Pick the driver + connection from the environment. `CCSHARE_DB_DRIVER` forces
 * it; otherwise a `postgres://` / `postgresql://` `DATABASE_URL` is Postgres and
 * anything else (a `file:` path, `libsql://…`) is libSQL.
 */
export function resolveServerBackend(env = process.env): ServerBackendConfig {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is required — postgres://… for Postgres, or file:/…/libsql://… for libSQL"
    );
  }
  const forced = env.CCSHARE_DB_DRIVER?.trim().toLowerCase();
  const driver: ServerDriver =
    forced === "postgres" || forced === "libsql"
      ? forced
      : url.startsWith("postgres://") || url.startsWith("postgresql://")
        ? "postgres"
        : "libsql";
  const poolMax = Number(env.CCSHARE_PG_POOL_MAX);
  return {
    driver,
    url,
    authToken: env.CCSHARE_DB_AUTH_TOKEN?.trim() || undefined,
    ...(Number.isFinite(poolMax) && poolMax > 0 ? { pgPoolMax: poolMax } : {}),
  };
}

/**
 * Compose the server's dependencies: ONE `Database` (one pool/client for the
 * whole process — registry and every group's ledger) and a connection-free
 * tenant cache over it.
 */
export function makeServerDeps(cfg: ServerBackendConfig): ServerDeps {
  const db =
    cfg.driver === "postgres"
      ? new PostgresDatabase(cfg.url, { max: cfg.pgPoolMax })
      : new LibsqlDatabase(cfg.url, { authToken: cfg.authToken });
  return { db, registry: db.registry, tenants: new TenantCache(db) };
}
