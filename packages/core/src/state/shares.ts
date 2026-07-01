import type {
  CapKind,
  MessageUsage,
  ResetEvent,
  UsageMarker,
  UsageSample,
  UserShare,
} from "../types.js";
import { CAP_KINDS, UNKNOWN_USER } from "../types.js";

const HOUR = 60 * 60 * 1000;

/** Each cap's window length, used to bound how far back attribution looks. */
export const CAP_WINDOW_MS: Record<CapKind, number> = {
  five_hour: 5 * HOUR,
  seven_day: 7 * 24 * HOUR,
  seven_day_opus: 7 * 24 * HOUR,
};

/**
 * Attribution weight. The cache fields (read + creation) are the reliable,
 * high-volume signal; `output` is the user's generated work. `input_tokens` is
 * left out on purpose — it undercounts and isn't comparable between users, so
 * folding it in only skews the inter-user split.
 */
function tokenWeight(m: MessageUsage): number {
  // Clamp to >= 0 as defense in depth: the reader already rejects negative counts,
  // but a legacy row (ingested before that guard) with a negative field must not be
  // able to invert a user's share or make `total` non-positive.
  return Math.max(0, m.cacheCreationTokens + m.cacheReadTokens + m.outputTokens);
}

function isOpus(model: string | null): boolean {
  return !!model && model.toLowerCase().includes("opus");
}

/**
 * Attribute the account tank to participants by correlating tank *deltas* with the
 * Code activity seen during the same interval.
 *
 * The tank's level at the earliest reading we have (within the current window)
 * is `unknown`'s baseline — so usage that predates the daemon stays unattributed.
 * Each later rise in the tank is split among whoever had Code activity in that
 * interval; a rise with no Code activity anywhere (mobile/web/chat, or the daemon
 * being down) falls to `unknown`. `unknown` always absorbs the remainder so each
 * column totals the tank.
 *
 * Two properties keep this honest across machines:
 *   - The window is bounded by *recorded* {@link ResetEvent}s, not by re-detecting
 *     pct drops in the merged series. Clock skew between machines can reorder
 *     readings (46% landing before 45%); a view-time drop check reads that as a
 *     phantom reset and dumps the split into `unknown`. Reset events are recorded
 *     on a single machine's clock, so they don't suffer that.
 *   - Rises are measured off a monotonic envelope (running max within the window),
 *     so an out-of-order dip or sub-point wobble is a new-high of zero — it neither
 *     inflates the active user nor discards their interval.
 *
 * It's still an estimate (cache fields reliable; raw I/O undercounts; same-interval
 * Code + chat can't be perfectly separated).
 *
 * Activity {@link UsageMarker}s are a **fallback only**: when an interval's rise
 * has no measured Code activity but a machine flagged that its user was actively
 * driving Code then (a lagged tail or a resume/compaction re-prime the transcript
 * under-reports), the rise is credited to that user rather than `unknown`. A real
 * message in the interval always takes precedence, so markers can never dilute
 * measured attribution.
 *
 * @param samples  the tank trajectory (all caps), any order
 * @param messages raw measured Code activity, any order
 * @param now      the instant the window is anchored to
 * @param resets   recorded reset events (all caps), any order — bound the window
 * @param markers  daemon activity markers, any order — fill otherwise-empty rises
 */
export function attributeShares(
  samples: UsageSample[],
  messages: MessageUsage[],
  now: number = Date.now(),
  resets: ResetEvent[] = [],
  markers: UsageMarker[] = []
): UserShare[] {
  // A message dated in the future (clock skew on the writing machine) sorts to the
  // end and never satisfies `t <= cur.t` for any real sample, so it's simply never
  // matched — its interval's rise falls to `unknown`. That's the safe fallback, so
  // we deliberately don't hard-filter at `now` (which would risk dropping a genuine
  // last-interval message under sub-second skew between writer and reader clocks).
  const msgs = messages
    .map((m) => ({ t: Date.parse(m.timestamp), user: m.user, model: m.model, w: tokenWeight(m) }))
    .filter((m) => Number.isFinite(m.t))
    .sort((a, b) => a.t - b.t);

  // Markers carry the same shape as messages (a positive weight, floored at 1 so
  // a zero-weight marker still counts), sorted so they can be walked in lockstep.
  const mks = markers
    .map((m) => ({ t: Date.parse(m.at), user: m.user, model: m.model, w: Math.max(1, m.weight) }))
    .filter((m) => Number.isFinite(m.t))
    .sort((a, b) => a.t - b.t);

  const out: UserShare[] = [];
  for (const cap of CAP_KINDS) {
    const capSamples = samples
      .filter((s) => s.cap === cap)
      .map((s) => ({ t: Date.parse(s.capturedAt), pct: s.pct }))
      .filter((s) => Number.isFinite(s.t))
      .sort((a, b) => a.t - b.t);
    if (capSamples.length === 0) continue;
    const resetTimes = resets
      .filter((r) => r.cap === cap)
      .map((r) => Date.parse(r.at))
      .filter((t) => Number.isFinite(t) && t <= now);
    out.push(...attributeCap(cap, capSamples, msgs, mks, now, resetTimes));
  }
  return out;
}

interface TimedSample {
  t: number;
  pct: number;
}
interface TimedMsg {
  t: number;
  user: string;
  model: string | null;
  w: number;
}

function attributeCap(
  cap: CapKind,
  capSamples: TimedSample[],
  msgs: TimedMsg[],
  markers: TimedMsg[],
  now: number,
  resetTimes: number[]
): UserShare[] {
  // Bound to the current window. Start at the most recent reset (a *recorded*
  // event, not a re-detected pct drop — see attributeShares) and never look back
  // further than the cap's window length.
  // `start` lands on the last sample *before* the cutoff, so its pct anchors the
  // window as `unknown`'s baseline. After a long daemon gap that anchor can be
  // stale (older than the cutoff), but a recorded reset (below) normally supersedes
  // it, and treating pre-window level as unknown is the conservative bias we want.
  const cutoff = now - CAP_WINDOW_MS[cap];
  let start = 0;
  for (let i = 1; i < capSamples.length; i++) {
    if (capSamples[i]!.t < cutoff) start = i; // too old to matter
  }
  const lastReset = resetTimes.length ? Math.max(...resetTimes) : -Infinity;
  if (lastReset > -Infinity) {
    // drop everything from a previous reset cycle: the window begins at the first
    // sample at/after the reset (or the lone last sample if none caught up yet).
    let firstAfter = capSamples.length - 1;
    for (let i = 0; i < capSamples.length; i++) {
      if (capSamples[i]!.t >= lastReset) {
        firstAfter = i;
        break;
      }
    }
    start = Math.max(start, firstAfter);
  }
  const win = capSamples.slice(start);

  const opusOnly = cap === "seven_day_opus";
  const attributed = new Map<string, number>();
  attributed.set(UNKNOWN_USER, win[0]!.pct); // baseline: pre-daemon usage is unknown

  let mi = 0;
  let ki = 0;
  // skip messages and markers at or before the baseline instant
  while (mi < msgs.length && msgs[mi]!.t <= win[0]!.t) mi++;
  while (ki < markers.length && markers[ki]!.t <= win[0]!.t) ki++;

  let envMax = win[0]!.pct; // monotonic envelope: rises only, dips contribute zero
  for (let i = 1; i < win.length; i++) {
    const cur = win[i]!;

    // gather this interval's Code activity (advance the pointer regardless of
    // delta, so messages in a no-rise interval are simply dropped)
    const weights = new Map<string, number>();
    let total = 0;
    while (mi < msgs.length && msgs[mi]!.t <= cur.t) {
      const m = msgs[mi]!;
      mi++;
      if (opusOnly && !isOpus(m.model)) continue;
      weights.set(m.user, (weights.get(m.user) ?? 0) + m.w);
      total += m.w;
    }

    // gather this interval's activity markers separately — they're a fallback used
    // only when no real message covers the rise (below), so they can never dilute
    // measured attribution.
    const markerWeights = new Map<string, number>();
    let markerTotal = 0;
    while (ki < markers.length && markers[ki]!.t <= cur.t) {
      const m = markers[ki]!;
      ki++;
      if (opusOnly && !isOpus(m.model)) continue;
      markerWeights.set(m.user, (markerWeights.get(m.user) ?? 0) + m.w);
      markerTotal += m.w;
    }

    // Measure the rise off the running max. A dip (clock-skew reorder or float
    // wobble) is a new-high of zero, so it can't inflate a user or be skipped in a
    // way that drops their interval's messages unfairly.
    const newMax = cur.pct > envMax ? cur.pct : envMax;
    const delta = newMax - envMax;
    envMax = newMax;
    if (delta <= 0) continue;

    if (total > 0) {
      // measured Code activity — the reliable signal, always wins
      for (const [u, w] of weights) {
        attributed.set(u, (attributed.get(u) ?? 0) + (delta * w) / total);
      }
    } else if (markerTotal > 0) {
      // no measured activity, but a machine flagged its user was driving Code then
      for (const [u, w] of markerWeights) {
        attributed.set(u, (attributed.get(u) ?? 0) + (delta * w) / markerTotal);
      }
    } else {
      // genuinely nobody — mobile/web/chat, or daemon down
      attributed.set(UNKNOWN_USER, (attributed.get(UNKNOWN_USER) ?? 0) + delta);
    }
  }

  // Normalize to the latest tank, dumping any drift into unknown (the bias we want).
  const target = win[win.length - 1]!.pct;
  let nonUnknown = 0;
  for (const [u, p] of attributed) if (u !== UNKNOWN_USER) nonUnknown += p;

  const rows: UserShare[] = [];
  if (nonUnknown > target && nonUnknown > 0) {
    const scale = target / nonUnknown; // users can't exceed the tank
    for (const [u, p] of attributed) {
      if (u !== UNKNOWN_USER) rows.push({ user: u, cap, pct: p * scale });
    }
    rows.push({ user: UNKNOWN_USER, cap, pct: 0 });
  } else {
    for (const [u, p] of attributed) {
      if (u !== UNKNOWN_USER) rows.push({ user: u, cap, pct: p });
    }
    rows.push({ user: UNKNOWN_USER, cap, pct: Math.max(0, target - nonUnknown) });
  }
  return rows;
}
