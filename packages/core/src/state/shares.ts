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
  // A future-dated message (writer clock skew) never matches a real sample and
  // falls to `unknown` — the safe fallback. We deliberately don't hard-filter at
  // `now`, which could drop a genuine last-interval message under sub-second skew.
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
    const capResets = resets
      .filter((r) => r.cap === cap)
      .map((r) => ({ t: Date.parse(r.at), previousPct: r.previousPct }))
      .filter((r) => Number.isFinite(r.t) && r.t <= now);
    out.push(...attributeCap(cap, capSamples, msgs, mks, now, capResets));
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
interface TimedReset {
  t: number;
  previousPct: number;
}

/**
 * A reset event that isn't a genuine cycle boundary must move the trajectory down by
 * at least this much. Comfortably above sub-percent clock-skew wobble and endpoint
 * utilization re-computations (a downward correction detection flags as a "reset");
 * far below a real cycle flush. A real reset at a very low utilization (a barely-used
 * cap) can fall under this — folding it costs at most this few percent of attribution,
 * the safe direction to err.
 */
const RESET_DROP_MIN_PCT = 2;

/**
 * Resolve the current cycle's start: the instant of the most recent *genuine* reset.
 *
 * Each {@link ResetEvent} is detected per machine by comparing that machine's own
 * consecutive readings (immune to cross-machine clock skew), so it's trustworthy
 * evidence that *a* real drop happened — but its timestamp and `previousPct` are not.
 * A machine that slept / restarted / was offline through a reset witnesses it *late*:
 * it stamps its own wake time and a stale `previousPct` (whatever the tank was when it
 * last polled — which may sit far above *or below* the true peak). Anchoring on the
 * latest recorded timestamp, as a blind `Math.max` would, moves the window past a
 * whole cycle of real, correctly-attributed usage and dumps it into `unknown`. That is
 * the false-reset bug.
 *
 * We pin the true instant against the one signal neither stale memory nor skew can
 * distort: the *merged sample trajectory*. Every machine reads the same account-wide
 * tank, and within a cycle the tank only rises, so a genuine reset appears in the
 * trajectory as a step DOWN across its instant — the level just before is well above
 * the level at/after. A *late re-witness* fires in the middle of the post-reset climb,
 * where the trajectory is flat or RISING across its instant; it shows no step down and
 * is rejected. The boundary is the latest reset event the trajectory corroborates.
 *
 * Why this is robust where comparing `previousPct`s pairwise is not:
 *   - A late witness that slept through a climb driven by *another* machine has a
 *     stale-low `previousPct` unrelated to the true peak — pct-proximity can't cluster
 *     it away, but the trajectory still rises across its wake, so it's rejected.
 *   - A genuine *second* reset that climbs back to the *same* level as the first has a
 *     near-identical `previousPct` — pct-proximity would swallow it, but it has its own
 *     real step-down in the trajectory, so it's kept.
 *   - A lone machine's late witness with nothing else filling the gap is still honored:
 *     the trajectory's only evidence is its own high→low, which *is* a step down, so a
 *     real solo reset is never blinded.
 *
 * `before` is the last trajectory sample strictly before the event — report-on-change
 * keeps the pre-reset peak as the last distinct level however long it stayed flat, so a
 * quiet peak is still found; `previousPct` is the fallback only when no earlier sample
 * exists at all. A reset newer than every sample (its post-reset reading hasn't landed
 * yet) has no `after` and is trusted, so a just-detected reset still opens the window.
 */
export function resolveResetBoundary(capSamples: TimedSample[], resetEvents: TimedReset[]): number {
  let boundary = -Infinity;
  for (const e of resetEvents) {
    if (e.t <= boundary) continue; // can't raise the max — skip the trajectory scan
    let before: number | null = null;
    let after: number | null = null;
    for (const s of capSamples) {
      if (s.t < e.t)
        before = s.pct; // last sample strictly before the event
      else {
        after = s.pct; // first sample at/after the event
        break;
      }
    }
    const beforeLevel = before ?? e.previousPct; // fall back only with no earlier sample
    const corroborated = after === null || beforeLevel - after > RESET_DROP_MIN_PCT;
    if (corroborated) boundary = e.t;
  }
  return boundary;
}

function attributeCap(
  cap: CapKind,
  capSamples: TimedSample[],
  msgs: TimedMsg[],
  markers: TimedMsg[],
  now: number,
  resetEvents: TimedReset[]
): UserShare[] {
  // Bound to the current window: start at the most recent recorded reset (not a
  // re-detected pct drop — see attributeShares), and no further back than the cap's
  // window length. `start` is the last sample before the cutoff, whose pct anchors
  // `unknown`'s baseline — treating pre-window level as unknown is the bias we want.
  const cutoff = now - CAP_WINDOW_MS[cap];
  let start = 0;
  for (let i = 1; i < capSamples.length; i++) {
    if (capSamples[i]!.t < cutoff) start = i; // too old to matter
  }
  const lastReset = resolveResetBoundary(capSamples, resetEvents);
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
