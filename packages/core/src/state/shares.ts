import type { CapKind, MessageUsage, UsageSample, UserShare } from "../types.js";
import { CAP_KINDS, UNKNOWN_USER } from "../types.js";

const HOUR = 60 * 60 * 1000;

/** Each cap's window length, used to bound how far back attribution looks. */
export const CAP_WINDOW_MS: Record<CapKind, number> = {
  five_hour: 5 * HOUR,
  seven_day: 7 * 24 * HOUR,
  seven_day_opus: 7 * 24 * HOUR,
};

/** A clear pct drop means a reset; sub-point wobble does not. */
const RESET_EPS = 0.5;

function tokenWeight(m: MessageUsage): number {
  return m.inputTokens + m.outputTokens + m.cacheCreationTokens + m.cacheReadTokens;
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
 * This is the only honest way to keep measured Code activity from claiming usage
 * it didn't cause. It's still an estimate (cache fields reliable; raw I/O
 * undercounts; same-interval Code + chat can't be perfectly separated).
 *
 * @param samples  the tank trajectory (all caps), any order
 * @param messages raw measured Code activity, any order
 */
export function attributeShares(
  samples: UsageSample[],
  messages: MessageUsage[],
  now: number = Date.now()
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
    out.push(...attributeCap(cap, capSamples, msgs, now));
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
  now: number
): UserShare[] {
  // Bound to the current window: start at the last reset (pct drop), and never
  // look back further than the cap's window length.
  const cutoff = now - CAP_WINDOW_MS[cap];
  let start = 0;
  for (let i = 1; i < capSamples.length; i++) {
    if (capSamples[i]!.pct < capSamples[i - 1]!.pct - RESET_EPS)
      start = i; // reset
    else if (capSamples[i]!.t < cutoff) start = i; // too old to matter
  }
  const win = capSamples.slice(start);

  const opusOnly = cap === "seven_day_opus";
  const attributed = new Map<string, number>();
  attributed.set(UNKNOWN_USER, win[0]!.pct); // baseline: pre-daemon usage is unknown

  let mi = 0;
  // skip messages at or before the baseline instant
  while (mi < msgs.length && msgs[mi]!.t <= win[0]!.t) mi++;

  for (let i = 1; i < win.length; i++) {
    const prev = win[i - 1]!;
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

    const delta = cur.pct - prev.pct;
    if (delta <= 0) continue; // reset/dip: nothing to attribute this interval

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
