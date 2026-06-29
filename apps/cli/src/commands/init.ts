import { isValidName, resolveConfigDir, SCHEMA_VERSION, type StorageDriver } from "@ccshare/core";
import { loadConfig, newConfig, saveConfig } from "../lib/config.js";
import { makeStorage } from "../lib/storage.js";
import { withPrompts } from "../lib/prompt.js";

interface InitOptions {
  reconfigure?: boolean;
  /** Non-interactive overrides (for scripting/CI). Missing pieces are prompted. */
  driver?: StorageDriver;
  url?: string;
  token?: string;
  name?: string;
  /** Auto-confirm setting up an empty database (the prompt-on-empty gate). */
  yes?: boolean;
}

/**
 * Required first run. Pick storage, enter the URL, inspect, then set up a clean
 * DB / join an existing ccshare DB / refuse an occupied one. Never writes its
 * tables alongside a foreign schema.
 *
 * Fully interactive by default; any field supplied as a flag skips its prompt,
 * so the whole flow can run non-interactively with --driver/--url/--name/--yes.
 */
export async function runInit(opts: InitOptions = {}): Promise<void> {
  const existing = await loadConfig();
  if (existing && !opts.reconfigure && !opts.url) {
    console.log(
      `Already initialized (storage: ${existing.storage.driver}, name: ${existing.name}).`
    );
    console.log("Re-run with `ccshare init --reconfigure` to change storage.");
    return;
  }

  await withPrompts(async (p) => {
    const driver =
      opts.driver ??
      (await p.select<StorageDriver>("Select a storage method:", [
        { label: "libsql  — local file or remote Turso (recommended)", value: "libsql" },
        { label: "postgres", value: "postgres" },
        { label: "sqlite  — local file", value: "sqlite" },
      ]));

    const urlHint =
      driver === "postgres"
        ? "postgres://user:pass@host/db"
        : "file:./ccshare.db or libsql://team.turso.io";
    const url = opts.url ?? (await p.ask(`Enter the database URL [${urlHint}]`));
    if (!url) {
      console.error("A database URL is required.");
      process.exitCode = 1;
      return;
    }

    const needsToken = driver === "libsql" && url.startsWith("libsql://");
    const token =
      opts.token ??
      (needsToken ? (await p.ask("Auth token (leave blank if none)")) || undefined : undefined);

    // identity (name) — reuse existing, else flag, else prompt
    const name =
      opts.name ?? existing?.name ?? (await p.ask("Choose a name (letters, digits, hyphens)"));
    if (!isValidName(name)) {
      console.error(`Invalid name "${name}" — use letters, digits, and hyphens only.`);
      process.exitCode = 1;
      return;
    }

    const cfg = newConfig({ driver, url, token, name, configDirs: [resolveConfigDir()] });

    const storage = makeStorage(cfg);
    let inspection;
    try {
      inspection = await storage.inspect();
    } catch (err) {
      console.error(`Could not connect to the database: ${(err as Error).message}`);
      process.exitCode = 1;
      await storage.close();
      return;
    }

    try {
      switch (inspection.kind) {
        case "empty": {
          const ok =
            opts.yes ||
            (await p.confirm(
              "This database is empty. Set up ccshare here? This creates ccshare's tables.",
              false
            ));
          if (!ok) {
            console.log("Aborted — nothing was written.");
            return;
          }
          await storage.initializeSchema();
          await storage.upsertUser(name);
          console.log(`Set up ccshare (schema v${SCHEMA_VERSION}). Joined as "${name}".`);
          break;
        }
        case "ccshare": {
          if (inspection.schemaVersion > SCHEMA_VERSION) {
            console.error(
              "This database uses a newer ccshare schema than this CLI understands. Upgrade ccshare."
            );
            process.exitCode = 1;
            return;
          }
          if (inspection.schemaVersion < SCHEMA_VERSION) {
            const ok =
              opts.yes ||
              (await p.confirm(
                `Migrate this database from schema v${inspection.schemaVersion} to v${SCHEMA_VERSION}?`,
                true
              ));
            if (!ok) {
              console.log("Aborted — nothing was changed.");
              return;
            }
            await storage.migrate(SCHEMA_VERSION);
          }
          await storage.upsertUser(name);
          console.log(`Joined existing ccshare database as "${name}".`);
          break;
        }
        case "foreign": {
          console.error(
            "This database already contains another project (or an incompatible ccshare\n" +
              "version). ccshare needs its own clean, dedicated database. Point it at an\n" +
              "empty database, or create a new one."
          );
          process.exitCode = 1;
          return;
        }
      }
    } finally {
      await storage.close();
    }

    await saveConfig(cfg);
    console.log(`Wrote config. You're set — try \`ccshare daemon start\`.`);
  });
}
