/**
 * Demo launcher for the ccpool TUI.
 *
 *   pnpm --filter ccpool demo
 *
 * Renders the live TUI against a fabricated, in-memory {@link ViewSource} — no
 * daemon, server, or network — so the interface can be explored or screenshotted
 * with representative data. All on-disk state lives in a throwaway sandbox, so it
 * never reads or writes the real ~/.ccpool or Claude config.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink";
import type { Config, HistoryPage, LocalState, SharedView, ViewSource } from "@ccpool/core";
import { daemonPaths } from "@ccpool/daemon";
import { App } from "../src/tui/App.js";
import { ccpoolDir } from "../src/lib/config.js";

// Redirect every path the CLI resolves from the environment into a temp sandbox,
// before anything reads it — the demo must not touch real state.
const sandbox = mkdtempSync(join(tmpdir(), "ccpool-demo-"));
process.env.CCPOOL_DIR = sandbox;
process.env.CLAUDE_CONFIG_DIR = join(sandbox, "claude");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const ME = "hexxt-git";

/** The fabricated shared picture the TUI renders. */
const VIEW: SharedView = {
  generatedAt: iso(0),
  samples: [
    // 5h at 72% = hexxt-git 35 + edaywalid 20 + lai0xn 15 + unknown 2.
    { cap: "five_hour", pct: 72, resetsAt: iso(3 * HOUR + 12 * 60_000), capturedAt: iso(0) },
    // weekly at 40%, resets in ~3d 1h.
    { cap: "seven_day", pct: 40, resetsAt: iso(3 * DAY + HOUR), capturedAt: iso(0) },
  ],
  shares: [
    { user: "hexxt-git", cap: "five_hour", pct: 35 },
    { user: "edaywalid", cap: "five_hour", pct: 20 },
    { user: "lai0xn", cap: "five_hour", pct: 15 },
    { user: "hexxt-git", cap: "seven_day", pct: 20 },
    { user: "edaywalid", cap: "seven_day", pct: 12 },
    { user: "lai0xn", cap: "seven_day", pct: 8 },
  ],
  members: [
    { user: "hexxt-git", tokens: 4_200_000, lastActivityAt: iso(-30_000) },
    { user: "edaywalid", tokens: 2_400_000, lastActivityAt: iso(-90_000) },
    { user: "lai0xn", tokens: 1_800_000, lastActivityAt: iso(-5 * 60_000) },
  ],
  users: [
    { name: "hexxt-git", createdAt: iso(-10 * DAY) },
    { name: "edaywalid", createdAt: iso(-9 * DAY) },
    { name: "lai0xn", createdAt: iso(-8 * DAY) },
  ],
};

const VIEW_SOURCE: ViewSource = {
  fetchView: async (): Promise<SharedView> => ({ ...VIEW, generatedAt: new Date().toISOString() }),
  history: async (): Promise<HistoryPage> => ({ windows: [], nextBefore: null }),
  close: async (): Promise<void> => {},
};

const CONFIG: Config = {
  server: { url: "https://demo.invalid" },
  name: ME,
  pollIntervalMs: 60_000,
  configDirs: [process.env.CLAUDE_CONFIG_DIR!],
  logLevel: "error",
};

/**
 * The TUI reads the daemon's `state.json`/pid from disk (via `gatherView`), so a
 * pure ViewSource isn't enough: without these the footer shows "daemon not
 * running" and no sync time. Writing a live-pid + fresh-sync snapshot makes the
 * demo present as a healthy, connected daemon. Rewritten each tick so "synced 12s
 * ago" stays pinned instead of drifting as the process runs.
 */
function writeDaemonSnapshot(): void {
  const t = Date.now();
  const { pidFile, stateFile } = daemonPaths(ccpoolDir(), CONFIG.configDirs[0]!);
  const state: LocalState = {
    updatedAt: new Date(t).toISOString(),
    lastSyncAt: new Date(t - 12_000).toISOString(), // -> "synced 12s ago"
    account: { id: null, tokenExpired: false },
    samples: VIEW.samples,
    daemon: { pid: process.pid, startedAt: new Date(t - HOUR).toISOString() },
    pollError: null,
  };
  writeFileSync(pidFile, String(process.pid)); // this live process reads as "running"
  writeFileSync(stateFile, JSON.stringify(state));
}

async function main(): Promise<void> {
  mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  writeDaemonSnapshot();
  const keepFresh = setInterval(writeDaemonSnapshot, 1_000);

  process.stdout.write("\x1B[2J\x1B[H"); // clear screen
  const app = render(<App cfg={CONFIG} viewSource={VIEW_SOURCE} />);
  const quit = () => {
    clearInterval(keepFresh);
    process.stdout.write("\x1B[2J\x1B[H");
  };
  process.once("SIGINT", () => {
    quit();
    process.exit(0);
  });
  await app.waitUntilExit();
  quit();
}

void main();
