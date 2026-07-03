import { describe, expect, it } from "vitest";
import { FailureDamper, hashPassword, hashToken, mintToken, verifyPassword } from "../src/auth.js";

describe("password hashing (scrypt)", () => {
  it("verifies the right password and refuses the wrong one", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("correct horse battery!", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("salts every hash (same password, different strings)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it("stores self-describing params so they can be raised later", async () => {
    const stored = await hashPassword("pw-for-format");
    const [algo, N, r, p, salt, hash] = stored.split(":");
    expect(algo).toBe("scrypt");
    expect(Number(N)).toBeGreaterThan(0);
    expect(Number(r)).toBeGreaterThan(0);
    expect(Number(p)).toBeGreaterThan(0);
    expect(salt!.length).toBeGreaterThan(0);
    expect(hash!.length).toBeGreaterThan(0);
  });

  it("rejects malformed stored strings without throwing", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "scrypt:nope:8:1:AA:BB")).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
  });
});

describe("bearer tokens", () => {
  it("mints unique tokens and stores only a hash", () => {
    const a = mintToken();
    const b = mintToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token.startsWith("ccs_")).toBe(true);
    expect(a.tokenHash).toBe(hashToken(a.token));
    expect(a.tokenHash).not.toContain(a.token);
  });
});

describe("FailureDamper", () => {
  it("blocks after the free attempts and forgives on success", () => {
    let now = 0;
    const d = new FailureDamper(2, 1_000, 60_000, () => now);
    d.recordFailure("k");
    d.recordFailure("k");
    expect(d.isBlocked("k")).toBe(false); // still within free attempts
    d.recordFailure("k");
    expect(d.isBlocked("k")).toBe(true);

    now += 1_001; // base block elapses
    expect(d.isBlocked("k")).toBe(false);
    d.recordFailure("k"); // exponential: now 2s
    expect(d.isBlocked("k")).toBe(true);

    d.recordSuccess("k");
    expect(d.isBlocked("k")).toBe(false);
  });

  it("scopes damping per key", () => {
    const d = new FailureDamper(0, 1_000, 60_000, () => 0);
    d.recordFailure("a");
    expect(d.isBlocked("a")).toBe(true);
    expect(d.isBlocked("b")).toBe(false);
  });

  it("bounds tracked keys, evicting the oldest (memory-exhaustion guard)", () => {
    const d = new FailureDamper(0, 1_000, 60_000, () => 0, 3);
    for (const k of ["a", "b", "c", "d"]) d.recordFailure(k);
    // "a" was evicted when "d" pushed the map past its cap of 3.
    expect(d.isBlocked("a")).toBe(false);
    expect(d.isBlocked("d")).toBe(true);
    expect(d.isBlocked("b")).toBe(true);
  });
});
