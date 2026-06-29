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
  if (!o || typeof o.accessToken !== "string") {
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

/**
 * Read the stored credentials for an account's config dir, or null if none.
 *
 * - Linux / any platform: plaintext `<configDir>/.credentials.json`.
 * - macOS: the login keychain (`security find-generic-password`).
 *
 * Windows DPAPI is not yet supported; a plaintext file there still works.
 */
export async function readCredentials(configDir: string): Promise<Credentials | null> {
  // 1. plaintext file (Linux + universal fallback)
  try {
    return parse(await readFile(join(configDir, ".credentials.json"), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // 2. macOS keychain
  if (process.platform === "darwin") {
    for (const svc of keychainServices(configDir)) {
      try {
        const { stdout } = await pExecFile("security", ["find-generic-password", "-s", svc, "-w"]);
        return parse(stdout);
      } catch {
        // try the next service name
      }
    }
  }

  return null;
}
