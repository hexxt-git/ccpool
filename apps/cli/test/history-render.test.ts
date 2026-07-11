import { describe, it, expect } from "vitest";
import type { HistoryPage } from "@ccpool/core";
import { renderHistoryLines } from "../src/lib/history-render.js";

const page: HistoryPage = {
  nextBefore: null,
  windows: [
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
  ],
};

describe("renderHistoryLines", () => {
  it("renders a window×member matrix, newest first, with an overall column", () => {
    const lines = renderHistoryLines(page, { cap: "five_hour", width: 80 });
    expect(lines[0]).toContain("window");
    expect(lines[0]).toContain("overall");
    expect(lines[0]).toContain("alice");
    expect(lines[0]).toContain("bob");
    // First data row is the newest window (10:00) with alice's 50%.
    const first = lines[2];
    expect(first).toContain("06-29 10:00");
    expect(first).toContain("80%");
    expect(first).toContain("50%");
    // A member absent from a window shows a dash.
    const second = lines[3];
    expect(second).toContain("06-29 05:00");
    expect(second).toContain("-");
  });

  it("reports an empty history clearly", () => {
    expect(renderHistoryLines({ windows: [], nextBefore: null }, { cap: "seven_day" })).toEqual([
      "no weekly history yet",
    ]);
  });
});
