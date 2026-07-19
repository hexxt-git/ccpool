import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import type { Config, LocalState } from "@ccpool/core";
import { stateFilePath } from "../src/lib/config.js";
import { clearAuthRejected } from "../src/commands/daemon.js";

let dir: string;
let cfg: Config;

function writeState(accountId: string, authRejected: boolean): string {
  const stateFile = stateFilePath(accountId);
  const state: LocalState = {
    updatedAt: "2026-07-05T00:00:00.000Z",
    lastSyncAt: null,
    account: { id: accountId, tokenExpired: false, conflict: false, authRejected },
    samples: [],
    daemon: { pid: 1, startedAt: "2026-07-05T00:00:00.000Z" },
  };
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state));
  return stateFile;
}

function readAuthRejected(stateFile: string): boolean {
  return (JSON.parse(readFileSync(stateFile, "utf8")) as LocalState).account.authRejected ?? false;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccpool-clear-"));
  process.env.CCPOOL_DIR = join(dir, ".ccpool");
  cfg = {
    server: { url: "https://api.example.test", token: "tok" },
    name: "sam",
    accountId: "acc-1",
    pollIntervalMs: 60_000,
    configDirs: [join(dir, "cfg")],
    logLevel: "info",
  };
});

afterEach(() => {
  delete process.env.CCPOOL_DIR;
});

describe("clearAuthRejected", () => {
  it("clears a latched authRejected so a re-init doesn't bounce back to logout", () => {
    const file = writeState(cfg.accountId!, true);
    clearAuthRejected(cfg);
    expect(readAuthRejected(file)).toBe(false);
  });

  it("only touches the profile's own account, leaving other accounts' state alone", () => {
    const mine = writeState(cfg.accountId!, true);
    const other = writeState("acc-2", true);
    clearAuthRejected(cfg);
    expect(readAuthRejected(mine)).toBe(false);
    expect(readAuthRejected(other)).toBe(true); // a different account is untouched
  });

  it("leaves a clean state.json untouched and tolerates a missing one", () => {
    const file = writeState(cfg.accountId!, false);
    const before = readFileSync(file, "utf8");
    expect(() => clearAuthRejected({ ...cfg, accountId: "acc-missing" })).not.toThrow();
    clearAuthRejected(cfg);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(existsSync(stateFilePath("acc-missing"))).toBe(false);
  });
});
