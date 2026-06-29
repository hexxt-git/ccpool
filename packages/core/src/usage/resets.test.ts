import { describe, expect, it } from "vitest";
import { detectResets } from "./resets.js";
import type { UsageSample } from "../types.js";

const s = (cap: UsageSample["cap"], pct: number): UsageSample => ({
  cap,
  pct,
  resetsAt: null,
  capturedAt: "2026-06-29T00:00:00.000Z",
});

describe("detectResets", () => {
  it("flags a cap whose pct dropped", () => {
    const events = detectResets(
      [s("five_hour", 80)],
      [s("five_hour", 5)],
      "2026-06-29T01:00:00.000Z"
    );
    expect(events).toEqual([{ cap: "five_hour", at: "2026-06-29T01:00:00.000Z", previousPct: 80 }]);
  });

  it("does not flag a rise or steady reading", () => {
    expect(detectResets([s("five_hour", 40)], [s("five_hour", 41)])).toEqual([]);
    expect(detectResets([s("five_hour", 40)], [s("five_hour", 40)])).toEqual([]);
  });

  it("ignores sub-epsilon float wobble", () => {
    expect(detectResets([s("seven_day", 40)], [s("seven_day", 39.8)])).toEqual([]);
  });

  it("does not flag a cap with no prior reading", () => {
    expect(detectResets([], [s("five_hour", 10)])).toEqual([]);
  });

  it("detects resets independently per cap", () => {
    const events = detectResets(
      [s("five_hour", 90), s("seven_day", 50)],
      [s("five_hour", 2), s("seven_day", 55)]
    );
    expect(events.map((e) => e.cap)).toEqual(["five_hour"]);
  });
});
