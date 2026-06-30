import type { CapKind, MessageUsage, ResetEvent, UsageSample, UserShare } from "../types.js";
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
  return m.cacheCreationTokens + m.cacheReadTokens + m.outputTokens;
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
 * @param samples  the tank trajectory (all caps), any order
 * @param messages raw measured Code activity, any order
 * @param now      the instant the window is anchored to
 * @param resets   recorded reset events (all caps), any order — bound the window
 */
export function attributeShares(
  samples: UsageSample[],
  messages: MessageUsage[],
  now: number = Date.now(),
  resets: ResetEvent[] = []
): UserShare[] {
  const msgs = messages
    .map((m) => ({ t: Date.parse(m.timestamp), user: m.user, model: m.model, w: tokenWeight(m) }))
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
    out.push(...attributeCap(cap, capSamples, msgs, now, resetTimes));
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
  now: number,
  resetTimes: number[]
): UserShare[] {
  // Bound to the current window. Start at the most recent reset (a *recorded*
  // event, not a re-detected pct drop — see attributeShares) and never look back
  // further than the cap's window length.
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
  // skip messages at or before the baseline instant
  while (mi < msgs.length && msgs[mi]!.t <= win[0]!.t) mi++;

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

    // Measure the rise off the running max. A dip (clock-skew reorder or float
    // wobble) is a new-high of zero, so it can't inflate a user or be skipped in a
    // way that drops their interval's messages unfairly.
    const newMax = cur.pct > envMax ? cur.pct : envMax;
    const delta = newMax - envMax;
    envMax = newMax;
    if (delta <= 0) continue;

    if (total > 0) {
      for (const [u, w] of weights) {
        attributed.set(u, (attributed.get(u) ?? 0) + (delta * w) / total);
      }
    } else {
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
