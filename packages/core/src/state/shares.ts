import type { CapKind, UsageSample, UserShare } from "../types.js";
import { CAP_KINDS, UNKNOWN_USER } from "../types.js";

export interface RawWeight {
  user: string;
  cap: CapKind;
  weight: number;
}

/**
 * Turn raw measured Code-activity weights into per-user slices of the tank.
 *
 * The token→pct mapping is unstable, so we never derive an absolute percentage
 * from tokens. Instead each user's measured weight gives a *relative* proportion
 * of the window's overall percentage, scaled so the column totals the tank.
 *
 * `unknown` is always present as a normal row: it carries any no-name / between-
 * hand-off activity, and when nothing at all is attributable it holds the whole
 * tank. The split is an estimate of relative Code activity (with the input/output
 * undercount caveat), labelled as such in the UI; chat/Cowork usage the Code
 * surface can't see is not separately sized and is distributed proportionally.
 *
 * Invariant: for each cap, the returned rows sum to the tank percentage.
 */
export function apportionShares(samples: UsageSample[], weights: RawWeight[]): UserShare[] {
  const tankByCap = new Map<CapKind, number>();
  for (const s of samples) tankByCap.set(s.cap, s.pct);

  const out: UserShare[] = [];

  for (const cap of CAP_KINDS) {
    const tank = tankByCap.get(cap) ?? 0;
    const capWeights = weights.filter((w) => w.cap === cap && w.weight > 0);

    const names = new Set<string>(capWeights.map((w) => w.user));
    names.add(UNKNOWN_USER); // always shown

    const total = capWeights.reduce((a, w) => a + w.weight, 0);

    if (total === 0) {
      // nothing attributable -> the whole tank is unknown
      for (const name of names) {
        out.push({ user: name, cap, pct: name === UNKNOWN_USER ? tank : 0 });
      }
      continue;
    }

    const weightOf = (name: string) =>
      capWeights.filter((w) => w.user === name).reduce((a, w) => a + w.weight, 0);

    for (const name of names) {
      out.push({ user: name, cap, pct: tank * (weightOf(name) / total) });
    }
  }

  return out;
}
