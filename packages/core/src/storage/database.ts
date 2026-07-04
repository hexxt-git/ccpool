import type { Registry } from "../registry/registry.js";
import type { Storage } from "./storage.js";

/**
 * One physical database, one process-wide pool/client. The `Database` owns the
 * connection lifecycle and both table families — the registry (groups / members
 * / tokens) and every group's ledger — so composed registry transactions can
 * provision a ledger atomically, and group-scoped `Storage` handles are cheap
 * facades over the shared pool instead of pools of their own.
 */
export interface Database {
  /**
   * Idempotent global DDL for BOTH the ledger and registry tables. Run once at
   * boot; after it, `forGroup(id).inspect()` reads `empty` for any group whose
   * `ccshare_meta` row doesn't exist yet.
   */
  init(): Promise<void>;
  readonly registry: Registry;
  /**
   * A group-scoped {@link Storage} facade sharing this Database's pool/client.
   * Cheap to create, safe to discard; its `close()` is a no-op — only
   * {@link Database.close} tears the pool down.
   */
  forGroup(groupId: string): Storage;
  close(): Promise<void>;
}
