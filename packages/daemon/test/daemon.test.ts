import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiRequestError,
  readCredentials as coreReadCredentials,
  StorageIngestSink,
  type IngestMeta,
  type IngestSink,
  type LocalState,
  type Storage,
  type TickBatch,
} from "@ccpool/core";
import { LibsqlDatabase } from "@ccpool/storage-libsql";
import { Daemon } from "../src/daemon.js";
import { Pipeline, type PipelineDeps } from "../src/pipeline.js";
import { acquireLock, AlreadyRunningError, daemonPaths, reassertLock } from "../src/lifecycle.js";
import { existsSync, unlinkSync } from "node:fs";

const NOW = Date.parse("2026-06-29T20:00:00.000Z");
const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

// Each setup() opens its own libSQL `:memory:` database (per-client isolation);
// afterEach closes them all so no client leaks and hangs vitest.
const openDbs: LibsqlDatabase[] = [];

interface Harness {
  deps: PipelineDeps;
  storage: Storage;
  sink: StorageIngestSink;
  stateFile: string;
  configDir: string;
  /** Swap the next poll's response body. */
  setBody(body: unknown): void;
  /** Advance the mock clock (ticks are seconds apart in reality). */
  advance(ms: number): void;
  fetchCalls(): number;
}

async function setup(initialBody: unknown, expiresAt = NOW + 3_600_000): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "ccpool-daemon-"));
  const configDir = join(root, "config");
  const ccpoolDir = join(root, "ccpool");
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

  const db = new LibsqlDatabase(":memory:");
  await db.init();
  openDbs.push(db);
  const storage = db.forGroup("g");
  const sink = new StorageIngestSink(storage, { now });
  const paths = daemonPaths(ccpoolDir, configDir);

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
      accountId: "acc-1",
      sink,
      stateFile: paths.stateFile,
      configDir,
      name: "sam",
      now,
      fetchImpl: fetchMock as unknown as typeof fetch,
      // Read only the test's plaintext file — never fall through to the host's
      // real macOS keychain, which would otherwise satisfy an intentionally
      // expired token and make the poll-skip cases flaky on darwin.
      readCredentials: (dir, opts) =>
        coreReadCredentials(dir, { ...opts, readKeychain: async () => [] }),
      logger: SILENT,
    },
  };
}

const readState = (file: string): LocalState => JSON.parse(readFileSync(file, "utf8"));

afterEach(async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  vi.restoreAllMocks();
  await Promise.all(openDbs.splice(0).map((db) => db.close().catch(() => {})));
});

describe("Pipeline.tick", () => {
  it("polls, records samples, and writes state.json atomically", async () => {
    const h = await setup({
      five_hour: { utilization: 42, resets_at: "2026-06-29T22:00:00Z" },
      seven_day: { utilization: 68, resets_at: "2026-07-05T22:00:00Z" },
    });
    await new Pipeline(h.deps).tick();

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
    const h = await setup({ five_hour: { utilization: 42, resets_at: null } });
    // A sink whose bootstrap is fine but whose ingest is always auth-rejected —
    // the shared-mode server returning 401 for a revoked/rotated token (the "server" section).
    const rejectingSink: IngestSink = {
      bootstrap: async () => ({ accountId: null, samples: [] }),
      ingest: async () => {
        throw new ApiRequestError(401, "auth", "unknown or revoked token");
      },
      close: async () => {},
    };
    const pipeline = new Pipeline({ ...h.deps, sink: rejectingSink });
    await pipeline.tick();

    const state = readState(h.stateFile);
    expect(state.account.authRejected).toBe(true);
    // The poll succeeded but the ingest was rejected: not a clean sync, so the
    // "synced X ago" heartbeat must stay null rather than reset to zero.
    expect(state.lastSyncAt).toBeNull();
  });

  it("freezes lastSyncAt when the usage poll fails (429) even as state.json keeps being written", async () => {
    const h = await setup({ five_hour: { utilization: 42, resets_at: null } });
    let fail = false;
    const fetchImpl = vi.fn(async () =>
      fail
        ? new Response("too many requests", { status: 429 })
        : new Response(JSON.stringify({ five_hour: { utilization: 42, resets_at: null } }), {
            status: 200,
          })
    );
    const pipeline = new Pipeline({ ...h.deps, fetchImpl: fetchImpl as unknown as typeof fetch });

    // Clean tick: poll + ingest both land, so the heartbeat is stamped at NOW.
    await pipeline.tick();
    const firstSync = readState(h.stateFile).lastSyncAt;
    expect(firstSync).toBe(new Date(NOW).toISOString());

    // Now the usage endpoint 429s. The tank is stale, so the heartbeat must NOT
    // advance — even though state.json is rewritten with a fresh `updatedAt`.
    fail = true;
    h.advance(60_000);
    await pipeline.tick();

    const state = readState(h.stateFile);
    expect(state.lastSyncAt).toBe(firstSync);
    expect(Date.parse(state.updatedAt)).toBeGreaterThan(Date.parse(firstSync!));
  });

  it("records a reset when pct drops across ticks", async () => {
    const h = await setup({ five_hour: { utilization: 90, resets_at: null } });
    const pipeline = new Pipeline(h.deps);
    await pipeline.tick(); // 90%
    h.setBody({ five_hour: { utilization: 3, resets_at: null } });
    await pipeline.tick(); // 3% -> reset
    const resets = await h.storage.getResetsSince(new Date(0).toISOString());
    expect(resets).toEqual([expect.objectContaining({ cap: "five_hour", previousPct: 90 })]);
  });

  it("skips the poll and flags expiry when the token is expired", async () => {
    const h = await setup({ five_hour: { utilization: 1, resets_at: null } }, NOW - 1);
    await new Pipeline(h.deps).tick();
    expect(h.fetchCalls()).toBe(0);
    expect(readState(h.stateFile).account.tokenExpired).toBe(true);
  });

  it("sends ONE batch per tick (samples + messages together)", async () => {
    const h = await setup({ five_hour: { utilization: 42, resets_at: null } });
    const spy = vi.spyOn(h.storage, "recordBatch");
    await new Pipeline(h.deps).tick();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not re-send an unchanged tank, but a rise still ingests (report-on-change)", async () => {
    const h = await setup({ five_hour: { utilization: 42, resets_at: null } });
    const pipeline = new Pipeline(h.deps);
    await pipeline.tick(); // first reading: 42 is sent

    h.advance(60_000);
    const spy = vi.spyOn(h.storage, "recordBatch");
    await pipeline.tick(); // still 42 — nothing new to send
    expect(spy).not.toHaveBeenCalled();

    h.setBody({ five_hour: { utilization: 55, resets_at: null } });
    h.advance(60_000);
    await pipeline.tick(); // a rise — sent
    expect(spy).toHaveBeenCalledTimes(1);

    const samples = await h.storage.getUsageSamplesSince(new Date(0).toISOString());
    expect(samples.map((s) => s.pct)).toEqual([42, 55]); // only the two distinct levels
  });

  it("keeps a failed batch and merges it into the next tick (no dropped rows)", async () => {
    const h = await setup({ five_hour: { utilization: 42, resets_at: null } });
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
    const pipeline = new Pipeline({ ...h.deps, sink: flaky });

    const { pollFailed } = await pipeline.tick(); // ingest fails -> batch retained
    expect(pollFailed).toBe(true);
    expect(await h.storage.getLatestSamples()).toHaveLength(0);

    h.setBody({ five_hour: { utilization: 43, resets_at: null } });
    h.advance(60_000); // next tick observes a later instant (distinct capturedAt)
    await pipeline.tick(); // retried batch merges with this tick's
    const samples = await h.storage.getUsageSamplesSince(new Date(0).toISOString());
    expect(samples.map((s) => s.pct)).toEqual([42, 43]); // both ticks landed
  });
});

describe("Pipeline schema auto-migration", () => {
  // v1 is the single baseline, so a freshly initialized DB is already current and
  // the pipeline must never migrate it. (The forward-migration machinery is retained
  // for future versions; there are no historical steps to exercise.)
  it("does not migrate a current DB", async () => {
    const h = await setup({ five_hour: { utilization: 42, resets_at: null } });
    await h.storage.initializeSchema("acc-1");
    const spy = vi.spyOn(h.storage, "migrate");
    await new Pipeline(h.deps).bootstrap();
    expect(spy).not.toHaveBeenCalled();
  });
});

// A per-account profile's group is bound to that same account, so a mismatch
// shouldn't happen in practice — but the pipeline stays defensive: if the sink's
// group is bound to a *different* account (a stray server-side 409), it never
// writes into that foreign tank and flags the conflict in state.json.
describe("Pipeline account-conflict guard (server-side 409)", () => {
  it("does not record anything when the sink refuses the write (bound to another account)", async () => {
    const h = await setup({ five_hour: { utilization: 42, resets_at: null } });
    await h.storage.initializeSchema("acc-OTHER"); // ledger bound to a different account
    const pipeline = new Pipeline(h.deps); // this pipeline is acc-1
    await pipeline.bootstrap();
    await pipeline.tick();

    expect(h.fetchCalls()).toBe(1); // still polls (local view)
    expect(await h.storage.getLatestSamples()).toHaveLength(0); // but records nothing
    const state = readState(h.stateFile);
    expect(state.account.conflict).toBe(true);
    expect(state.samples.map((s) => s.cap)).toEqual(["five_hour"]); // local state still shown
  });

  it("does not call recordBatch during a conflict", async () => {
    const h = await setup({ five_hour: { utilization: 42, resets_at: null } });
    await h.storage.initializeSchema("acc-OTHER");
    const spy = vi.spyOn(h.storage, "recordBatch");
    const pipeline = new Pipeline(h.deps);
    await pipeline.bootstrap();
    await pipeline.tick();
    expect(spy).not.toHaveBeenCalled();
  });

  it("writes normally when the binding matches the pipeline's account", async () => {
    const h = await setup({ five_hour: { utilization: 42, resets_at: null } });
    await h.storage.initializeSchema("acc-1"); // matches the pipeline's account
    const pipeline = new Pipeline(h.deps);
    await pipeline.bootstrap();
    await pipeline.tick();

    expect(await h.storage.getLatestSamples()).toHaveLength(1);
    expect(readState(h.stateFile).account.conflict).toBe(false);
  });

  it("does not enforce against an unbound ledger", async () => {
    const h = await setup({ five_hour: { utilization: 42, resets_at: null } });
    await h.storage.initializeSchema(); // unbound (accountId null)
    const pipeline = new Pipeline(h.deps);
    await pipeline.bootstrap();
    await pipeline.tick();

    expect(await h.storage.getLatestSamples()).toHaveLength(1);
    expect(readState(h.stateFile).account.conflict).toBe(false);
  });
});

describe("Pipeline activity markers", () => {
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
    const h = await setup({ five_hour: { utilization: 40, resets_at: null } });
    const pipeline = new Pipeline(h.deps);
    await pipeline.tick(); // baselines the reader + records 40%

    // a message lands on this machine (recent local Code activity)
    writeTranscript(h.configDir, new Date(NOW).toISOString());
    await pipeline.tick(); // ingests it; tank still 40% -> no marker

    // the tank now rises with no new transcript activity to explain it
    h.setBody({ five_hour: { utilization: 55, resets_at: null } });
    await pipeline.tick(); // +15 rise, no in-interval message -> activity marker

    const markers = await h.storage.getUsageMarkersSince(new Date(NOW - 3_600_000).toISOString());
    expect(markers).toHaveLength(1);
    expect(markers[0]?.user).toBe("sam");
    expect(markers[0]?.model).toBe("claude-opus-4-8");
  });

  it("leaves a rise as unknown when the machine has had no recent activity", async () => {
    const h = await setup({ five_hour: { utilization: 40, resets_at: null } });
    const pipeline = new Pipeline(h.deps);
    await pipeline.tick(); // baseline, 40%
    h.setBody({ five_hour: { utilization: 55, resets_at: null } });
    await pipeline.tick(); // rise, but this machine never produced activity -> no marker
    expect(await h.storage.getUsageMarkersSince(new Date(0).toISOString())).toHaveLength(0);
  });

  it("does not mark when a message already covers the rise", async () => {
    const h = await setup({ five_hour: { utilization: 40, resets_at: null } });
    const pipeline = new Pipeline(h.deps);
    await pipeline.tick(); // baseline
    // activity and the rise land in the same tick -> the message covers it
    writeTranscript(h.configDir, new Date(NOW).toISOString());
    h.setBody({ five_hour: { utilization: 55, resets_at: null } });
    await pipeline.tick();
    expect(await h.storage.getUsageMarkersSince(new Date(0).toISOString())).toHaveLength(0);
  });
});

// The manager follows the live Claude account: one machine can be logged into
// ccpool under several accounts at once, but only the live one is observed.
describe("Daemon (multi-account manager)", () => {
  /** Point the observed config dir at a Claude account (or none). */
  function setLiveAccount(configDir: string, accountUuid: string | null): void {
    writeFileSync(
      join(configDir, ".claude.json"),
      JSON.stringify(accountUuid ? { oauthAccount: { accountUuid } } : { userID: 42 })
    );
  }

  interface RecordingSink extends IngestSink {
    ingests: number;
    closed: boolean;
  }
  function recordingSink(): RecordingSink {
    const s: RecordingSink = {
      ingests: 0,
      closed: false,
      bootstrap: async () => ({ accountId: null, samples: [] }),
      ingest: async () => {
        s.ingests++;
      },
      close: async () => {
        s.closed = true;
      },
    };
    return s;
  }

  it("surrenders at the top of the tick without polling, ingesting, or writing state", async () => {
    const h = await setup({ five_hour: { utilization: 42, resets_at: null } });
    const before = h.fetchCalls();
    const daemon = new Daemon({
      configDir: h.configDir,
      loadProfile: async () => null,
      pidFile: join(h.configDir, "daemon.pid"),
      pollIntervalMs: 60_000,
      ensureOwner: () => false,
      now: h.deps.now,
      fetchImpl: h.deps.fetchImpl,
      readCredentials: h.deps.readCredentials,
      logger: SILENT,
    });
    const res = await daemon.tick();

    expect(res.pollFailed).toBe(false);
    expect(h.fetchCalls()).toBe(before); // never polled
    expect(daemon.activeAccountId()).toBeNull();
  });

  it("follows the live account, flush-evicts on switch, and goes dormant without a profile", async () => {
    const h = await setup({ five_hour: { utilization: 42, resets_at: null } });
    const sinks: Record<string, RecordingSink> = {};
    const profiles: Record<string, boolean> = { "acc-1": true, "acc-2": true };

    const daemon = new Daemon({
      configDir: h.configDir,
      loadProfile: async (id) => {
        if (!profiles[id]) return null;
        const sink = (sinks[id] ??= recordingSink());
        return { accountId: id, sink, stateFile: join(h.configDir, `state-${id}.json`), name: id };
      },
      pidFile: join(h.configDir, "daemon.pid"),
      pollIntervalMs: 60_000,
      now: h.deps.now,
      fetchImpl: h.deps.fetchImpl,
      readCredentials: h.deps.readCredentials,
      logger: SILENT,
    });

    // Live account is acc-1 (from setup's .claude.json) -> observed.
    await daemon.tick();
    expect(daemon.activeAccountId()).toBe("acc-1");
    expect(sinks["acc-1"]!.ingests).toBeGreaterThan(0);

    // Switch Claude to an account with no ccpool profile -> dormant, acc-1 evicted.
    setLiveAccount(h.configDir, "acc-3");
    h.advance(60_000);
    await daemon.tick();
    expect(daemon.activeAccountId()).toBeNull();
    expect(sinks["acc-1"]!.closed).toBe(true);

    // Switch to acc-2 (has a profile) -> now observed, its own sink.
    setLiveAccount(h.configDir, "acc-2");
    h.advance(60_000);
    await daemon.tick();
    expect(daemon.activeAccountId()).toBe("acc-2");
    expect(sinks["acc-2"]!.ingests).toBeGreaterThan(0);
  });
});

describe("single-instance lock", () => {
  /** A pid that is (essentially) guaranteed not to be a running process. */
  const DEAD_PID = 0x7ffffffe;

  it("refuses a second holder while the first is alive", () => {
    const root = mkdtempSync(join(tmpdir(), "ccpool-lock-"));
    const { pidFile } = daemonPaths(root, "/some/config");
    acquireLock(pidFile); // writes our own (live) pid
    expect(() => acquireLock(pidFile)).toThrow(AlreadyRunningError);
  });

  it("reclaims a stale lock left by a dead owner (SIGKILL, no release)", () => {
    const root = mkdtempSync(join(tmpdir(), "ccpool-lock-"));
    const { pidFile } = daemonPaths(root, "/some/config");
    mkdirSync(join(root), { recursive: true });
    writeFileSync(pidFile, String(DEAD_PID)); // a crashed daemon's leftover

    expect(() => acquireLock(pidFile)).not.toThrow();
    expect(readFileSync(pidFile, "utf8").trim()).toBe(String(process.pid));
  });

  it("reclaims an empty/half-written lock file from a crash mid-write", () => {
    const root = mkdtempSync(join(tmpdir(), "ccpool-lock-"));
    const { pidFile } = daemonPaths(root, "/some/config");
    writeFileSync(pidFile, ""); // opened but never written before the crash

    expect(() => acquireLock(pidFile)).not.toThrow();
    expect(readFileSync(pidFile, "utf8").trim()).toBe(String(process.pid));
  });
});

// The lock is re-checked for the daemon's whole life, not just at boot — this is
// what stops the orphan-with-no-pidfile duplicates that slipped past the atomic
// acquire every previous time.
describe("continuous single-instance ownership (reassertLock)", () => {
  const DEAD_PID = 0x7ffffffe;

  it("keeps ownership when the pidfile still records us (no writes)", () => {
    const root = mkdtempSync(join(tmpdir(), "ccpool-reassert-"));
    const { pidFile } = daemonPaths(root, "/cfg");
    acquireLock(pidFile);
    expect(reassertLock(pidFile)).toBe(true);
    expect(readFileSync(pidFile, "utf8").trim()).toBe(String(process.pid));
  });

  it("self-heals a pidfile that was deleted out from under a running daemon", () => {
    const root = mkdtempSync(join(tmpdir(), "ccpool-reassert-"));
    const { pidFile } = daemonPaths(root, "/cfg");
    acquireLock(pidFile);
    unlinkSync(pidFile); // e.g. a manual rm, or a crashed starter's reclaim
    expect(reassertLock(pidFile)).toBe(true); // reclaimed
    expect(readFileSync(pidFile, "utf8").trim()).toBe(String(process.pid));
  });

  it("reclaims a pidfile a dead owner left behind", () => {
    const root = mkdtempSync(join(tmpdir(), "ccpool-reassert-"));
    const { pidFile } = daemonPaths(root, "/cfg");
    mkdirSync(root, { recursive: true });
    writeFileSync(pidFile, String(DEAD_PID));
    expect(reassertLock(pidFile)).toBe(true);
    expect(readFileSync(pidFile, "utf8").trim()).toBe(String(process.pid));
  });

  it("surrenders when a *live* peer holds the pidfile, leaving it untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "ccpool-reassert-"));
    const { pidFile } = daemonPaths(root, "/cfg");
    mkdirSync(root, { recursive: true });
    // pid 1 (launchd/init) is always alive and is never us — a stand-in for a live
    // peer daemon that won the pidfile.
    writeFileSync(pidFile, "1");
    expect(reassertLock(pidFile)).toBe(false); // we are the duplicate → surrender
    expect(readFileSync(pidFile, "utf8").trim()).toBe("1"); // peer's lock left intact
  });
});
