import { describe, expect, it } from "vitest";
import { apportionShares } from "./shares.js";
import { CAP_KINDS, UNKNOWN_USER, type UsageSample } from "../types.js";

const sample = (cap: UsageSample["cap"], pct: number): UsageSample => ({
  cap,
  pct,
  resetsAt: null,
  capturedAt: "2026-06-29T00:00:00.000Z",
});

describe("apportionShares", () => {
  it("gives the whole tank to unknown when nothing is attributable", () => {
    const rows = apportionShares([sample("five_hour", 42)], []);
    const fiveHour = rows.filter((r) => r.cap === "five_hour");
    expect(fiveHour).toEqual([{ user: UNKNOWN_USER, cap: "five_hour", pct: 42 }]);
  });

  it("splits the tank across users by measured weight, summing to the tank", () => {
    const rows = apportionShares(
      [sample("five_hour", 60)],
      [
        { user: "sam", cap: "five_hour", weight: 3 },
        { user: "alex", cap: "five_hour", weight: 1 },
      ]
    );
    const fiveHour = rows.filter((r) => r.cap === "five_hour");
    const total = fiveHour.reduce((a, r) => a + r.pct, 0);
    expect(total).toBeCloseTo(60, 6);
    expect(fiveHour.find((r) => r.user === "sam")!.pct).toBeCloseTo(45, 6);
    expect(fiveHour.find((r) => r.user === "alex")!.pct).toBeCloseTo(15, 6);
    expect(fiveHour.find((r) => r.user === UNKNOWN_USER)!.pct).toBeCloseTo(0, 6);
  });

  it("emits a row set for every cap kind", () => {
    const rows = apportionShares(
      CAP_KINDS.map((c) => sample(c, 10)),
      [{ user: "sam", cap: "seven_day", weight: 5 }]
    );
    for (const cap of CAP_KINDS) {
      expect(rows.some((r) => r.cap === cap)).toBe(true);
    }
  });
});
