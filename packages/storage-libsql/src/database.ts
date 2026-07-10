import { createClient, type Client } from "@libsql/client";
import type { Storage } from "@ccshare/core";
import { LEDGER_DDL, REGISTRY_DDL } from "./ddl.js";
import { LibsqlRegistry } from "./registry.js";
import { LibsqlStorage } from "./storage.js";
import { ensureFileDir, normalizeUrl } from "./url.js";

export interface LibsqlDatabaseOptions {
  /** Auth token for a remote `libsql://` (Turso) database. */
  authToken?: string;
}

/**
 * One libSQL database, one process-wide client — the single thing the server
 * opens. Owns both table families (the registry and every group's ledger) so
 * composed registry transactions provision ledgers atomically, and `forGroup`
 * hands out cheap group-scoped `Storage` facades over the shared client instead
 * of per-group clients (a facade's `close()` is a no-op; only this `close()`
 * tears the client down).
 */
export class LibsqlDatabase {
  private readonly client: Client;
  readonly registry: LibsqlRegistry;

  constructor(url: string, opts: LibsqlDatabaseOptions = {}) {
    // Normalize `~` / bare-path `file:` URLs (libsql rejects `~`) and make sure
    // the parent directory exists before opening the file.
    const normalized = normalizeUrl(url);
    ensureFileDir(normalized);
    this.client = createClient(
      opts.authToken ? { url: normalized, authToken: opts.authToken } : { url: normalized }
    );
    this.registry = new LibsqlRegistry(this.client);
  }

  async init(): Promise<void> {
    await this.client.batch([...LEDGER_DDL, ...REGISTRY_DDL], "write");
  }

  forGroup(groupId: string): Storage {
    return new LibsqlStorage(this.client, groupId);
  }

  async close(): Promise<void> {
    this.client.close();
  }
}
