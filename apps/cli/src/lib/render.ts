import { CAP_KINDS, CAP_LABEL, bar, countdown, pctLabel, type UsageSample } from "@ccshare/core";

/**
 * The header block shared by `status` and `tui`: one line per cap with a bar,
 * percent, and live reset countdown. A cap with no sample is "not applicable"
 * (e.g. weekly-opus on a plan without it) rather than rendered as 0%.
 */
export function renderTank(samples: UsageSample[], now: number = Date.now()): string[] {
  const byCap = new Map(samples.map((s) => [s.cap, s]));
  const lines: string[] = [];
  for (const cap of CAP_KINDS) {
    const label = CAP_LABEL[cap].padEnd(12);
    const s = byCap.get(cap);
    if (!s) {
      lines.push(`${label}—   not applicable on this plan`);
      continue;
    }
    const cd = countdown(s.resetsAt, now);
    const resets = cd ? `· resets in ${cd}` : "";
    lines.push(`${label}${bar(s.pct)}  ${pctLabel(s.pct).padStart(4)}   ${resets}`);
  }
  return lines;
}
