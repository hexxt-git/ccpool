import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

/** The OAuth token Claude Code already stored. We read it; we never mint one. */
export interface Credentials {
  accessToken: string;
  expiresAt: number; // epoch ms
  refreshToken?: string;
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

/** Always verify before using the token (§9). Treats missing expiry as expired. */
export function isTokenExpired(
  c: Pick<Credentials, "expiresAt">,
  now: number = Date.now()
): boolean {
  return !Number.isFinite(c.expiresAt) || now >= c.expiresAt;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function parse(raw: string): Credentials {
  const j = JSON.parse(raw) as any;
  const o = j?.claudeAiOauth ?? j;
  if (!o || typeof o.accessToken !== "string" || o.accessToken.length === 0) {
    throw new Error("credentials JSON missing claudeAiOauth.accessToken");
  }
  return {
    accessToken: o.accessToken,
    expiresAt: Number(o.expiresAt),
    refreshToken: typeof o.refreshToken === "string" ? o.refreshToken : undefined,
    subscriptionType: o.subscriptionType ?? null,
    rateLimitTier: o.rateLimitTier ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** macOS keychain service names to try, plain first then the hashed variant. */
function keychainServices(configDir: string): string[] {
  const hash = createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  return ["Claude Code-credentials", `Claude Code-credentials-${hash}`];
}

/** Reads each macOS keychain service, returning the raw JSON blobs it finds. */
async function readKeychainDefault(services: string[]): Promise<string[]> {
  if (process.platform !== "darwin") return [];
  const blobs: string[] = [];
  for (const svc of services) {
    try {
      const { stdout } = await pExecFile("security", ["find-generic-password", "-s", svc, "-w"]);
      blobs.push(stdout);
    } catch {
      // service not present — try the next name
    }
  }
  return blobs;
}

export interface ReadCredentialsOptions {
  /** Epoch ms used to judge freshness. Defaults to `Date.now()`. */
  now?: number;
  /** Overrides the macOS keychain read (raw JSON blobs). A testing seam. */
  readKeychain?: (services: string[]) => Promise<string[]>;
}

/**
 * Read the stored credentials for an account's config dir, or null if none.
 *
 * - Linux / any platform: plaintext `<configDir>/.credentials.json`.
 * - macOS: the login keychain (`security find-generic-password`).
 *
 * Windows DPAPI is not yet supported; a plaintext file there still works.
 *
 * Every source is only a *cache* of the OAuth token Claude Code minted, and any
 * of them can go stale: on macOS the plaintext file is Claude Code's fallback
 * when the keychain is briefly locked, and it is never deleted once the keychain
 * recovers — so it can linger for weeks with a long-expired token while the
 * keychain holds the live one. We therefore never let an expired source shadow a
 * live one: return the first *fresh* token found, and only fall back to an
 * expired source (so the caller can report "expired") when nothing fresher
 * exists anywhere.
 */
export async function readCredentials(
  configDir: string,
  opts: ReadCredentialsOptions = {}
): Promise<Credentials | null> {
  const now = opts.now ?? Date.now();
  const readKeychain = opts.readKeychain ?? readKeychainDefault;

  // First readable-but-expired source, kept as a last resort so a caller still
  // sees "expired" (and logs accordingly) rather than a bare "no credentials".
  let stale: Credentials | null = null;
  const take = (c: Credentials): Credentials | null => {
    if (!isTokenExpired(c, now)) return c;
    stale ??= c;
    return null;
  };

  // 1. plaintext file (Linux + universal fallback). A malformed-but-present file
  //    is a real error we surface; only "not there" (ENOENT) falls through.
  try {
    const fresh = take(parse(await readFile(join(configDir, ".credentials.json"), "utf8")));
    if (fresh) return fresh;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // 2. macOS keychain — the source of truth on darwin. A live token here must win
  //    over a stale file above, so we always consult it when the file wasn't fresh.
  for (const blob of await readKeychain(keychainServices(configDir))) {
    let c: Credentials;
    try {
      c = parse(blob);
    } catch {
      continue; // malformed keychain entry — try the next
    }
    const fresh = take(c);
    if (fresh) return fresh;
  }

  return stale;
}
