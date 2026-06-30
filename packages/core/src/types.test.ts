import { describe, expect, it } from "vitest";
import { isValidName, UNKNOWN_USER } from "./types.js";

describe("isValidName", () => {
  // ── accepted ──────────────────────────────────────────────────────────────────
  it("accepts letters, digits, and hyphens", () => {
    expect(isValidName("sam")).toBe(true);
    expect(isValidName("Alex-42")).toBe(true);
    expect(isValidName("a")).toBe(true);
    expect(isValidName("ABC123")).toBe(true);
  });

  // ── rejected by pattern ─────────────────────────────────────────────────────────
  it("rejects empty and whitespace", () => {
    expect(isValidName("")).toBe(false);
    expect(isValidName(" ")).toBe(false);
    expect(isValidName("sam ")).toBe(false);
    expect(isValidName("two words")).toBe(false);
  });

  it("rejects punctuation and unicode", () => {
    expect(isValidName("sam!")).toBe(false);
    expect(isValidName("sam_jones")).toBe(false);
    expect(isValidName("sam.jones")).toBe(false);
    expect(isValidName("café")).toBe(false);
    expect(isValidName("🙂")).toBe(false);
  });

  // ── reserved name collision ──────────────────────────────────────────────────────
  it("rejects the reserved unknown bucket (any case)", () => {
    expect(isValidName(UNKNOWN_USER)).toBe(false);
    expect(isValidName("unknown")).toBe(false);
    expect(isValidName("Unknown")).toBe(false);
    expect(isValidName("UNKNOWN")).toBe(false);
  });

  it("still accepts names that merely contain 'unknown'", () => {
    expect(isValidName("unknown-1")).toBe(true);
    expect(isValidName("notunknown")).toBe(true);
  });
});
