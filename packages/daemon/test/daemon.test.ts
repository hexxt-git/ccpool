import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiRequestError,
  MemoryStorage,
  StorageIngestSink,
  type IngestMeta,
  type IngestSink,
  type LocalState,
  type TickBatch,
} from "@ccshare/core";
import { Daemon, type DaemonDeps } from "../src/daemon.js";
import { acquireLock, AlreadyRunningError, daemonPaths } from "../src/lifecycle.js";

const NOW = Date.parse("2026-06-29T20:00:00.000Z");

interface Harness {
  deps: DaemonDeps;
  storage: MemoryStorage;
  sink: StorageIngestSink;
  stateFile: string;
  configDir: string;
  /** Swap the next poll's response body. */
  setBody(body: unknown): void;
  /** Advance the mock clock (ticks are seconds apart in reality). */
  advance(ms: number): void;
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

  // A mutable clock shared by the daemon and its sink — successive ticks read a
  // later time, exactly as they would in production (samples are keyed on
  // `(cap, capturedAt)`, so same-instant ticks would otherwise dedup).
  let clock = NOW;
  const now = () => clock;

  const storage = new MemoryStorage();
  const sink = new StorageIngestSink(storage, { now });
  const paths = daemonPaths(ccshareDir, configDir);

  return {
    storage,
    sink,
    stateFile: paths.stateFile,
    configDir,
    setBody: (b) => {
      body = b;
    },
    advance: (ms) => {
      clock += ms;
    },
    fetchCalls: () => fetchMock.mock.calls.length,
    deps: {
      sink,
      paths,
      configDir,
      name: "sam",
      pollIntervalMs: 60_000,
      now,
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

/** Reach the private startup step (sink bootstrap: binding + reset seed). */
async function bootstrap(daemon: Daemon): Promise<void> {
  await (daemon as unknown as { bootstrap(): Promise<void> }).bootstrap();
}

describe("Daemon.tick", () => {
  it("polls, records samples, and writes state.json atomically", async () => {
    const h = setup({
      five_hour: { utilization: 42, resets_at: "2026-06-29T22:00:00Z" },
      seven_day: { utilization: 68, resets_at: "2026-07-05T22:00:00Z" },
    });
    await new Daemon(h.deps).tick();

    expect((await h.storage.getLatestSamples()).find((s) => s.cap === "five_hour")?.pct).toBe(42);
    const state = readState(h.stateFile);
    expect(state.account).toEqual({
      id: "acc-1",
      tokenExpired: false,
      conflict: false,
      authRejected: false,
    });
    expect(state.samples.map((s) => s.cap)).toEqual(["five_hour", "seven_day"]);
    // A fully-clean tick (fresh poll + landed ingest) stamps the sync heartbeat.
    expect(state.lastSyncAt).toBe(new Date(NOW).toISOString());
  });

  it("latches account.authRejected and never marks a clean sync when the sink rejects the bearer (401)", async () => {
    const h = setup({ five_hour: { utilization: 42, resets_at: null } });
    // A sink whose bootstrap is fine but whose ingest is always auth-rejected —
    // the shared-mode server returning 401 for a revoked/rotated token (§13).
    const rejectingSink: IngestSink = {
      bootstrap: async () => ({ accountId: null, samples: [] }),
      ingest: async () => {
        throw new ApiRequestError(401, "auth", "unknown or revoked token");
      },
      close: async () => {},
    };
    const daemon = new Daemon({ ...h.deps, sink: rejectingSink });
    await daemon.tick();

    const state = readState(h.stateFile);
    expect(state.account.authRejected).toBe(true);
    // The poll succeeded but the ingest was rejected: not a clean sync, so the
    // "synced X ago" heartbeat must stay null rather than reset to zero.
    expect(state.lastSyncAt).toBeNull();
  });

  it("freezes lastSyncAt when the usage poll fails (429) even as state.json keeps being written", async () => {
    const h = setup({ five_hour: { utilization: 42, resets_at: null } });
    let fail = false;
    const fetchImpl = vi.fn(async () =>
      fail
        ? new Response("too many requests", { status: 429 })
        : new Response(JSON.stringify({ five_hour: { utilization: 42, resets_at: null } }), {
            status: 200,
          })
    );
    const daemon = new Daemon({ ...h.deps, fetchImpl: fetchImpl as unknown as typeof fetch });

    // Clean tick: poll + ingest both land, so the heartbeat is stamped at NOW.
    await daemon.tick();
    const firstSync = readState(h.stateFile).lastSyncAt;
    expect(firstSync).toBe(new Date(NOW).toISOString());

    // Now the usage endpoint 429s. The tank is stale, so the heartbeat must NOT
    // advance — even though state.json is rewritten with a fresh `updatedAt`.
    fail = true;
    h.advance(60_000);
    await daemon.tick();

    const state = readState(h.stateFile);
    expect(state.lastSyncAt).toBe(firstSync);
    expect(Date.parse(state.updatedAt)).toBeGreaterThan(Date.parse(firstSync!));
  });

  it("records a reset when pct drops across ticks", async () => {
    const h = setup({ five_hour: { utilization: 90, resets_at: null } });
    const daemon = new Daemon(h.deps);
    await daemon.tick(); // 90%
    h.setBody({ five_hour: { utilization: 3, resets_at: null } });
    await daemon.tick(); // 3% -> reset
    const resets = await h.storage.getResetsSince(new Date(0).toISOString());
    expect(resets).toEqual([expect.objectContaining({ cap: "five_hour", previousPct: 90 })]);
  });

  it("skips the poll and flags expiry when the token is expired", async () => {
    const h = setup({ five_hour: { utilization: 1, resets_at: null } }, NOW - 1);
    await new Daemon(h.deps).tick();
    expect(h.fetchCalls()).toBe(0);
    expect(readState(h.stateFile).account.tokenExpired).toBe(true);
  });

  it("sends ONE batch per tick (samples + messages together)", async () => {
    const h = setup({ five_hour: { utilization: 42, resets_at: null } });
    const spy = vi.spyOn(h.storage, "recordBatch");
    await new Daemon(h.deps).tick();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed batch and merges it into the next tick (no dropped rows)", async () => {
    const h = setup({ five_hour: { utilization: 42, resets_at: null } });
    let failNext = true;
    const flaky: IngestSink = {
      bootstrap: () => h.sink.bootstrap(),
      ingest: async (batch: TickBatch, meta: IngestMeta) => {
        if (failNext) {
          failNext = false;
          throw new Error("sink offline");
        }
        await h.sink.ingest(batch, meta);
      },
      close: () => h.sink.close(),
    };
    const daemon = new Daemon({ ...h.deps, sink: flaky });

    const { pollFailed } = await daemon.tick(); // ingest fails -> batch retained
    expect(pollFailed).toBe(true);
    expect(await h.storage.getLatestSamples()).toHaveLength(0);

    h.setBody({ five_hour: { utilization: 43, resets_at: null } });
    h.advance(60_000); // next tick observes a later instant (distinct capturedAt)
    await daemon.tick(); // retried batch merges with this tick's
    const samples = await h.storage.getUsageSamplesSince(new Date(0).toISOString());
    expect(samples.map((s) => s.pct)).toEqual([42, 43]); // both ticks landed
  });
});

describe("Daemon schema auto-migration", () => {
  // v1 is the single baseline, so a freshly initialized DB is already current and
  // the daemon must never migrate it. (The forward-migration machinery is retained
  // for future versions; there are no historical steps to exercise.)
  it("does not migrate a current DB", async () => {
    const h = setup({ five_hour: { utilization: 42, resets_at: null } });
    await h.storage.initializeSchema("acc-1");
    const spy = vi.spyOn(h.storage, "migrate");
    await bootstrap(new Daemon(h.deps));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("Daemon account-conflict guard", () => {
  it("halts ledger writes when the local account differs from the DB's binding", async () => {
    const h = setup({ five_hour: { utilization: 42, resets_at: null } });
    await h.storage.initializeSchema("acc-OTHER"); // ledger bound to a different account
    const daemon = new Daemon(h.deps); // local account is acc-1 (from .claude.json)
    await bootstrap(daemon);
    await daemon.tick();

    expect(h.fetchCalls()).toBe(1); // still polls (local view)
    expect(await h.storage.getLatestSamples()).toHaveLength(0); // but records nothing
    const state = readState(h.stateFile);
    expect(state.account.conflict).toBe(true);
    expect(state.samples.map((s) => s.cap)).toEqual(["five_hour"]); // local state still shown
  });

  it("does not ingest anything during a conflict", async () => {
    const h = setup({ five_hour: { utilization: 42, resets_at: null } });
    await h.storage.initializeSchema("acc-OTHER");
    const spy = vi.spyOn(h.storage, "recordBatch");
    const daemon = new Daemon(h.deps);
    await bootstrap(daemon);
    await daemon.tick();
    expect(spy).not.toHaveBeenCalled();
  });

  it("flags the conflict when the sink itself refuses the write (server-side 409)", async () => {
    const h = setup({ five_hour: { utilization: 42, resets_at: null } });
    await h.storage.initializeSchema("acc-OTHER");
    const daemon = new Daemon(h.deps);
    // The daemon never learns the binding — only the sink does (like a server 409).
    await h.sink.bootstrap();
    await daemon.tick();

    expect(await h.storage.getLatestSamples()).toHaveLength(0);
    expect(readState(h.stateFile).account.conflict).toBe(true);
  });

  it("writes normally when the local account matches the binding", async () => {
    const h = setup({ five_hour: { utilization: 42, resets_at: null } });
    await h.storage.initializeSchema("acc-1"); // matches .claude.json
    const daemon = new Daemon(h.deps);
    await bootstrap(daemon);
    await daemon.tick();

    expect(await h.storage.getLatestSamples()).toHaveLength(1);
    expect(readState(h.stateFile).account.conflict).toBe(false);
  });

  it("does not enforce against an unbound ledger", async () => {
    const h = setup({ five_hour: { utilization: 42, resets_at: null } });
    await h.storage.initializeSchema(); // unbound (accountId null)
    const daemon = new Daemon(h.deps);
    await bootstrap(daemon);
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
  /** A pid that is (essentially) guaranteed not to be a running process. */
  const DEAD_PID = 0x7ffffffe;

  it("refuses a second holder while the first is alive", () => {
    const root = mkdtempSync(join(tmpdir(), "ccshare-lock-"));
    const { pidFile } = daemonPaths(root, "/some/config");
    acquireLock(pidFile); // writes our own (live) pid
    expect(() => acquireLock(pidFile)).toThrow(AlreadyRunningError);
  });

  it("reclaims a stale lock left by a dead owner (SIGKILL, no release)", () => {
    const root = mkdtempSync(join(tmpdir(), "ccshare-lock-"));
    const { pidFile } = daemonPaths(root, "/some/config");
    mkdirSync(join(root), { recursive: true });
    writeFileSync(pidFile, String(DEAD_PID)); // a crashed daemon's leftover

    expect(() => acquireLock(pidFile)).not.toThrow();
    expect(readFileSync(pidFile, "utf8").trim()).toBe(String(process.pid));
  });

  it("reclaims an empty/half-written lock file from a crash mid-write", () => {
    const root = mkdtempSync(join(tmpdir(), "ccshare-lock-"));
    const { pidFile } = daemonPaths(root, "/some/config");
    writeFileSync(pidFile, ""); // opened but never written before the crash

    expect(() => acquireLock(pidFile)).not.toThrow();
    expect(readFileSync(pidFile, "utf8").trim()).toBe(String(process.pid));
  });
});
