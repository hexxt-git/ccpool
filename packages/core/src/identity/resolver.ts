import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { globalConfigPath } from "./paths.js";

/**
 * The Claude *account* behind a config dir — never the ccpool person. Used to
 * scope the tank and confirm everyone's pointed at the same login.
 */
export interface AccountIdentity {
  id: string; // accountUuid, or a hash of userID when unhydrated
  email: string | null;
  displayName: string | null;
  /** False when only a pre-login `userID` was available (not onboarded yet). */
  hydrated: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function resolveAccount(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<AccountIdentity | null> {
  let raw: string;
  try {
    raw = await readFile(globalConfigPath(configDir, env), "utf8");
  } catch {
    return null;
  }

  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }

  const acct = j?.oauthAccount;
  if (acct && typeof acct.accountUuid === "string") {
    return {
      id: acct.accountUuid,
      email: typeof acct.emailAddress === "string" ? acct.emailAddress : null,
      displayName: typeof acct.displayName === "string" ? acct.displayName : null,
      hydrated: true,
    };
  }

  // Unhydrated: fall back to a stable hash of userID so the tank can still scope.
  if (j?.userID != null) {
    const id = createHash("sha256").update(String(j.userID)).digest("hex").slice(0, 12);
    return { id: `user-${id}`, email: null, displayName: null, hydrated: false };
  }

  return null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
