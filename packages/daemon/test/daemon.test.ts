import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage, type LocalState } from "@ccshare/core";
import { Daemon, type DaemonDeps } from "../src/daemon.js";
import { acquireLock, AlreadyRunningError, daemonPaths } from "../src/lifecycle.js";

const NOW = Date.parse("2026-06-29T20:00:00.000Z");

interface Harness {
  deps: DaemonDeps;
  storage: MemoryStorage;
  stateFile: string;
  configDir: string;
  /** Swap the next poll's response body. */
  setBody(body: unknown): void;
  fetchCalls(): number;
}

function setup(initialBody: unknown, expiresAt = NOW + 3_600_000): Harness {
  const root = mkdtempSync(join(tmpdir(), "ccshare-daemon-"));
  const configDir = join(root, "config");
  const ccshareDir = join(root, "ccshare");
  mkdirSync(configDir, { recursive: true });

  writeFileSync(
    join(configDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt } })
  );
  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify({ oauthAccount: { accountUuid: "acc-1", emailAddress: "a@b.c" } })
  );
  process.env.CLAUDE_CONFIG_DIR = configDir;

  let body = initialBody;
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

  const storage = new MemoryStorage();
  const paths = daemonPaths(ccshareDir, configDir);

  return {
    storage,
    stateFile: paths.stateFile,
    configDir,
    setBody: (b) => {
      body = b;
    },
    fetchCalls: () => fetchMock.mock.calls.length,
    deps: {
      storage,
      paths,
      configDir,
      name: "sam",
      pollIntervalMs: 60_000,
      now: () => NOW,
      fetchImpl: fetchMock as unknown as typeof fetch,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    },
  };
}

const readState = (file: string): LocalState => JSON.parse(readFileSync(file, "utf8"));

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  vi.restoreAllMocks();
});

describe("Daemon.tick", () => {
  it("polls, records samples, and writes state.json atomically", async () => {
    const h = setup({
      five_hour: { utilization: 42, resets_at: "2026-06-29T22:00:00Z" },
      seven_day: { utilization: 68, resets_at: "2026-07-05T22:00:00Z" },
    });
    await new Daemon(h.deps).tick();

    expect((await h.storage.getLatestSamples()).find((s) => s.cap === "five_hour")?.pct).toBe(42);
    const state = readState(h.stateFile);
    expect(state.account).toEqual({ id: "acc-1", tokenExpired: false });
    expect(state.samples.map((s) => s.cap)).toEqual(["five_hour", "seven_day"]);
  });

  it("records a reset when pct drops across ticks", async () => {
    const h = setup({ five_hour: { utilization: 90, resets_at: null } });
    const spy = vi.spyOn(h.storage, "recordReset");
    const daemon = new Daemon(h.deps);
    await daemon.tick(); // 90%
    h.setBody({ five_hour: { utilization: 3, resets_at: null } });
    await daemon.tick(); // 3% -> reset
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ cap: "five_hour", previousPct: 90 })
    );
  });

  it("skips the poll and flags expiry when the token is expired", async () => {
    const h = setup({ five_hour: { utilization: 1, resets_at: null } }, NOW - 1);
    await new Daemon(h.deps).tick();
    expect(h.fetchCalls()).toBe(0);
    expect(readState(h.stateFile).account.tokenExpired).toBe(true);
  });
});

describe("single-instance lock", () => {
  it("refuses a second holder while the first is alive", () => {
    const root = mkdtempSync(join(tmpdir(), "ccshare-lock-"));
    const { pidFile } = daemonPaths(root, "/some/config");
    acquireLock(pidFile); // writes our own (live) pid
    expect(() => acquireLock(pidFile)).toThrow(AlreadyRunningError);
  });
});
