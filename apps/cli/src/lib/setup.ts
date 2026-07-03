import {
  ApiRequestError,
  CcshareClient,
  MIN_PASSWORD_LENGTH,
  resolveAccount,
  resolveConfigDir,
  SCHEMA_VERSION,
  type Config,
  type StorageDriver,
} from "@ccshare/core";
import { newConfig, newSharedConfig, saveConfig } from "./config.js";
import { makeStorage } from "./storage.js";
import { resolveServerUrl, validateServerUrl } from "./backend.js";
import { validateUrl } from "./validate.js";

/**
 * Shared, non-interactive setup core used by the TUI onboarding wizard and the
 * storage-reconfigure screen. It mirrors the account-binding rules enforced by
 * the `init` flag command (see commands/init.ts and ALGORITHM.md §1.5) so both
 * entry points behave identically: an empty DB is initialized, an existing
 * ccshare DB is joined (migrated forward / claimed if unbound), and a foreign or
 * account-mismatched DB is refused.
 */

/** A connection inspection classified for the UI. Never writes. */
export type Classification =
  | { kind: "empty" }
  | { kind: "ccshare" } // joinable: compatible schema, same or unbound account
  | { kind: "ccshare-newer" } // schema newer than this build understands
  | { kind: "ccshare-foreign-account"; account: string | null } // bound elsewhere
  | { kind: "foreign" }
  | { kind: "error"; message: string };

export interface ConnInput {
  driver: StorageDriver;
  url: string;
  token?: string;
}

function probeConfig(input: ConnInput, configDir: string): Config {
  return newConfig({
    driver: input.driver,
    url: input.url,
    token: input.token,
    name: "probe",
    configDirs: [configDir],
  });
}

/**
 * Validate the URL, connect, and classify the target — the pre-write check the
 * wizard's "database" step and the reconfigure screen's "test connection" both
 * run before they let you proceed. Never writes.
 */
export async function inspectFor(input: ConnInput): Promise<Classification> {
  const urlErr = validateUrl(input.driver, input.url);
  if (urlErr) return { kind: "error", message: urlErr };

  const configDir = resolveConfigDir();
  const acct = await resolveAccount(configDir);
  const localAccountId = acct?.hydrated ? acct.id : null;

  const storage = makeStorage(probeConfig(input, configDir));
  try {
    const info = await storage.inspect();
    switch (info.kind) {
      case "empty":
        return { kind: "empty" };
      case "foreign":
        return { kind: "foreign" };
      case "ccshare":
        if (info.schemaVersion > SCHEMA_VERSION) return { kind: "ccshare-newer" };
        if (info.accountId != null && localAccountId != null && info.accountId !== localAccountId) {
          return { kind: "ccshare-foreign-account", account: acct?.email ?? null };
        }
        return { kind: "ccshare" };
    }
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  } finally {
    await storage.close();
  }
}

export type ApplyResult =
  | { ok: true; config: Config; note?: string }
  | { ok: false; error: string };

export type SharedJoinResult =
  | { ok: true; config: Config }
  /** `canCreate` — no group exists yet; ask the user, then retry with allowCreate. */
  | { ok: false; error: string; canCreate?: boolean };

export type SharedProbe =
  | {
      ok: true;
      account: { id: string; email: string | null };
      serverUrl: string;
      /** True when a group already exists for this account (→ join, not create). */
      groupExists: boolean;
      memberExists?: boolean;
    }
  | { ok: false; error: string };

/**
 * The pre-join look: resolve the (hydrated) Claude account, confirm the server
 * URL is usable, and ask the server whether a group already exists for this
 * account — all before prompting for a single password. Lets onboarding say
 * "you're on <email>, creating a new group" vs "…joining your team's group" and
 * word the group-password prompt accordingly. Surfaces the server URL in the
 * unreachable message so a misconfigured host is obvious (not a bare "fetch
 * failed").
 */
export async function probeSharedGroup(
  memberName?: string | null,
  cfg?: Config | null
): Promise<SharedProbe> {
  const configDir = resolveConfigDir();
  const acct = await resolveAccount(configDir);
  if (!acct?.hydrated) {
    return {
      ok: false,
      error:
        "no onboarded Claude account on this machine — sign into Claude Code first " +
        "(the group is tied to the account everyone shares)",
    };
  }
  const serverUrl = resolveServerUrl(cfg);
  const urlErr = validateServerUrl(serverUrl);
  if (urlErr) return { ok: false, error: urlErr };
  try {
    const { exists, memberExists } = await new CcshareClient(serverUrl).lookupGroup(
      acct.id,
      memberName || undefined
    );
    return {
      ok: true,
      account: { id: acct.id, email: acct.email },
      serverUrl,
      groupExists: exists,
      memberExists,
    };
  } catch (err) {
    return {
      ok: false,
      error: `could not reach the ccshare server at ${serverUrl}: ${(err as Error).message}`,
    };
  }
}

/**
 * The whole shared-hosting join in one call: resolve the (hydrated) account,
 * validate inputs, join the group — or create it when `allowCreate` — and save
 * the config + bearer token. Both the CLI `init` command and the TUI wizard
 * drive their create-confirmation off `canCreate`.
 */
export async function applySharedJoin(opts: {
  name: string;
  groupPassword: string;
  memberPassword: string;
  allowCreate: boolean;
  config?: Config | null;
}): Promise<SharedJoinResult> {
  const configDir = resolveConfigDir();
  // The group is located and bound by the Claude accountUuid — resolved locally,
  // never typed. Creation requires an onboarded account (§1.5, server-side).
  const acct = await resolveAccount(configDir);
  if (!acct?.hydrated) {
    return {
      ok: false,
      error:
        "no onboarded Claude account on this machine — sign into Claude Code first " +
        "(the group is tied to the account everyone shares)",
    };
  }

  const serverUrl = resolveServerUrl(opts.config);
  const urlErr = validateServerUrl(serverUrl);
  if (urlErr) return { ok: false, error: urlErr };

  for (const [label, pw] of [
    ["group password", opts.groupPassword],
    ["member password", opts.memberPassword],
  ] as const) {
    if (pw.length < MIN_PASSWORD_LENGTH) {
      return {
        ok: false,
        error: `the ${label} must be at least ${MIN_PASSWORD_LENGTH} characters`,
      };
    }
  }

  const client = new CcshareClient(serverUrl);
  const req = {
    accountId: acct.id,
    groupPassword: opts.groupPassword,
    memberName: opts.name,
    memberPassword: opts.memberPassword,
  };
  let auth;
  try {
    auth = await client.joinGroup(req);
  } catch (err) {
    if (err instanceof ApiRequestError && err.code === "not-found") {
      if (!opts.allowCreate) {
        return {
          ok: false,
          canCreate: true,
          error: `no group exists for ${acct.email ?? acct.id} yet`,
        };
      }
      try {
        auth = await client.createGroup(req);
      } catch (createErr) {
        return { ok: false, error: describeApiError(createErr, serverUrl) };
      }
    } else {
      return { ok: false, error: describeApiError(err, serverUrl) };
    }
  }

  const config = newSharedConfig({
    serverUrl,
    token: auth.token,
    name: auth.memberName,
    configDirs: [configDir],
  });
  await saveConfig(config);
  return { ok: true, config };
}

function describeApiError(err: unknown, serverUrl: string): string {
  if (err instanceof ApiRequestError) {
    switch (err.code) {
      case "auth":
        return `the server refused the passwords: ${err.message}`;
      case "conflict":
        return err.message;
      case "rate-limited":
        return "too many attempts — wait a moment and try again";
      default:
        return `server error: ${err.message}`;
    }
  }
  return `could not reach the ccshare server at ${serverUrl}: ${(err as Error).message}`;
}

/**
 * Set up / join the target for `cfg`, then persist `cfg`. The caller builds the
 * config (a fresh `newConfig` for onboarding, or a spread of the existing one for
 * a storage change) so identity, poll interval, and log level are preserved.
 */
export async function applySetup(cfg: Config): Promise<ApplyResult> {
  if (!cfg.storage) {
    return { ok: false, error: "no storage configured — this config is in shared-hosting mode" };
  }
  const urlErr = validateUrl(cfg.storage.driver, cfg.storage.url);
  if (urlErr) return { ok: false, error: urlErr };

  const configDir = cfg.configDirs[0] ?? resolveConfigDir();
  // Bind the ledger to the Claude *account* (accountUuid), never the email or the
  // ccshare person. Only a hydrated (onboarded) account has a real accountUuid.
  const acct = await resolveAccount(configDir);
  const localAccountId = acct?.hydrated ? acct.id : null;
  let note: string | undefined;

  const storage = makeStorage(cfg);
  try {
    const info = await storage.inspect();
    switch (info.kind) {
      case "empty":
        await storage.initializeSchema(localAccountId);
        await storage.upsertUser(cfg.name);
        if (!localAccountId) {
          note =
            "No Claude account detected yet — the ledger is unbound and will bind " +
            "to the first onboarded account that joins.";
        }
        break;
      case "ccshare": {
        if (info.schemaVersion > SCHEMA_VERSION) {
          return {
            ok: false,
            error:
              "This database uses a newer ccshare schema than this build understands. " +
              "Update ccshare.",
          };
        }
        if (info.accountId != null && localAccountId != null && info.accountId !== localAccountId) {
          return {
            ok: false,
            error:
              "This ccshare database is bound to a different Claude account than " +
              `${acct?.email ?? "this machine"}. A shared ledger tracks a single account.`,
          };
        }
        if (info.schemaVersion < SCHEMA_VERSION) await storage.migrate(SCHEMA_VERSION);
        // Claim an unbound ledger for this account (no-op when already bound).
        if (info.accountId == null && localAccountId != null) {
          await storage.bindAccount(localAccountId);
        }
        await storage.upsertUser(cfg.name);
        break;
      }
      case "foreign":
        return {
          ok: false,
          error:
            "This database already contains another project. ccshare needs its own " +
            "clean, dedicated database.",
        };
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    await storage.close();
  }

  await saveConfig(cfg);
  return { ok: true, config: cfg, note };
}
