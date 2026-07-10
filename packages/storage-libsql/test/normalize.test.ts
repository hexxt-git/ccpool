import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { normalizeUrl } from "../src/index.js";

const HOME = homedir();

describe("normalizeUrl", () => {
  // ── :memory: ────────────────────────────────────────────────────────────────
  it("passes :memory: through unchanged", () => {
    expect(normalizeUrl(":memory:")).toBe(":memory:");
  });

  // ── remote scheme passes through ────────────────────────────────────────────
  it("passes libsql:// through unchanged", () => {
    expect(normalizeUrl("libsql://team.turso.io")).toBe("libsql://team.turso.io");
  });

  // ── tilde expansion ─────────────────────────────────────────────────────────
  it("expands ~ in a bare path", () => {
    expect(normalizeUrl("~/.ccshare/ccshare.db")).toBe(`file:${HOME}/.ccshare/ccshare.db`);
  });

  it("expands ~ in a file: URL", () => {
    expect(normalizeUrl("file:~/.ccshare/ccshare.db")).toBe(`file:${HOME}/.ccshare/ccshare.db`);
  });

  it("strips double slash then expands ~ (file://~/...)", () => {
    expect(normalizeUrl("file://~/.ccshare/ccshare.db")).toBe(`file:${HOME}/.ccshare/ccshare.db`);
  });

  it("expands bare ~ with trailing slash", () => {
    expect(normalizeUrl("~/ccshare.db")).toBe(`file:${HOME}/ccshare.db`);
  });

  // ── absolute paths get file: prefix ─────────────────────────────────────────
  it("prepends file: to a bare absolute path", () => {
    expect(normalizeUrl("/var/db/ccshare.db")).toBe("file:/var/db/ccshare.db");
  });

  it("leaves an already-correct file: absolute path alone", () => {
    expect(normalizeUrl("file:/var/db/ccshare.db")).toBe("file:/var/db/ccshare.db");
  });

  // ── relative paths get file: prefix (validation rejects them separately) ────
  it("prepends file: to a bare relative path without expanding anything", () => {
    expect(normalizeUrl("mydb.db")).toBe("file:mydb.db");
  });

  it("prepends file: to a ./ relative path", () => {
    expect(normalizeUrl("./mydb.db")).toBe("file:./mydb.db");
  });
});
