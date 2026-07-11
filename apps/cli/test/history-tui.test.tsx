import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import type { HistoryWindowView } from "@ccpool/core";
import { renderHistory, rankMembers, type HistoryState } from "../src/tui/history.js";

const windows: HistoryWindowView[] = [
  {
    cap: "five_hour",
    windowStart: "2026-06-29T10:00:00.000Z",
    windowEnd: "2026-06-29T15:00:00.000Z",
    overall: 80,
    shares: [
      { user: "alice", pct: 50 },
      { user: "bob", pct: 20 },
      { user: "unknown", pct: 10 },
    ],
  },
  {
    cap: "five_hour",
    windowStart: "2026-06-29T05:00:00.000Z",
    windowEnd: "2026-06-29T10:00:00.000Z",
    overall: 60,
    shares: [{ user: "alice", pct: 60 }], // bob absent this window
  },
];
const base: HistoryState = {
  capIdx: 0,
  windows,
  error: null,
  cursor: 0,
  expanded: false,
  memberOff: 0,
};

describe("renderHistory (ink frame)", () => {
  it("renders the window × member matrix with an overall column and a row cursor", () => {
    const f = render(<>{renderHistory("five_hour", base, 80, 20)}</>).lastFrame()!;
    expect(f).toContain("history");
    expect(f).toContain("window");
    expect(f).toContain("overall");
    expect(f).toContain("alice");
    expect(f).toContain("bob");
    expect(f).toContain("80%"); // overall, newest window
    expect(f).toContain("50%"); // alice's share
    expect(f).toContain("▸"); // cursor sits on the first (newest) row
    expect(f).toContain("–"); // bob is absent in the 05:00 window
  });

  it("expands the selected window into its per-member breakdown", () => {
    const f = render(
      <>{renderHistory("five_hour", { ...base, expanded: true }, 80, 20)}</>
    ).lastFrame()!;
    expect(f).toContain("overall");
    expect(f).toContain("alice");
    expect(f).toContain("esc back");
  });

  it("shows loading and empty states", () => {
    expect(
      render(<>{renderHistory("five_hour", { ...base, windows: null }, 80, 20)}</>).lastFrame()
    ).toContain("loading");
    expect(
      render(<>{renderHistory("seven_day", { ...base, windows: [] }, 80, 20)}</>).lastFrame()
    ).toContain("no weekly history");
  });

  it("ranks the top-K columns by total share, ties by name", () => {
    expect(rankMembers(windows)).toEqual(["alice", "bob", "unknown"]);
  });
});
