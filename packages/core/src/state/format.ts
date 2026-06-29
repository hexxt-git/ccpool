import type { CapKind } from "../types.js";

export const CAP_LABEL: Record<CapKind, string> = {
  five_hour: "5h",
  seven_day: "weekly",
  seven_day_opus: "weekly-opus",
};

/** A fixed-width progress bar. Clamps to [0,100]. */
export function bar(pct: number, width = 10): string {
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.round((clamped / 100) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

/** Whole-number percent for display, e.g. `46%`. */
export function pctLabel(pct: number): string {
  return `${Math.round(pct)}%`;
}

/**
 * Human countdown to a reset instant. Coarse on purpose: days+hours far out,
 * hours+minutes within a day. Empty string when there's nothing to show.
 */
export function countdown(resetsAt: string | null, now: number = Date.now()): string {
  if (!resetsAt) return "";
  const ms = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "due";

  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(mins).padStart(2, "0")}m`;
  return `${mins}m`;
}
