import type { CapKind, ResetEvent, UsageSample } from "../types.js";

/** Ignore sub-point float wobble; a real reset is a clear drop. */
const DEFAULT_EPSILON = 0.5;

/**
 * Detect resets by comparing the latest reading to the previous one: a cap whose
 * `pct` dropped is a reset (covers Anthropic's out-of-band mid-week flushes). We
 * never infer a reset from `resetsAt` elapsing — that field lies (see "Reset detection").
 *
 * Known tradeoff: a downward *re-computation* of utilization by more than `epsilon`
 * (not an actual reset) would also register here, truncating the attribution window
 * a cycle early. `epsilon` only filters sub-point wobble; genuine large corrections
 * are rare, and pct-drop remains far more reliable than the `resetsAt` clock.
 */
export function detectResets(
  prev: UsageSample[],
  next: UsageSample[],
  at: string = new Date().toISOString(),
  epsilon: number = DEFAULT_EPSILON
): ResetEvent[] {
  const prevByCap = new Map<CapKind, number>(prev.map((s) => [s.cap, s.pct]));
  const events: ResetEvent[] = [];
  for (const s of next) {
    const before = prevByCap.get(s.cap);
    if (before !== undefined && s.pct < before - epsilon) {
      events.push({ cap: s.cap, at, previousPct: before });
    }
  }
  return events;
}
