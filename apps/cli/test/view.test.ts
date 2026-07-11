import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiRequestError,
  type Config,
  type LocalState,
  type SharedView,
  type ViewSource,
} from "@ccpool/core";
import { daemonPaths } from "@ccpool/daemon";
import { ccpoolDir } from "../src/lib/config.js";
import { gatherView } from "../src/lib/view.js";

/** A ViewSource whose fetch always rejects with the given error. */
function failingSource(err: unknown): ViewSource {
  return {
    fetchView: () => Promise.reject(err),
    close: () => Promise.resolve(),
  };
}

/** An empty-but-successful ViewSource, so gatherView falls back to state.json. */
const emptySource: ViewSource = {
  fetchView: () =>
    Promise.resolve({ generatedAt: "", samples: [], shares: [], members: [], users: [] }),
  close: () => Promise.resolve(),
};

/** Write a state.json for the config's observed dir so the reader picks it up. */
function writeState(partial: Partial<LocalState>): void {
  const { stateFile } = daemonPaths(ccpoolDir(), cfg.configDirs[0]!);
  const state: LocalState = {
    updatedAt: "2026-06-29T20:05:00.000Z",
    lastSyncAt: null,
    account: { id: "acc-1", tokenExpired: false, conflict: false, authRejected: false },
    samples: [],
    daemon: { pid: 1, startedAt: "2026-06-29T20:00:00.000Z" },
    ...partial,
  };
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state));
}

let dir: string;
let cfg: Config;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccpool-view-"));
  process.env.CCPOOL_DIR = join(dir, ".ccpool");
  cfg = {
    server: { url: "https://api.example.test", token: "tok" },
    name: "sam",
    pollIntervalMs: 60_000,
    configDirs: [join(dir, "cfg")], // empty → no state.json, no creds
    logLevel: "info",
  };
});

afterEach(() => {
  delete process.env.CCPOOL_DIR;
});

describe("gatherView error classification", () => {
  it("treats a 401 (unknown/revoked token) as logged out, not unreachable", async () => {
    const vm = await gatherView(
      cfg,
      failingSource(new ApiRequestError(401, "auth", "unknown token"))
    );
    expect(vm.loggedOut).toBe(true);
    expect(vm.stale).toBe(false);
    // No shared data and no fabrication.
    expect(vm.members).toEqual([]);
    expect(vm.shares).toEqual([]);
  });

  it("treats a non-auth failure as unreachable (stale), not logged out", async () => {
    const vm = await gatherView(cfg, failingSource(new Error("fetch failed")));
    expect(vm.stale).toBe(true);
    expect(vm.loggedOut).toBe(false);
  });

  it("treats a 500 as unreachable, not logged out", async () => {
    const vm = await gatherView(cfg, failingSource(new ApiRequestError(500, "invalid", "boom")));
    expect(vm.stale).toBe(true);
    expect(vm.loggedOut).toBe(false);
  });
});

describe("gatherView roster retention on a failed read", () => {
  const roster = {
    shares: [],
    members: [{ name: "sam", byCap: {}, tokens: 5, lastSeen: "2026-06-29T20:00:00.000Z" }],
    users: [{ name: "sam" }],
  } as unknown as Parameters<typeof gatherView>[2];

  it("keeps the last-known roster on a stale (unreachable) read", async () => {
    const vm = await gatherView(cfg, failingSource(new Error("fetch failed")), roster);
    expect(vm.stale).toBe(true);
    expect(vm.members).toEqual(roster!.members);
    expect(vm.users).toEqual(roster!.users);
  });

  it("does NOT reuse the roster on a 401 — a logout must clear it", async () => {
    const vm = await gatherView(
      cfg,
      failingSource(new ApiRequestError(401, "auth", "unknown token")),
      roster
    );
    expect(vm.loggedOut).toBe(true);
    expect(vm.members).toEqual([]);
    expect(vm.users).toEqual([]);
  });

  it("prefers a successful read's roster over the fallback", async () => {
    const vm = await gatherView(cfg, emptySource, roster);
    expect(vm.stale).toBe(false);
    expect(vm.members).toEqual([]); // the (empty) live read wins, not the fallback
  });
});

describe("gatherView state.json mapping", () => {
  it("surfaces state.lastSyncAt as syncedAt, distinct from updatedAt", async () => {
    writeState({
      updatedAt: "2026-06-29T20:05:00.000Z",
      lastSyncAt: "2026-06-29T20:02:00.000Z",
    });
    const vm = await gatherView(cfg, emptySource);
    expect(vm.updatedAt).toBe("2026-06-29T20:05:00.000Z");
    expect(vm.syncedAt).toBe("2026-06-29T20:02:00.000Z");
  });

  it("treats a latched account.authRejected in state as logged out", async () => {
    writeState({
      account: { id: "acc-1", tokenExpired: false, conflict: false, authRejected: true },
    });
    const vm = await gatherView(cfg, emptySource);
    expect(vm.loggedOut).toBe(true);
  });

  it("surfaces state.pollError (e.g. a 429) so the view can show why sync stalled", async () => {
    writeState({
      pollError: { status: 429, message: "rate-limited (429)", at: "2026-06-29T20:04:00.000Z" },
    });
    const vm = await gatherView(cfg, emptySource);
    expect(vm.pollError).toEqual({
      status: 429,
      message: "rate-limited (429)",
      at: "2026-06-29T20:04:00.000Z",
    });
  });

  it("has a null pollError when state records no failure", async () => {
    writeState({});
    const vm = await gatherView(cfg, emptySource);
    expect(vm.pollError).toBeNull();
  });
});
