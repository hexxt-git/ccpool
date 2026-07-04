import postgres, { type Sql } from "postgres";
import type { Database, Registry, Storage } from "@ccshare/core";
import { runLedgerDdl, runRegistryDdl } from "./ddl.js";
import { PgRegistry } from "./registry.js";
import { PostgresStorage } from "./storage.js";

export interface PostgresDatabaseOptions {
  /** Pool size — the ONE pool the whole process shares. */
  max?: number;
  /** Seconds an idle pooled connection lives before being reaped. */
  idleTimeoutSecs?: number;
}

const DEFAULT_POOL_MAX = 10;

/**
 * One Postgres database, one process-wide pool. Owns both table families —
 * the registry and every group's ledger — so composed registry transactions
 * provision ledgers atomically, and `forGroup` hands out facades instead of
 * per-group pools.
 */
export class PostgresDatabase implements Database {
  private readonly sql: Sql;
  readonly registry: Registry;

  constructor(url: string, opts: PostgresDatabaseOptions = {}) {
    this.sql = postgres(url, {
      onnotice: () => {},
      max: opts.max ?? DEFAULT_POOL_MAX,
      ...(opts.idleTimeoutSecs !== undefined ? { idle_timeout: opts.idleTimeoutSecs } : {}),
    });
    this.registry = new PgRegistry(this.sql);
  }

  async init(): Promise<void> {
    await this.sql.begin(async (tx) => {
      await runLedgerDdl(tx);
      await runRegistryDdl(tx);
    });
  }

  forGroup(groupId: string): Storage {
    return new PostgresStorage(this.sql, groupId);
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
