import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage, SCHEMA_VERSION, type LocalState } from "@ccshare/core";
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
    expect(state.account).toEqual({ id: "acc-1", tokenExpired: false, conflict: false });
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

/** Reach the private startup step that reads the DB's bound account. */
async function loadBinding(daemon: Daemon): Promise<void> {
  await (daemon as unknown as { loadBoundAccount(): Promise<void> }).loadBoundAccount();
}

/** Reach the private startup step that heals the schema. */
async function healSchema(daemon: Daemon): Promise<void> {
  await (daemon as unknown as { ensureSchemaCurrent(): Promise<void> }).ensureSchemaCurrent();
}

describe("Daemon schema auto-migration", () => {
  it("migrates an out-of-date shared DB forward on startup", async () => {
    const h = setup({ five_hour: { utilization: 42, resets_at: null } });
    await h.storage.initializeSchema("acc-1");
    await h.storage.migrate(SCHEMA_VERSION - 1); // pretend an older CLI created it
    const spy = vi.spyOn(h.storage, "migrate");

    await healSchema(new Daemon(h.deps));

    expect(spy).toHaveBeenCalledWith(SCHEMA_VERSION);
    const info = await h.storage.inspect();
    expect(info.kind === "ccshare" && info.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("does not migrate a current DB", async () => {
    const h = setup({ five_hour: { utilization: 42, resets_at: null } });
    await h.storage.initializeSchema("acc-1");
    const spy = vi.spyOn(h.storage, "migrate");
    await healSchema(new Daemon(h.deps));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("Daemon account-conflict guard", () => {
  it("halts ledger writes when the local account differs from the DB's binding", async () => {
    const h = setup({ five_hour: { utilization: 42, resets_at: null } });
    await h.storage.initializeSchema("acc-OTHER"); // ledger bound to a different account
    const daemon = new Daemon(h.deps); // local account is acc-1 (from .claude.json)
    await loadBinding(daemon);
    await daemon.tick();

    expect(h.fetchCalls()).toBe(1); // still polls (local view)
    expect(await h.storage.getLatestSamples()).toHaveLength(0); // but records nothing
    const state = readState(h.stateFile);
    expect(state.account.conflict).toBe(true);
    expect(state.samples.map((s) => s.cap)).toEqual(["five_hour"]); // local state still shown
  });

  it("does not ingest measured messages during a conflict", async () => {
    const h = setup({ five_hour: { utilization: 42, resets_at: null } });
    await h.storage.initializeSchema("acc-OTHER");
    const spy = vi.spyOn(h.storage, "recordMessageUsage");
    const daemon = new Daemon(h.deps);
    await loadBinding(daemon);
    await daemon.tick();
    expect(spy).not.toHaveBeenCalled();
  });

  it("writes normally when the local account matches the binding", async () => {
    const h = setup({ five_hour: { utilization: 42, resets_at: null } });
    await h.storage.initializeSchema("acc-1"); // matches .claude.json
    const daemon = new Daemon(h.deps);
    await loadBinding(daemon);
    await daemon.tick();

    expect(await h.storage.getLatestSamples()).toHaveLength(1);
    expect(readState(h.stateFile).account.conflict).toBe(false);
  });

  it("does not enforce against an unbound ledger", async () => {
    const h = setup({ five_hour: { utilization: 42, resets_at: null } });
    await h.storage.initializeSchema(); // unbound (accountId null)
    const daemon = new Daemon(h.deps);
    await loadBinding(daemon);
    await daemon.tick();

    expect(await h.storage.getLatestSamples()).toHaveLength(1);
    expect(readState(h.stateFile).account.conflict).toBe(false);
  });
});

describe("Daemon activity markers", () => {
  /** Write one usage-bearing assistant transcript line under projects/. */
  function writeTranscript(configDir: string, timestamp: string): void {
    const proj = join(configDir, "projects", "p");
    mkdirSync(proj, { recursive: true });
    writeFileSync(
      join(proj, "s.jsonl"),
      JSON.stringify({
        type: "assistant",
        requestId: "req-1",
        timestamp,
        message: {
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
          },
        },
      }) + "\n"
    );
  }

  it("marks an unexplained local rise as the recently-active user's usage", async () => {
    const h = setup({ five_hour: { utilization: 40, resets_at: null } });
    const daemon = new Daemon(h.deps);
    await daemon.tick(); // baselines the reader + records 40%

    // a message lands on this machine (recent local Code activity)
    writeTranscript(h.configDir, new Date(NOW).toISOString());
    await daemon.tick(); // ingests it; tank still 40% -> no marker

    // the tank now rises with no new transcript activity to explain it
    h.setBody({ five_hour: { utilization: 55, resets_at: null } });
    await daemon.tick(); // +15 rise, no in-interval message -> activity marker

    const markers = await h.storage.getUsageMarkersSince(new Date(NOW - 3_600_000).toISOString());
    expect(markers).toHaveLength(1);
    expect(markers[0]?.user).toBe("sam");
    expect(markers[0]?.model).toBe("claude-opus-4-8");
  });

  it("leaves a rise as unknown when the machine has had no recent activity", async () => {
    const h = setup({ five_hour: { utilization: 40, resets_at: null } });
    const daemon = new Daemon(h.deps);
    await daemon.tick(); // baseline, 40%
    h.setBody({ five_hour: { utilization: 55, resets_at: null } });
    await daemon.tick(); // rise, but this machine never produced activity -> no marker
    expect(await h.storage.getUsageMarkersSince(new Date(0).toISOString())).toHaveLength(0);
  });

  it("does not mark when a message already covers the rise", async () => {
    const h = setup({ five_hour: { utilization: 40, resets_at: null } });
    const daemon = new Daemon(h.deps);
    await daemon.tick(); // baseline
    // activity and the rise land in the same tick -> the message covers it
    writeTranscript(h.configDir, new Date(NOW).toISOString());
    h.setBody({ five_hour: { utilization: 55, resets_at: null } });
    await daemon.tick();
    expect(await h.storage.getUsageMarkersSince(new Date(0).toISOString())).toHaveLength(0);
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
