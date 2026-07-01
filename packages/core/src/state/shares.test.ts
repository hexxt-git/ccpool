import { describe, expect, it } from "vitest";
import { attributeShares } from "./shares.js";
import {
  UNKNOWN_USER,
  type MessageUsage,
  type ResetEvent,
  type UsageMarker,
  type UsageSample,
} from "../types.js";

const T0 = Date.parse("2026-06-29T20:00:00.000Z");
const at = (offsetMin: number) => new Date(T0 + offsetMin * 60_000).toISOString();
const now = T0 + 60 * 60_000;

const sample = (cap: UsageSample["cap"], pct: number, offsetMin: number): UsageSample => ({
  cap,
  pct,
  resetsAt: null,
  capturedAt: at(offsetMin),
});

const reset = (cap: ResetEvent["cap"], offsetMin: number, previousPct: number): ResetEvent => ({
  cap,
  at: at(offsetMin),
  previousPct,
});

// `tokens` lands in a reliable field (cache read) since that's what attribution weighs.
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
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: tokens,
});

const marker = (
  user: string,
  offsetMin: number,
  weight = 1,
  model: string | null = null
): UsageMarker => ({
  id: `${user}-mk-${offsetMin}`,
  user,
  at: at(offsetMin),
  model,
  weight,
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

  it("resets the baseline at a recorded reset event", () => {
    // 90% then a reset to 5% (recorded), then user climbs 5 -> 20
    const samples = [
      sample("five_hour", 90, 0),
      sample("five_hour", 5, 10),
      sample("five_hour", 20, 20),
    ];
    const resets = [reset("five_hour", 10, 90)];
    const rows = attributeShares(samples, [msg("sam", 15, 1000)], now, resets);
    expect(get(rows, "sam")).toBeCloseTo(15, 5);
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(5, 5); // post-reset baseline only
  });

  it("does not treat a clock-skew reorder as a phantom reset", () => {
    // Two machines, skewed clocks: a genuine 45 -> 46 rise lands out of order in
    // the merged series (46% stamped before 45%). With no recorded reset, the dip
    // must contribute nothing rather than discard sam's earlier work to unknown.
    const samples = [
      sample("five_hour", 0, 0),
      sample("five_hour", 45, 10),
      sample("five_hour", 46, 14), // machine B, clock behind
      sample("five_hour", 45, 15), // machine A, clock ahead — reordered dip
      sample("five_hour", 46, 20),
    ];
    const messages = [msg("sam", 5, 1000), msg("sam", 12, 1000)];
    const rows = attributeShares(samples, messages, now);
    // sam drove the whole 0 -> 46; the skew dip neither resets (which would dump
    // sam's earlier 45 to unknown) nor inflates beyond the genuine 46.
    expect(get(rows, "sam")).toBeCloseTo(46, 5);
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(0, 5);
  });

  it("does not inflate a user from sub-percent wobble on a flat tank", () => {
    // Tank is genuinely flat at 50 with float wobble; sam is active throughout.
    // The old code summed every positive delta (0.3 + 0.4 = 0.7); the envelope
    // bounds sam to the single highest excursion above the baseline (0.3).
    const samples = [
      sample("five_hour", 50, 0),
      sample("five_hour", 50.3, 10),
      sample("five_hour", 49.8, 20),
      sample("five_hour", 50.2, 30),
      sample("five_hour", 50, 40),
    ];
    const messages = [msg("sam", 5, 1000), msg("sam", 15, 1000), msg("sam", 35, 1000)];
    const rows = attributeShares(samples, messages, now);
    expect(get(rows, "sam")).toBeCloseTo(0.3, 5);
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(49.7, 5);
  });

  it("clamps attributed shares so users never exceed the final tank", () => {
    // sam drives 0 -> 60 (envelope peak), then the tank slides back to 50 as the
    // window rolls. sam's credited rise (60) exceeds the final tank, so the clamp
    // must scale users down to 50 and leave unknown at 0.
    const samples = [
      sample("five_hour", 0, 0),
      sample("five_hour", 60, 10),
      sample("five_hour", 50, 30),
    ];
    const messages = [msg("sam", 5, 1000)];
    const rows = attributeShares(samples, messages, now);
    expect(get(rows, "sam")).toBeCloseTo(50, 5);
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(0, 5);
    expect(fiveHour(rows).reduce((a, r) => a + r.pct, 0)).toBeCloseTo(50, 5);
  });

  it("weighs attribution on reliable cache/output tokens, not input_tokens", () => {
    // Both users have equal input_tokens; only cache_read differs. The split must
    // follow the reliable field, not input.
    const samples = [sample("five_hour", 0, 0), sample("five_hour", 40, 10)];
    const messages: MessageUsage[] = [
      { ...msg("sam", 4, 0), inputTokens: 5000, cacheReadTokens: 3000 },
      { ...msg("alex", 6, 0), inputTokens: 5000, cacheReadTokens: 1000 },
    ];
    const rows = attributeShares(samples, messages, now);
    expect(get(rows, "sam")).toBeCloseTo(30, 5); // 3000 / 4000 of the +40
    expect(get(rows, "alex")).toBeCloseTo(10, 5); // 1000 / 4000 of the +40
  });

  it("drops messages with an unparseable timestamp instead of crashing", () => {
    const samples = [sample("five_hour", 0, 0), sample("five_hour", 40, 10)];
    const bad = { ...msg("sam", 5, 1000), timestamp: "not-a-date" };
    const rows = attributeShares(samples, [bad], now);
    // the bad message is filtered out, so its rise falls to unknown
    expect(get(rows, "sam")).toBeCloseTo(0, 5);
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(40, 5);
  });

  it("only counts opus-model activity toward the opus cap", () => {
    const samples = [sample("seven_day_opus", 0, 0), sample("seven_day_opus", 40, 10)];
    // a non-opus message must not claim opus usage
    const rows = attributeShares(samples, [msg("sam", 5, 1000, "claude-sonnet-4-6")], now);
    const opus = rows.filter((r) => r.cap === "seven_day_opus");
    expect(opus.find((r) => r.user === UNKNOWN_USER)?.pct).toBeCloseTo(40, 5);
    expect(opus.find((r) => r.user === "sam")).toBeUndefined();
  });

  it("clamps a negative token count so it can't invert the split", () => {
    // A corrupt/legacy row with negative tokens must weigh 0, not flip signs. Here
    // sam's negative field would otherwise make `total` non-positive and dump the
    // whole rise (or a negative share) onto the wrong bucket.
    const samples = [sample("five_hour", 0, 0), sample("five_hour", 40, 10)];
    const messages: MessageUsage[] = [
      { ...msg("sam", 4, 0), cacheReadTokens: -1000 }, // weight clamps to 0
      { ...msg("alex", 6, 0), cacheReadTokens: 1000 },
    ];
    const rows = attributeShares(samples, messages, now);
    expect(get(rows, "alex")).toBeCloseTo(40, 5); // alex is the only real weight
    expect(get(rows, "sam")).toBeCloseTo(0, 5); // never negative
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(0, 5);
  });

  it("credits an otherwise-unknown rise to a user with an activity marker", () => {
    // The tank rises 20 -> 40 with no measured message in the interval, but the
    // daemon flagged sam was driving Code then (a resume re-prime / lagged tail).
    const samples = [sample("five_hour", 20, 0), sample("five_hour", 40, 10)];
    const rows = attributeShares(samples, [], now, [], [marker("sam", 5)]);
    expect(get(rows, "sam")).toBeCloseTo(20, 5); // the +20 rise sam actually caused
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(20, 5); // the pre-daemon 20 baseline stays
  });

  it("lets a real message override a marker in the same interval", () => {
    // A marker is a fallback only: measured activity always wins, so the rise goes
    // to alex (who has a real message), not sam (marker only).
    const samples = [sample("five_hour", 0, 0), sample("five_hour", 30, 10)];
    const rows = attributeShares(samples, [msg("alex", 5, 1000)], now, [], [marker("sam", 5)]);
    expect(get(rows, "alex")).toBeCloseTo(30, 5);
    expect(get(rows, "sam")).toBeCloseTo(0, 5);
  });

  it("never lets a marker claim more than the rise it sits in", () => {
    // sam's marker is in [0,10] (rise +20); a later rise 20->50 has no marker and
    // must stay unknown — the marker can't spill into a neighbouring interval.
    const samples = [
      sample("five_hour", 0, 0),
      sample("five_hour", 20, 10),
      sample("five_hour", 50, 20),
    ];
    const rows = attributeShares(samples, [], now, [], [marker("sam", 5)]);
    expect(get(rows, "sam")).toBeCloseTo(20, 5);
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(30, 5);
  });

  it("does not let a non-opus marker claim opus usage", () => {
    const samples = [sample("seven_day_opus", 0, 0), sample("seven_day_opus", 40, 10)];
    const rows = attributeShares(samples, [], now, [], [marker("sam", 5, 1, "claude-sonnet-4-6")]);
    const opus = rows.filter((r) => r.cap === "seven_day_opus");
    expect(opus.find((r) => r.user === UNKNOWN_USER)?.pct).toBeCloseTo(40, 5);
    expect(opus.find((r) => r.user === "sam")).toBeUndefined();
  });
});
