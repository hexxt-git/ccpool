import { MemoryStorage, type Config, type Storage } from "@ccshare/core";
import { LibsqlStorage } from "@ccshare/storage-libsql";
import { PostgresStorage } from "@ccshare/storage-postgres";

/**
 * The only place a driver name is turned into an adapter. Adding a backend means
 * adding a case here and nothing at the call sites.
 */
export function makeStorage(cfg: Config): Storage {
  switch (cfg.storage.driver) {
    case "libsql":
    case "sqlite":
      return new LibsqlStorage(cfg.storage.url, cfg.storage.token);
    case "memory":
      return new MemoryStorage();
    case "postgres":
      return new PostgresStorage(cfg.storage.url);
    default:
      throw new Error(`unknown storage driver: ${cfg.storage.driver as string}`);
  }
}
