import {
  isValidName,
  resolveAccount,
  resolveConfigDir,
  SCHEMA_VERSION,
  type Mode,
  type StorageDriver,
} from "@ccshare/core";
import { loadConfig, newConfig, saveConfig } from "../lib/config.js";
import { makeStorage } from "../lib/storage.js";
import { resolveServerUrl } from "../lib/backend.js";
import { applySharedJoin, probeSharedGroup } from "../lib/setup.js";
import { withPrompts, type Prompts } from "../lib/prompt.js";
import { validateUrl } from "../lib/validate.js";
import { runDaemonRestart, runDaemonStart } from "./daemon.js";

interface InitOptions {
  reconfigure?: boolean;
  /** Non-interactive overrides (for scripting/CI). Missing pieces are prompted. */
  mode?: Mode;
  driver?: StorageDriver;
  url?: string;
  token?: string;
  name?: string;
  /** Shared hosting: flags leak into shell history — prefer the env fallbacks
   * CCSHARE_GROUP_PASSWORD / CCSHARE_MEMBER_PASSWORD in CI. */
  groupPassword?: string;
  memberPassword?: string;
  /** Auto-confirm the write step (initialize empty DB / create the group). */
  yes?: boolean;
  /** Skip auto-starting the background observer (commander's `--no-daemon`). */
  daemon?: boolean;
}

/**
 * Required first run. Two ways to share one ledger:
 * - shared hosting (default): the hosted ccshare server; a member enters the
 *   group password + their own member password and never sees a database.
 * - self-host: pick a storage driver, enter the URL, inspect, then set up a
 *   clean DB / join an existing ccshare DB / refuse an occupied one.
 *
 * Fully interactive by default; any field supplied as a flag skips its prompt,
 * so the whole flow can run non-interactively.
 */
export async function runInit(opts: InitOptions = {}): Promise<void> {
  const existing = await loadConfig();
  if (existing && !opts.reconfigure && !opts.url && !opts.mode) {
    console.log(
      `Already initialized (${
        existing.mode === "shared"
          ? `shared hosting: ${resolveServerUrl(existing)}`
          : `storage: ${existing.storage?.driver}`
      }, name: ${existing.name}).`
    );
    // Make sure the observer is running — this is idempotent (a no-op if it already
    // is), so re-running `ccshare init` after an update just brings it back up.
    if (opts.daemon !== false) await runDaemonStart();
    console.log("Re-run with `ccshare init --reconfigure` to change the setup.");
    return;
  }

  await withPrompts(async (p) => {
    // Any self-host-specific flag implies self-host; otherwise ask, shared first.
    const mode: Mode =
      opts.mode ??
      (opts.driver || opts.url
        ? "selfhost"
        : await p.select<Mode>("How should this group share its data?", [
            { label: "shared hosting — the ccshare server; just two passwords", value: "shared" },
            { label: "self-host — your own database (libsql/sqlite/postgres)", value: "selfhost" },
          ]));

    // Each branch resolves the name itself: shared shows the account + server and
    // whether you're creating vs joining a group *before* asking, so the prompts
    // are worded for your situation.
    const done =
      mode === "shared"
        ? await sharedInit(p, opts, existing)
        : await selfhostInit(p, opts, existing);
    if (!done) return;

    if (opts.daemon === false) {
      console.log("Start the shared observer when you're ready: `ccshare daemon start`.");
      return;
    }
    // Nothing left to do by hand — bring the observer up now. On a reconfigure we
    // restart so the running process picks up the new backend, not the old one.
    if (opts.reconfigure || existing) await runDaemonRestart();
    else await runDaemonStart();
    console.log(
      "The observer runs in the background — stop it any time with `ccshare daemon stop`."
    );
  });
}

/** Ask for a name (flag wins; else prompt, defaulting to the current name). */
async function askName(
  p: Prompts,
  opts: InitOptions,
  existing: { name: string } | null
): Promise<string | null> {
  const name =
    opts.name ?? (await p.ask("Choose your name (letters, digits, hyphens)", existing?.name));
  if (!isValidName(name)) {
    console.error(`Invalid name "${name}" — use letters, digits, and hyphens only.`);
    process.exitCode = 1;
    return null;
  }
  return name;
}

/**
 * The shared-hosting branch. Shows the Claude account and the server URL, then
 * looks up whether a group already exists for this account so it can say
 * "create" vs "join" and word the group-password prompt — all before asking for
 * anything. Order matches the mental model: see who/where you are → group
 * password → your name → your own password.
 */
async function sharedInit(
  p: Prompts,
  opts: InitOptions,
  existing: { name: string } | null
): Promise<boolean> {
  const probe = await probeSharedGroup();
  if (!probe.ok) {
    console.error(probe.error);
    process.exitCode = 1;
    return false;
  }

  console.log(`You're signed into Claude as ${probe.account.email ?? probe.account.id}.`);
  console.log(`ccshare server: ${probe.serverUrl}`);
  console.log(
    probe.groupExists
      ? "A group already exists for this account — you'll join it with the team's group password."
      : "No ccshare group exists for this account yet — you'll create one and set its group password."
  );

  const groupPassword =
    opts.groupPassword ??
    process.env.CCSHARE_GROUP_PASSWORD ??
    (await p.ask(
      probe.groupExists
        ? "Group password (the one your team set)"
        : "New group password (everyone will use this to join)"
    ));

  const name = await askName(p, opts, existing);
  if (name === null) return false;

  const memberPassword =
    opts.memberPassword ??
    process.env.CCSHARE_MEMBER_PASSWORD ??
    (await p.ask(`Your own password for "${name}" (protects your name from impersonation)`));

  // With the probe we already know create vs join, so allowCreate follows it —
  // but keep the confirm for the create case (a first member is a real decision),
  // and still fall back to the create prompt if the group vanished in between.
  let res = await applySharedJoin({
    name,
    groupPassword,
    memberPassword,
    allowCreate: false,
  });
  if (!res.ok && res.canCreate) {
    const ok =
      opts.yes || (await p.confirm(`No group exists for this account yet — create it now?`, true));
    if (!ok) {
      console.log("Aborted — nothing was created.");
      return false;
    }
    res = await applySharedJoin({ name, groupPassword, memberPassword, allowCreate: true });
  }
  if (!res.ok) {
    console.error(res.error);
    process.exitCode = 1;
    return false;
  }
  console.log(
    `${probe.groupExists ? "Joined" : "Created and joined"} the group as "${res.config.name}" ` +
      `(server: ${resolveServerUrl(res.config)}). Wrote config.`
  );
  return true;
}

/** The self-host branch: name → inspect → initialize/join/refuse flow. */
async function selfhostInit(
  p: Prompts,
  opts: InitOptions,
  existing: { name: string } | null
): Promise<boolean> {
  const name = await askName(p, opts, existing);
  if (name === null) return false;

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
    return false;
  }
  const urlErr = validateUrl(driver, url);
  if (urlErr) {
    console.error(urlErr);
    process.exitCode = 1;
    return false;
  }

  const needsToken = driver === "libsql" && url.startsWith("libsql://");
  const token =
    opts.token ??
    (needsToken ? (await p.ask("Auth token (leave blank if none)")) || undefined : undefined);

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
    return false;
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
          return false;
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
          return false;
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
          return false;
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
            return false;
          }
          await storage.migrate(SCHEMA_VERSION);
        }
        // Claim an unbound ledger (created before onboarding) for this account.
        // No-op when already bound; only sets a null binding.
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
        return false;
      }
    }
  } finally {
    await storage.close();
  }

  await saveConfig(cfg);
  console.log("Wrote config.");
  return true;
}
