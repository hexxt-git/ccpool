import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import type { Config, LocalState } from "@ccpool/core";
import { daemonPaths } from "@ccpool/daemon";
import { ccpoolDir } from "../src/lib/config.js";
import { clearAuthRejected } from "../src/commands/daemon.js";

let dir: string;
let cfg: Config;

function stateFileFor(configDir: string): string {
  return daemonPaths(ccpoolDir(), configDir).stateFile;
}

function writeState(configDir: string, authRejected: boolean): string {
  const stateFile = stateFileFor(configDir);
  const state: LocalState = {
    updatedAt: "2026-07-05T00:00:00.000Z",
    lastSyncAt: null,
    account: { id: "acc-1", tokenExpired: false, conflict: false, authRejected },
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
    pollIntervalMs: 60_000,
    configDirs: [join(dir, "cfg-a"), join(dir, "cfg-b")],
    logLevel: "info",
  };
});

afterEach(() => {
  delete process.env.CCPOOL_DIR;
});

describe("clearAuthRejected", () => {
  it("clears a latched authRejected so a re-init doesn't bounce back to logout", () => {
    const file = writeState(cfg.configDirs[0]!, true);
    clearAuthRejected(cfg);
    expect(readAuthRejected(file)).toBe(false);
  });

  it("clears the latch across every observed config dir", () => {
    const a = writeState(cfg.configDirs[0]!, true);
    const b = writeState(cfg.configDirs[1]!, true);
    clearAuthRejected(cfg);
    expect(readAuthRejected(a)).toBe(false);
    expect(readAuthRejected(b)).toBe(false);
  });

  it("leaves a clean state.json untouched and tolerates a missing one", () => {
    const file = writeState(cfg.configDirs[0]!, false);
    const before = readFileSync(file, "utf8");
    expect(() => clearAuthRejected(cfg)).not.toThrow(); // cfg-b has no state.json
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(existsSync(stateFileFor(cfg.configDirs[1]!))).toBe(false);
  });
});
