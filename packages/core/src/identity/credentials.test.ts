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
    dir = await mkdtemp(join(tmpdir(), "ccpool-creds-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when no credentials exist", async () => {
    // Inject an empty keychain so the assertion holds on macOS too.
    expect(await readCredentials(dir, { readKeychain: async () => [] })).toBeNull();
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
    // Empty keychain so nothing fresher shadows the file on macOS: the expired
    // file comes back as the last-resort credential.
    const creds = await readCredentials(dir, { readKeychain: async () => [] });
    expect(creds?.accessToken).toBe("tok");
    expect(Number.isNaN(creds!.expiresAt)).toBe(true);
    expect(isTokenExpired(creds!)).toBe(true);
  });
});

describe("readCredentials (freshest source wins)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccpool-creds-fresh-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const oauth = (accessToken: string, expiresAt: number) =>
    JSON.stringify({
      claudeAiOauth: { accessToken, expiresAt, subscriptionType: "max", rateLimitTier: null },
    });

  it("uses a live keychain token even when a stale plaintext file exists", async () => {
    // The exact failure we hit: an orphaned expired file must not shadow the
    // live keychain token Claude Code is actually using.
    const now = 10_000;
    await writeFile(join(dir, ".credentials.json"), oauth("stale-file", 5_000));
    const creds = await readCredentials(dir, {
      now,
      readKeychain: async () => [oauth("live-keychain", 20_000)],
    });
    expect(creds?.accessToken).toBe("live-keychain");
    expect(isTokenExpired(creds!, now)).toBe(false);
  });

  it("uses a fresh file without consulting the keychain", async () => {
    const now = 10_000;
    let keychainReads = 0;
    await writeFile(join(dir, ".credentials.json"), oauth("fresh-file", 20_000));
    const creds = await readCredentials(dir, {
      now,
      readKeychain: async () => {
        keychainReads++;
        return [];
      },
    });
    expect(creds?.accessToken).toBe("fresh-file");
    expect(keychainReads).toBe(0);
  });

  it("falls back to the expired file when no fresher source exists", async () => {
    const now = 10_000;
    await writeFile(join(dir, ".credentials.json"), oauth("stale-file", 5_000));
    const creds = await readCredentials(dir, { now, readKeychain: async () => [] });
    expect(creds?.accessToken).toBe("stale-file");
    expect(isTokenExpired(creds!, now)).toBe(true);
  });

  it("skips a malformed keychain entry and keeps looking", async () => {
    const now = 10_000;
    await writeFile(join(dir, ".credentials.json"), oauth("stale-file", 5_000));
    const creds = await readCredentials(dir, {
      now,
      readKeychain: async () => ["}{ not json", oauth("live-keychain", 20_000)],
    });
    expect(creds?.accessToken).toBe("live-keychain");
  });
});
