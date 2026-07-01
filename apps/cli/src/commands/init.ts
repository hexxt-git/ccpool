import {
  isValidName,
  resolveAccount,
  resolveConfigDir,
  SCHEMA_VERSION,
  type StorageDriver,
} from "@ccshare/core";
import { loadConfig, newConfig, saveConfig } from "../lib/config.js";
import { makeStorage } from "../lib/storage.js";
import { withPrompts } from "../lib/prompt.js";
import { validateUrl } from "../lib/validate.js";
import { runDaemonRestart, runDaemonStart } from "./daemon.js";

interface InitOptions {
  reconfigure?: boolean;
  /** Non-interactive overrides (for scripting/CI). Missing pieces are prompted. */
  driver?: StorageDriver;
  url?: string;
  token?: string;
  name?: string;
  /** Auto-confirm setting up an empty database (the prompt-on-empty gate). */
  yes?: boolean;
  /** Skip auto-starting the background observer (commander's `--no-daemon`). */
  daemon?: boolean;
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
    // Make sure the observer is running — this is idempotent (a no-op if it already
    // is), so re-running `ccshare init` after an update just brings it back up.
    if (opts.daemon !== false) await runDaemonStart();
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
        : "file:~/.ccshare/ccshare.db or libsql://team.turso.io";
    const url = opts.url ?? (await p.ask(`Enter the database URL [${urlHint}]`));
    if (!url) {
      console.error("A database URL is required.");
      process.exitCode = 1;
      return;
    }
    const urlErr = validateUrl(driver, url);
    if (urlErr) {
      console.error(urlErr);
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

    const configDir = resolveConfigDir();
    // Bind the ledger to the Claude *account* (accountUuid), never the email or the
    // ccshare person. Only a hydrated (onboarded) account has a real accountUuid;
    // before onboarding we leave the ledger unbound and claim it later (§1.5).
    const acct = await resolveAccount(configDir);
    const localAccountId = acct?.hydrated ? acct.id : null;

    const cfg = newConfig({ driver, url, token, name, configDirs: [configDir] });

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
          await storage.initializeSchema(localAccountId);
          await storage.upsertUser(name);
          console.log(`Set up ccshare (schema v${SCHEMA_VERSION}). Joined as "${name}".`);
          if (!localAccountId) {
            console.log(
              "Note: no Claude account detected yet — the ledger is unbound and will\n" +
                "bind to the first onboarded account that joins."
            );
          }
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
          // Refuse to join a ledger bound to a *different* Claude account — mixing
          // two accounts' tanks into one table corrupts attribution (§1.5). Checked
          // before any migrate/write. (Compares accountUuid, not email.)
          if (
            inspection.accountId != null &&
            localAccountId != null &&
            inspection.accountId !== localAccountId
          ) {
            console.error(
              "This ccshare database belongs to a different Claude account than the one\n" +
                `you're signed into (${acct?.email ?? "this machine"}). A shared ledger must\n` +
                "track a single account. Use that account, or point at a different database."
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
          // Claim an unbound ledger (pre-v2, or created before onboarding) for this
          // account. No-op when already bound; only sets a null binding.
          if (inspection.accountId == null && localAccountId != null) {
            await storage.bindAccount(localAccountId);
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
    console.log("Wrote config.");

    if (opts.daemon === false) {
      console.log("Start the shared observer when you're ready: `ccshare daemon start`.");
      return;
    }
    // Nothing left to do by hand — bring the observer up now. On a reconfigure we
    // restart so the running process picks up the new storage, not the old one.
    if (opts.reconfigure) await runDaemonRestart();
    else await runDaemonStart();
    console.log(
      "The observer runs in the background — stop it any time with `ccshare daemon stop`."
    );
  });
}
