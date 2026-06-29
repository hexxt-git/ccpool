import { describe, expect, it } from "vitest";
import { attributeShares } from "./shares.js";
import { UNKNOWN_USER, type MessageUsage, type UsageSample } from "../types.js";

const T0 = Date.parse("2026-06-29T20:00:00.000Z");
const at = (offsetMin: number) => new Date(T0 + offsetMin * 60_000).toISOString();
const now = T0 + 60 * 60_000;

const sample = (cap: UsageSample["cap"], pct: number, offsetMin: number): UsageSample => ({
  cap,
  pct,
  resetsAt: null,
  capturedAt: at(offsetMin),
});

const msg = (
  user: string,
  offsetMin: number,
  tokens: number,
  model: string | null = null
): MessageUsage => ({
  uuid: `${user}-${offsetMin}`,
  user,
  timestamp: at(offsetMin),
  model,
  inputTokens: tokens,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
});

const fiveHour = (rows: ReturnType<typeof attributeShares>) =>
  rows.filter((r) => r.cap === "five_hour");
const get = (rows: ReturnType<typeof attributeShares>, user: string) =>
  fiveHour(rows).find((r) => r.user === user)?.pct ?? 0;

describe("attributeShares", () => {
  it("keeps pre-daemon tank as unknown (the 80% baseline case)", () => {
    // daemon starts when the tank is already 80%, before any measured activity
    const rows = attributeShares([sample("five_hour", 80, 0)], [], now);
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(80, 5);
  });

  it("credits only the rise that coincides with the user's activity", () => {
    // baseline 80% (pre-daemon), then user does work and the tank rises 80 -> 85
    const samples = [sample("five_hour", 80, 0), sample("five_hour", 85, 10)];
    const messages = [msg("sam", 5, 1000)];
    const rows = attributeShares(samples, messages, now);
    expect(get(rows, "sam")).toBeCloseTo(5, 5); // only the +5 they caused
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(80, 5); // the pre-existing 80 stays unknown
  });

  it("routes a rise with no Code activity to unknown (mobile/web/chat)", () => {
    // tank climbs 20 -> 50 but there is no Code activity at all -> unknown
    const samples = [sample("five_hour", 20, 0), sample("five_hour", 50, 10)];
    const rows = attributeShares(samples, [], now);
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(50, 5);
  });

  it("does not credit a user for a rise outside their activity window", () => {
    // sam works in [0,10] (tank 0->20); then a rise 20->60 happens with no Code
    const samples = [
      sample("five_hour", 0, 0),
      sample("five_hour", 20, 10),
      sample("five_hour", 60, 20),
    ];
    const rows = attributeShares(samples, [msg("sam", 5, 1000)], now);
    expect(get(rows, "sam")).toBeCloseTo(20, 5); // only the rise during their window
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(40, 5); // the later un-attributed rise
  });

  it("splits a rise between users by token weight, summing to the delta", () => {
    const samples = [sample("five_hour", 0, 0), sample("five_hour", 60, 10)];
    const messages = [msg("sam", 5, 9000), msg("alex", 6, 3000)];
    const rows = attributeShares(samples, messages, now);
    expect(get(rows, "sam")).toBeCloseTo(45, 5);
    expect(get(rows, "alex")).toBeCloseTo(15, 5);
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(0, 5);
  });

  it("rows always sum to the latest tank per cap", () => {
    const samples = [
      sample("five_hour", 30, 0),
      sample("five_hour", 50, 10),
      sample("five_hour", 55, 20),
    ];
    const rows = fiveHour(attributeShares(samples, [msg("sam", 15, 500)], now));
    const total = rows.reduce((a, r) => a + r.pct, 0);
    expect(total).toBeCloseTo(55, 5);
  });

  it("resets the baseline when the tank drops (window reset)", () => {
    // 90% then a reset to 5%, then user climbs 5 -> 20
    const samples = [
      sample("five_hour", 90, 0),
      sample("five_hour", 5, 10),
      sample("five_hour", 20, 20),
    ];
    const rows = attributeShares(samples, [msg("sam", 15, 1000)], now);
    expect(get(rows, "sam")).toBeCloseTo(15, 5);
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(5, 5); // post-reset baseline only
  });

  it("only counts opus-model activity toward the opus cap", () => {
    const samples = [sample("seven_day_opus", 0, 0), sample("seven_day_opus", 40, 10)];
    // a non-opus message must not claim opus usage
    const rows = attributeShares(samples, [msg("sam", 5, 1000, "claude-sonnet-4-6")], now);
    const opus = rows.filter((r) => r.cap === "seven_day_opus");
    expect(opus.find((r) => r.user === UNKNOWN_USER)?.pct).toBeCloseTo(40, 5);
    expect(opus.find((r) => r.user === "sam")).toBeUndefined();
  });
});
