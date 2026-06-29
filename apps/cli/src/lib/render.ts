import { CAP_KINDS, CAP_LABEL, bar, countdown, pctLabel, type UsageSample } from "@ccshare/core";
import type { ViewModel } from "./view.js";

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

/** Coarse "Ns/Nm/Nh ago" for the freshness footer. */
export function formatAge(updatedAt: string | null, now: number = Date.now()): string {
  if (!updatedAt) return "never";
  const sec = Math.max(0, Math.round((now - Date.parse(updatedAt)) / 1000));
  if (sec < 90) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min}m ago`;
  return `${Math.round(min / 60)}h ago`;
}

/**
 * The full view shared by `status` and `tui`: the tank header plus edge-state
 * notes (per-user rows are added in Phase 5). One renderer, two surfaces.
 */
export function renderView(vm: ViewModel, now: number = Date.now()): string[] {
  const lines = renderTank(vm.samples, now);

  const notes: string[] = [];
  if (vm.tokenExpired) notes.push("waiting for Claude Code to refresh auth");
  if (!vm.daemonRunning) notes.push("daemon not running — run `ccshare daemon start`");
  if (vm.stale) notes.push("database unreachable — showing last-known");
  if (vm.source === "live") notes.push("live poll — start the daemon to record history");

  lines.push("");
  const freshness =
    vm.source === "db"
      ? `source: shared db · local state ${formatAge(vm.updatedAt, now)}`
      : vm.source === "state"
        ? `source: local state · ${formatAge(vm.updatedAt, now)}`
        : vm.source === "live"
          ? "source: live poll"
          : "no data yet";
  lines.push(freshness);
  for (const n of notes) lines.push(`  · ${n}`);

  return lines;
}
