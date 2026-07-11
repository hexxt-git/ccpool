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

// `pnpm demo --animated`: instead of a frozen snapshot, drive the view forward off
// the wall clock (the TUI re-polls fast in this mode, so the climb is smooth). The
// 5h window climbs from empty to 100% over FIVE_FILL_MS; the 7-day window opens
// at 20% and rises at 15% of that speed, freezing when the 5h window tops out.
// Per-person columns tick up monotonically via fillTo — no jitter.
const ANIMATED = process.argv.includes("--animated");

const PARTICIPANTS = ["hexxt-git", "edaywalid", "lai0xn"] as const;
// Inherent per-person pace: some drive Code harder than others, so their slice of
// each window grows faster. Scales the random weight bump each frame.
const SPEED: Record<(typeof PARTICIPANTS)[number], number> = {
  "hexxt-git": 1.6,
  edaywalid: 1.0,
  lai0xn: 0.7,
};
const START_DELAY_MS = 3_000; // hold the opening frame this long before anything moves
const FIVE_START = 0; // the 5h window climbs up from empty
const SEVEN_START = 20; // the 7-day window opens partway in
const FIVE_FILL_MS = 12_000; // time for the 5h window to climb 0% -> 100%
const FIVE_RATE = (100 - FIVE_START) / FIVE_FILL_MS; // points per ms
const SEVEN_RATE = FIVE_RATE * 0.15; // 7-day rises at 15% of the 5h speed

const tokens: Record<string, number> = Object.fromEntries(
  VIEW.members.map((m) => [m.user, m.tokens])
);
// edaywalid's usage plateaus: his slice climbs to WALID_CAP% then holds there while
// everyone else keeps rising.
const WALID = "edaywalid";
const WALID_CAP = 14;
const UNKNOWN_FRAC = 0.05; // a steady sliver stays unattributed
const SUM_SPEED = PARTICIPANTS.reduce((s, u) => s + SPEED[u], 0);

// The window is split into whole percentage points, allotted one at a time so every
// row (each person + `unknown`) only ever climbs — never jitters up and down. As the
// header grows we hand each new point to whichever row is furthest below its target,
// so the columns track their ideal proportions monotonically.
type Row = (typeof PARTICIPANTS)[number] | "unknown";
const ROWS: Row[] = [...PARTICIPANTS, "unknown"];
const alloc: Record<"five" | "seven", Record<Row, number>> = {
  five: { "hexxt-git": 0, edaywalid: 0, lai0xn: 0, unknown: 0 },
  seven: { "hexxt-git": 0, edaywalid: 0, lai0xn: 0, unknown: 0 },
};

/** Each row's ideal point count for a window sitting at `total` percent. */
function idealAt(total: number): Record<Row, number> {
  const unknown = UNKNOWN_FRAC * total;
  const userBudget = total - unknown;
  const walid = Math.min(WALID_CAP, (SPEED[WALID] / SUM_SPEED) * userBudget);
  const rest = userBudget - walid; // walid's cap spills over to the other two
  const restSpeed = SPEED["hexxt-git"] + SPEED.lai0xn;
  return {
    "hexxt-git": (SPEED["hexxt-git"] / restSpeed) * rest,
    edaywalid: walid,
    lai0xn: (SPEED.lai0xn / restSpeed) * rest,
    unknown,
  };
}

/** Fill a window up to `targetTotal` points, one at a time to the neediest row. */
function fillTo(cap: "five" | "seven", targetTotal: number): void {
  const A = alloc[cap];
  let sum = ROWS.reduce((s, r) => s + A[r], 0);
  while (sum < targetTotal) {
    const ideal = idealAt(sum + 1);
    let best: Row = ROWS[0]!;
    let bestDeficit = -Infinity;
    for (const r of ROWS) {
      const deficit = ideal[r] - A[r];
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        best = r;
      }
    }
    A[best] += 1;
    sum += 1;
  }
}

// Time left on each window's reset, counted down 1–3 minutes per animation tick so
// the "resets in …" clock visibly runs down.
const resetMs = { five: 3 * HOUR + 12 * 60_000, seven: 3 * DAY + HOUR };
let animStart = 0;

function animatedView(): SharedView {
  if (animStart === 0) animStart = Date.now();
  // Sit on the opening frame for START_DELAY_MS, then let the clock drive the climb.
  const elapsed = Math.max(0, Date.now() - animStart - START_DELAY_MS);
  const fivePct = Math.min(100, FIVE_START + FIVE_RATE * elapsed);
  // Freeze the 7-day window at the instant the 5h window hits 100%.
  const sevenElapsed = Math.min(elapsed, FIVE_FILL_MS);
  const sevenPct = SEVEN_START + SEVEN_RATE * sevenElapsed;

  // Integer header + whole-point shares so every row (including unknown) only climbs.
  const fiveTotal = Math.round(fivePct);
  const sevenTotal = Math.round(sevenPct);
  fillTo("five", fiveTotal);
  fillTo("seven", sevenTotal);

  const shares: SharedView["shares"] = [];
  for (const cap of ["five", "seven"] as const) {
    const capKind = cap === "five" ? "five_hour" : "seven_day";
    for (const u of PARTICIPANTS) shares.push({ user: u, cap: capKind, pct: alloc[cap][u] });
    // Emit unknown from alloc — don't let design-model derive it as (float header − members),
    // which jitters when the bar uses fractional pct but shares are whole points.
    shares.push({ user: "unknown", cap: capKind, pct: alloc[cap].unknown });
  }

  if (elapsed > 0) {
    for (const u of PARTICIPANTS)
      tokens[u] = (tokens[u] ?? 0) + Math.round(Math.random() * 4_000 * SPEED[u]);
    // Run each reset clock down by 1–3 minutes this tick.
    for (const cap of ["five", "seven"] as const)
      resetMs[cap] = Math.max(0, resetMs[cap] - (1 + Math.floor(Math.random() * 3)) * 60_000);
  }

  const now = Date.now();
  return {
    generatedAt: new Date(now).toISOString(),
    samples: [
      {
        cap: "five_hour",
        pct: fiveTotal,
        resetsAt: new Date(now + resetMs.five).toISOString(),
        capturedAt: iso(0),
      },
      {
        cap: "seven_day",
        pct: sevenTotal,
        resetsAt: new Date(now + resetMs.seven).toISOString(),
        capturedAt: iso(0),
      },
    ],
    shares,
    members: PARTICIPANTS.map((u) => ({
      user: u,
      tokens: tokens[u]!,
      lastActivityAt: iso(-Math.round(Math.random() * 20_000)),
    })),
    users: VIEW.users,
  };
}

const VIEW_SOURCE: ViewSource = {
  fetchView: async (): Promise<SharedView> =>
    ANIMATED ? animatedView() : { ...VIEW, generatedAt: new Date().toISOString() },
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
    // The sandbox Claude config has no signed-in account, so gatherView's email
    // lookup comes up empty — seed this so the footer shows a realistic address
    // instead of a bare "—".
    account: { id: "claudeteam2026@gmail.com", tokenExpired: false },
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
  // In animated mode poll fast so the climbing windows render smoothly instead of
  // jumping every 2s; the static demo keeps the production cadence.
  const app = render(
    <App cfg={CONFIG} viewSource={VIEW_SOURCE} pollIntervalMs={ANIMATED ? 150 : undefined} />
  );
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
