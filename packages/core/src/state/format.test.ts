import { describe, expect, it } from "vitest";
import { bar, countdown, pctLabel } from "./format.js";

describe("bar", () => {
  it("renders a clamped fixed-width bar", () => {
    expect(bar(0, 10)).toBe("░░░░░░░░░░");
    expect(bar(100, 10)).toBe("▓▓▓▓▓▓▓▓▓▓");
    expect(bar(50, 10)).toBe("▓▓▓▓▓░░░░░");
    expect(bar(150, 10)).toBe("▓▓▓▓▓▓▓▓▓▓");
    expect(bar(-5, 10)).toBe("░░░░░░░░░░");
  });
});

describe("pctLabel", () => {
  it("rounds to whole percent", () => {
    expect(pctLabel(46.4)).toBe("46%");
    expect(pctLabel(18.6)).toBe("19%");
  });
});

describe("countdown", () => {
  const now = Date.parse("2026-06-29T20:00:00.000Z");
  it("shows days+hours far out", () => {
    expect(countdown("2026-07-05T22:00:00.000Z", now)).toBe("6d 2h");
  });
  it("shows hours+minutes within a day", () => {
    expect(countdown("2026-06-29T21:10:00.000Z", now)).toBe("1h 10m");
  });
  it("shows minutes under an hour", () => {
    expect(countdown("2026-06-29T20:25:00.000Z", now)).toBe("25m");
  });
  it("returns due/empty for past or missing resets", () => {
    expect(countdown("2026-06-29T19:00:00.000Z", now)).toBe("due");
    expect(countdown(null, now)).toBe("");
  });
});
