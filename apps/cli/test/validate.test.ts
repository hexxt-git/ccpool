import { describe, expect, it } from "vitest";
import { validateUrl } from "../src/lib/validate.js";

describe("validateUrl", () => {
  // ── driver / URL mismatch ───────────────────────────────────────────────────
  it("rejects libsql:// with the sqlite driver", () => {
    expect(validateUrl("sqlite", "libsql://team.turso.io")).toMatch(/libsql.*driver/i);
  });

  it("rejects postgres:// with the libsql driver", () => {
    expect(validateUrl("libsql", "postgres://user:pass@host/db")).toMatch(/postgres.*driver/i);
  });

  it("rejects postgres:// with the sqlite driver", () => {
    expect(validateUrl("sqlite", "postgres://user:pass@host/db")).toMatch(/postgres.*driver/i);
  });

  it("rejects postgresql:// with the libsql driver", () => {
    expect(validateUrl("libsql", "postgresql://user:pass@host/db")).toMatch(/postgres.*driver/i);
  });

  it("rejects a file path with the postgres driver", () => {
    expect(validateUrl("postgres", "/var/db/ccshare.db")).toMatch(/postgres/i);
  });

  it("rejects a libsql:// URL with the postgres driver", () => {
    expect(validateUrl("postgres", "libsql://team.turso.io")).toMatch(/postgres/i);
  });

  it("rejects :memory: with the postgres driver", () => {
    // :memory: is not a postgres:// URL
    expect(validateUrl("postgres", ":memory:")).toMatch(/postgres/i);
  });

  // ── valid combinations ───────────────────────────────────────────────────────
  it("accepts postgres:// with the postgres driver", () => {
    expect(validateUrl("postgres", "postgres://user:pass@host/db")).toBeNull();
  });

  it("accepts postgresql:// with the postgres driver", () => {
    expect(validateUrl("postgres", "postgresql://user:pass@host/db")).toBeNull();
  });

  it("accepts libsql:// with the libsql driver", () => {
    expect(validateUrl("libsql", "libsql://team.turso.io")).toBeNull();
  });

  it("accepts ~/path with libsql", () => {
    expect(validateUrl("libsql", "~/.ccshare/ccshare.db")).toBeNull();
  });

  it("accepts ~/path with sqlite", () => {
    expect(validateUrl("sqlite", "~/.ccshare/ccshare.db")).toBeNull();
  });

  it("accepts an absolute path with libsql", () => {
    expect(validateUrl("libsql", "/var/db/ccshare.db")).toBeNull();
  });

  it("accepts file: URL with libsql", () => {
    expect(validateUrl("libsql", "file:/var/db/ccshare.db")).toBeNull();
  });

  it("accepts file: URL with sqlite", () => {
    expect(validateUrl("sqlite", "file:/var/db/ccshare.db")).toBeNull();
  });

  it("accepts :memory: with libsql", () => {
    expect(validateUrl("libsql", ":memory:")).toBeNull();
  });

  it("accepts :memory: with sqlite", () => {
    expect(validateUrl("sqlite", ":memory:")).toBeNull();
  });

  // ── relative path rejection ──────────────────────────────────────────────────
  it("rejects a bare filename with libsql", () => {
    expect(validateUrl("libsql", "mydb.db")).toMatch(/relative path/i);
  });

  it("rejects a ./ path with libsql", () => {
    expect(validateUrl("libsql", "./mydb.db")).toMatch(/relative path/i);
  });

  it("rejects a ../ path with sqlite", () => {
    expect(validateUrl("sqlite", "../mydb.db")).toMatch(/relative path/i);
  });

  it("error message for relative path contains fix suggestion", () => {
    const msg = validateUrl("libsql", "mydb.db")!;
    expect(msg).toMatch(/absolute path|~\//i);
  });
});
