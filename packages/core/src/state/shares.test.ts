import { describe, expect, it } from "vitest";
import { attributeShares, resolveResetBoundary } from "./shares.js";
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

  it("does not let a duplicate late witness of the same reset wipe out real attribution", () => {
    // The real-world incident: machine A catches the reset on time (offset 10).
    // Machine B was asleep and only polls again at offset 50, comparing its stale
    // 90% cache to the current tank and "discovering" the same drop late. Blindly
    // taking the latest recorded reset (offset 50) would anchor the window there and
    // dump sam's whole post-reset climb into unknown. The trajectory rises (2 -> 17)
    // across offset 50 — no step down — so B's late witness is rejected and the window
    // anchors on A's corroborated instant.
    const samples = [
      sample("five_hour", 90, 0),
      sample("five_hour", 2, 10),
      sample("five_hour", 15, 20),
      sample("five_hour", 17, 50),
    ];
    const resets = [
      reset("five_hour", 10, 90), // machine A, on time
      reset("five_hour", 50, 90), // machine B, late duplicate witness (same previousPct)
    ];
    const messages = [msg("sam", 15, 1000), msg("sam", 40, 1000)];
    const rows = attributeShares(samples, messages, now, resets);
    expect(get(rows, "sam")).toBeCloseTo(15, 5); // the whole 2 -> 17 climb
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(2, 5); // just the post-reset baseline
  });

  it("rejects a late witness that slept through a climb (stale-low previousPct)", () => {
    // The variant that pct-clustering could not fix: machine B was awake at a low
    // point (its last poll saw 30%), slept while machine A drove the tank 30 -> 90 and
    // caught the reset on time (offset 10), then B woke at offset 50 and recorded a
    // reset with a stale-*low* previousPct (30) that shares nothing with A's peak (90).
    // Comparing previousPct pairwise (|30-90| = 60) would treat B as a distinct later
    // reset and wipe sam's climb — but the trajectory rises (15 -> 17) across offset 50.
    const samples = [
      sample("five_hour", 30, 0),
      sample("five_hour", 90, 8),
      sample("five_hour", 2, 10),
      sample("five_hour", 15, 20),
      sample("five_hour", 17, 50),
    ];
    const resets = [
      reset("five_hour", 10, 90), // machine A, on time
      reset("five_hour", 50, 30), // machine B, late — stale-low comparison point
    ];
    const messages = [msg("sam", 15, 1000), msg("sam", 40, 1000)];
    const rows = attributeShares(samples, messages, now, resets);
    expect(get(rows, "sam")).toBeCloseTo(15, 5); // the whole 2 -> 17 climb, not lost
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(2, 5); // just the post-reset baseline
  });

  it("still cuts the window at a genuinely later, distinct reset", () => {
    // A real second reset must still win: it has its own step down in the trajectory
    // (60 -> 3 at offset 30), so it is corroborated and becomes the latest boundary.
    const samples = [
      sample("five_hour", 90, 0),
      sample("five_hour", 5, 10), // reset 1
      sample("five_hour", 60, 20),
      sample("five_hour", 3, 30), // reset 2 — a distinct, later cycle
      sample("five_hour", 25, 40),
    ];
    const resets = [reset("five_hour", 10, 90), reset("five_hour", 30, 60)];
    const rows = attributeShares(samples, [msg("sam", 35, 1000)], now, resets);
    expect(get(rows, "sam")).toBeCloseTo(22, 5); // only the 3 -> 25 climb in the current cycle
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(3, 5); // reset-2 baseline only
  });

  it("keeps a genuine second reset that climbs back to the same level", () => {
    // Both cycles peak near 90 before resetting, so the two reset events share a
    // near-identical previousPct (90 and 88). pct-clustering would swallow the second
    // as a "duplicate"; the trajectory shows two real step-downs, so both stand and
    // the window anchors on the later one.
    const samples = [
      sample("five_hour", 90, 0),
      sample("five_hour", 4, 10), // reset 1
      sample("five_hour", 88, 40),
      sample("five_hour", 3, 50), // reset 2 — same level, real distinct cycle
      sample("five_hour", 20, 55),
    ];
    const resets = [reset("five_hour", 10, 90), reset("five_hour", 50, 88)];
    const rows = attributeShares(samples, [msg("sam", 53, 1000)], now, resets);
    expect(get(rows, "sam")).toBeCloseTo(17, 5); // only the 3 -> 20 climb after reset 2
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(3, 5); // reset-2 baseline only
  });

  it("honors a solo machine's lone late witness when nothing filled the gap", () => {
    // One machine only. It saw 90% at offset 0, then slept; while it slept the account
    // reset (mobile/web usage it can't observe drove the tank back up) and it woke at
    // offset 50 to find 17%, recording a late reset. There is no other witness and no
    // intervening sample, so the trajectory's only evidence is its own 90 -> 17 step
    // down — a real reset that must reopen the window (baseline 17, all unattributable).
    const samples = [sample("five_hour", 90, 0), sample("five_hour", 17, 50)];
    const resets = [reset("five_hour", 50, 90)];
    const rows = attributeShares(samples, [], now, resets);
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(17, 5); // post-reset baseline
  });

  it("does not truncate the window on a sub-threshold endpoint recomputation", () => {
    // Detection flags any pct drop over its 0.5 epsilon, so a 60.4 -> 59.6 downward
    // utilization *recomputation* (not a cycle flush) records a spurious reset. It is
    // below RESET_DROP_MIN_PCT, so it must NOT anchor the window a cycle early and
    // strand sam's earlier 0 -> 60 climb in a fresh, wrong cycle.
    const samples = [
      sample("five_hour", 0, 0),
      sample("five_hour", 60.4, 20),
      sample("five_hour", 59.6, 22), // endpoint correction, not a reset
      sample("five_hour", 62, 40),
    ];
    const resets = [reset("five_hour", 22, 60.4)];
    const messages = [msg("sam", 10, 1000), msg("sam", 30, 1000)];
    const rows = attributeShares(samples, messages, now, resets);
    expect(get(rows, "sam")).toBeCloseTo(62, 5); // the whole climb stays sam's
    expect(get(rows, UNKNOWN_USER)).toBeCloseTo(0, 5);
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

// Direct, exhaustive coverage of the window-boundary resolver. Samples/resets here are
// the already-parsed shapes attributeShares feeds it: `t` is a plain ordinal instant
// and pct/previousPct are 0..100. NONE (-Infinity) means "no genuine reset — leave the
// window on the cap-length cutoff".
describe("resolveResetBoundary", () => {
  const NONE = -Infinity;
  const s = (t: number, pct: number) => ({ t, pct });
  const r = (t: number, previousPct: number) => ({ t, previousPct });

  it("returns NONE when there are no reset events", () => {
    expect(resolveResetBoundary([s(0, 10), s(5, 40)], [])).toBe(NONE);
  });

  it("anchors on an on-time reset the trajectory steps down across", () => {
    // 90 just before offset 10, 2 at offset 10 — a real step down.
    expect(resolveResetBoundary([s(8, 90), s(10, 2), s(20, 15)], [r(10, 90)])).toBe(10);
  });

  it("treats the low sample stamped exactly at the reset instant as `after`", () => {
    // The detecting machine reports its post-reset reading with the same timestamp it
    // stamps the reset, so the drop sits at (before < t) -> (at t).
    expect(resolveResetBoundary([s(8, 90), s(10, 2)], [r(10, 90)])).toBe(10);
  });

  it("rejects a re-witness the trajectory RISES across", () => {
    // Post-reset climb 2 -> 15 -> 17; a late reset at offset 50 sits mid-climb.
    const samples = [s(0, 90), s(10, 2), s(20, 15), s(50, 17)];
    expect(resolveResetBoundary(samples, [r(10, 90), r(50, 90)])).toBe(10);
  });

  it("rejects a re-witness the trajectory is FLAT across", () => {
    const samples = [s(0, 90), s(10, 2), s(20, 17), s(48, 17), s(50, 17)];
    expect(resolveResetBoundary(samples, [r(10, 90), r(50, 90)])).toBe(10);
  });

  it("ignores a stale-high previousPct, judging by the trajectory before the event", () => {
    // The late witness claims previousPct 90, but the shared trajectory was at 15 just
    // before its wake — 15 -> 17 is no drop, so it is rejected regardless of its claim.
    const samples = [s(0, 30), s(8, 90), s(10, 2), s(20, 15), s(50, 17)];
    expect(resolveResetBoundary(samples, [r(10, 90), r(50, 90)])).toBe(10);
  });

  it("ignores a stale-low previousPct the same way", () => {
    const samples = [s(0, 30), s(8, 90), s(10, 2), s(20, 15), s(50, 17)];
    expect(resolveResetBoundary(samples, [r(10, 90), r(50, 30)])).toBe(10);
  });

  it("keeps the later of two genuine resets", () => {
    const samples = [s(0, 90), s(10, 5), s(20, 60), s(30, 3), s(40, 25)];
    expect(resolveResetBoundary(samples, [r(10, 90), r(30, 60)])).toBe(30);
  });

  it("keeps a genuine second reset back to the same level (its own step down)", () => {
    const samples = [s(0, 90), s(10, 4), s(40, 88), s(50, 3), s(55, 20)];
    expect(resolveResetBoundary(samples, [r(10, 90), r(50, 88)])).toBe(50);
  });

  it("collapses many witnesses of one reset onto the earliest, corroborated instant", () => {
    // On-time at 10, plus two late re-witnesses at 30 and 55, all of the same reset.
    const samples = [s(0, 90), s(10, 2), s(30, 12), s(55, 20)];
    const resets = [r(10, 90), r(30, 90), r(55, 40)];
    expect(resolveResetBoundary(samples, resets)).toBe(10);
  });

  it("picks the second cycle's on-time instant when both cycles have late witnesses", () => {
    // Cycle 1: on-time @10, late re-witness @25. Cycle 2: on-time @60, late re-witness
    // @90. Only the two on-time events are corroborated; the boundary is the later one.
    const samples = [s(0, 90), s(10, 3), s(25, 20), s(55, 80), s(60, 4), s(90, 30)];
    const resets = [r(10, 90), r(25, 90), r(60, 80), r(90, 55)];
    expect(resolveResetBoundary(samples, resets)).toBe(60);
  });

  it("keeps a genuine low-utilization reset (drop above the threshold)", () => {
    // A barely-used cap: 5 -> 0.5 is a real cycle flush, comfortably over 2 points.
    expect(resolveResetBoundary([s(0, 5), s(10, 0.5), s(20, 3)], [r(10, 5)])).toBe(10);
  });

  it("rejects a sub-threshold downward recomputation (not a cycle boundary)", () => {
    // 60.4 -> 59.6 is a 0.8-point endpoint correction, under RESET_DROP_MIN_PCT.
    expect(resolveResetBoundary([s(0, 0), s(20, 60.4), s(22, 59.6)], [r(22, 60.4)])).toBe(NONE);
  });

  it("rejects a drop of exactly the threshold, keeps one just over it", () => {
    expect(resolveResetBoundary([s(0, 50), s(10, 48)], [r(10, 50)])).toBe(NONE); // 2.0, not > 2
    expect(resolveResetBoundary([s(0, 50), s(10, 47.9)], [r(10, 50)])).toBe(10); // 2.1
  });

  it("trusts a reset newer than every sample (its post-reset reading hasn't landed)", () => {
    // No sample at/after the event yet -> `after` is null -> trust the fresh reset so
    // the window still opens the instant a drop is detected.
    expect(resolveResetBoundary([s(0, 90)], [r(10, 90)])).toBe(10);
  });

  it("falls back to previousPct only when no earlier sample exists", () => {
    // Event precedes the whole trajectory: no `before` sample, so its own previousPct
    // stands in. A high claim over a low first sample corroborates; a low one does not.
    expect(resolveResetBoundary([s(10, 2), s(20, 15)], [r(5, 90)])).toBe(5);
    expect(resolveResetBoundary([s(10, 2), s(20, 15)], [r(5, 3)])).toBe(NONE);
  });

  it("is order-independent across the reset events", () => {
    const samples = [s(0, 90), s(10, 5), s(20, 60), s(30, 3), s(40, 25)];
    expect(resolveResetBoundary(samples, [r(30, 60), r(10, 90)])).toBe(30);
    expect(resolveResetBoundary(samples, [r(10, 90), r(30, 60)])).toBe(30);
  });

  it("returns NONE when every recorded reset is an uncorroborated re-witness", () => {
    // A monotonic climb with only late re-witnesses stamped mid-rise: none is a real
    // boundary, so the window falls back to the cap-length cutoff rather than a phantom.
    const samples = [s(0, 5), s(20, 20), s(50, 35)];
    expect(resolveResetBoundary(samples, [r(20, 90), r(50, 90)])).toBe(NONE);
  });
});
