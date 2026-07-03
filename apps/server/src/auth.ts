import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

/**
 * Password hashing on node:crypto scrypt only (no native deps; Node ≥20 + Bun).
 * Stored strings are self-describing — `scrypt:N:r:p:<salt>:<hash>` (base64url)
 * — so the parameters can be raised later without migrating existing rows.
 */
const SCRYPT_N = 16384; // 16 MiB with r=8 — interactive-login strength
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
/** Comfortably above 128*N*r for the current params AND any raised-later ones. */
const MAX_MEM = 128 * 1024 * 1024;

export { MIN_PASSWORD_LENGTH } from "@ccshare/core";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await scrypt(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEM,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join(":");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(saltB64!, "base64url");
  const expected = Buffer.from(hashB64!, "base64url");
  try {
    const actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: MAX_MEM });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false; // absurd params (tampered row) — treat as no match
  }
}

/**
 * Bearer tokens: random, shown to the client once, stored server-side only as a
 * sha256 hex — a leaked registry table can't be replayed as credentials.
 */
export function mintToken(): { token: string; tokenHash: string } {
  const token = "ccs_" + randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * In-memory brute-force damper for the password endpoints: after a few failures
 * per key (the callers key on the target Claude accountId — the resource under
 * attack — never a client-supplied header), further attempts are refused for an
 * exponentially growing window. Deliberately not durable — a restart forgives,
 * which is acceptable for the launch posture and keeps the registry clean.
 */
export class FailureDamper {
  private failures = new Map<string, { count: number; blockedUntil: number }>();

  constructor(
    private readonly freeAttempts = 5,
    private readonly baseBlockMs = 1_000,
    private readonly maxBlockMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
    // Bound the map so a flood of distinct account ids can't grow it without
    // limit. Evicting the oldest key only ever forgives an attempt, which a
    // restart already does by design.
    private readonly maxTracked = 100_000
  ) {}

  /** True when this key must wait before another attempt. */
  isBlocked(key: string): boolean {
    const e = this.failures.get(key);
    return !!e && this.now() < e.blockedUntil;
  }

  recordFailure(key: string): void {
    const e = this.failures.get(key) ?? { count: 0, blockedUntil: 0 };
    e.count += 1;
    if (e.count > this.freeAttempts) {
      const exp = Math.min(
        this.maxBlockMs,
        this.baseBlockMs * 2 ** (e.count - this.freeAttempts - 1)
      );
      e.blockedUntil = this.now() + exp;
    }
    // Re-insert last so the map's insertion order is a rough LRU for eviction.
    this.failures.delete(key);
    this.failures.set(key, e);
    if (this.failures.size > this.maxTracked) {
      const oldest = this.failures.keys().next().value;
      if (oldest !== undefined) this.failures.delete(oldest);
    }
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }
}
