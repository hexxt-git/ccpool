import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTokenExpired, readCredentials } from "./credentials.js";

describe("isTokenExpired", () => {
  it("is false before expiry, true at/after, true when missing", () => {
    expect(isTokenExpired({ expiresAt: 2000 }, 1000)).toBe(false);
    expect(isTokenExpired({ expiresAt: 1000 }, 1000)).toBe(true);
    expect(isTokenExpired({ expiresAt: 500 }, 1000)).toBe(true);
    expect(isTokenExpired({ expiresAt: NaN }, 1000)).toBe(true);
  });
});

describe("readCredentials (plaintext file)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccshare-creds-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // On macOS the lookup falls through to the login keychain, whose contents are
  // host-dependent, so this assertion only holds where there's no keychain path.
  it.skipIf(process.platform === "darwin")("returns null when no credentials exist", async () => {
    expect(await readCredentials(dir)).toBeNull();
  });

  it("reads claudeAiOauth from a plaintext .credentials.json", async () => {
    await writeFile(
      join(dir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "tok",
          expiresAt: 1893456000000,
          refreshToken: "ref",
          subscriptionType: "pro",
          rateLimitTier: null,
        },
      })
    );
    const creds = await readCredentials(dir);
    expect(creds).toEqual({
      accessToken: "tok",
      expiresAt: 1893456000000,
      refreshToken: "ref",
      subscriptionType: "pro",
      rateLimitTier: null,
    });
  });

  it("rejects an empty or missing accessToken", async () => {
    const f = join(dir, ".credentials.json");
    await writeFile(f, JSON.stringify({ claudeAiOauth: { accessToken: "", expiresAt: 1 } }));
    await expect(readCredentials(dir)).rejects.toThrow(/accessToken/);

    await writeFile(f, JSON.stringify({ claudeAiOauth: { expiresAt: 1 } }));
    await expect(readCredentials(dir)).rejects.toThrow(/accessToken/);
  });

  it("treats a non-numeric expiresAt as expired (NaN), not as a valid future date", async () => {
    await writeFile(
      join(dir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: "not-a-number" } })
    );
    const creds = await readCredentials(dir);
    expect(creds?.accessToken).toBe("tok");
    expect(Number.isNaN(creds!.expiresAt)).toBe(true);
    expect(isTokenExpired(creds!)).toBe(true);
  });
});
