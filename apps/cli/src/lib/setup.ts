import {
  ApiRequestError,
  CcpoolClient,
  MIN_PASSWORD_LENGTH,
  resolveAccount,
  resolveConfigDir,
  type Config,
} from "@ccpool/core";
import { newConfig, saveConfig } from "./config.js";
import { resolveServerUrl, validateServerUrl } from "./backend.js";

/**
 * Shared, non-interactive setup core used by the TUI onboarding wizard and the
 * `init` command. It resolves the Claude account, joins (or creates) the group on
 * the ccpool server, and saves the config + bearer token. Account binding is the
 * server's job (algorithm docs, Observation → "Account binding") — the client only ever speaks HTTP.
 */

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
    const { exists, memberExists } = await new CcpoolClient(serverUrl).lookupGroup(
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
      error: `could not reach the ccpool server at ${serverUrl}: ${(err as Error).message}`,
    };
  }
}

/**
 * The whole join in one call: resolve the (hydrated) account, validate inputs,
 * join the group — or create it when `allowCreate` — and save the config + bearer
 * token. Both the CLI `init` command and the TUI wizard drive their
 * create-confirmation off `canCreate`.
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
  // never typed. Creation requires an onboarded account (the "Account binding" section, server-side).
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

  const client = new CcpoolClient(serverUrl);
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

  const config = newConfig({
    serverUrl,
    token: auth.token,
    name: auth.memberName,
    accountId: acct.id,
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
  return `could not reach the ccpool server at ${serverUrl}: ${(err as Error).message}`;
}
