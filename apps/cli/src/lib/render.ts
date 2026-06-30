import {
  CAP_KINDS,
  CAP_LABEL,
  UNKNOWN_USER,
  bar,
  countdown,
  pctLabel,
  type Budget,
  type CapKind,
  type UsageSample,
  type UserShare,
} from "@ccshare/core";
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
    if (!s) continue;
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
 * The per-user table: each participant's slice of the tank for each window. Rows
 * sum to the header percentage per column. `unknown` is always listed (it absorbs
 * unattributed activity). Shares are estimates from relative Code activity (§10).
 */
export function renderUserTable(
  shares: UserShare[],
  samples: UsageSample[],
  budgets: Budget[] = []
): string[] {
  const caps = CAP_KINDS.filter((c) => samples.some((s) => s.cap === c));
  if (caps.length === 0 || shares.length === 0) return [];

  const byUserCap = new Map<string, number>();
  const users = new Set<string>();
  for (const sh of shares) {
    users.add(sh.user);
    byUserCap.set(`${sh.user}:${sh.cap}`, sh.pct);
  }
  const budgetOf = new Map<string, number>();
  for (const b of budgets) budgetOf.set(`${b.name}:${b.cap}`, b.sharePct);

  const nameWidth = Math.max(4, ...[...users].map((u) => u.length));
  const colWidth = 8;
  const head = (cap: CapKind) => CAP_LABEL[cap].padStart(colWidth);
  const cell = (u: string, c: CapKind) => {
    const pct = byUserCap.get(`${u}:${c}`) ?? 0;
    const budget = budgetOf.get(`${u}:${c}`);
    // ▲ over the agreed share, faint dot when within it
    const mark = budget === undefined ? " " : pct > budget + 0.5 ? "▲" : "·";
    return `${pctLabel(pct).padStart(colWidth - 1)}${mark}`;
  };

  // sort by 5h (or first cap) share desc; unknown always last
  const sortCap = caps[0]!;
  const ordered = [...users].sort((a, b) => {
    if (a === UNKNOWN_USER) return 1;
    if (b === UNKNOWN_USER) return -1;
    return (byUserCap.get(`${b}:${sortCap}`) ?? 0) - (byUserCap.get(`${a}:${sortCap}`) ?? 0);
  });

  const lines: string[] = [];
  lines.push("user".padEnd(nameWidth) + caps.map(head).join(""));
  lines.push("-".repeat(nameWidth) + caps.map(() => " ".repeat(colWidth - 6) + "------").join(""));
  for (const u of ordered) {
    lines.push(u.padEnd(nameWidth) + caps.map((c) => cell(u, c)).join(""));
  }
  if (budgets.length > 0) lines.push("▲ over agreed share · · within budget");
  return lines;
}

/** Tank + user table lines — no freshness footer. Used by the TUI to compose its own bottom bar. */
export function renderContent(vm: ViewModel, now: number = Date.now()): string[] {
  const lines = renderTank(vm.samples, now);
  const userLines = renderUserTable(vm.shares, vm.samples, vm.budgets);
  if (userLines.length > 0) {
    lines.push("");
    lines.push(...userLines);
    lines.push("");
  } else {
    lines.push("");
  }
  return lines;
}

/** Source + warning notes — the footer row. */
export function renderFooter(vm: ViewModel, now: number = Date.now()): string[] {
  const notes: string[] = [];
  if (vm.tokenExpired) notes.push("waiting for Claude Code to refresh auth");
  if (!vm.daemonRunning) notes.push("daemon not running — run `ccshare daemon start`");
  if (vm.stale) notes.push("database unreachable — showing last-known");
  if (vm.source === "live") notes.push("live poll — start the daemon to record history");
  const freshness =
    vm.source === "db"
      ? `source: shared db · local state ${formatAge(vm.updatedAt, now)}`
      : vm.source === "state"
        ? `source: local state · ${formatAge(vm.updatedAt, now)}`
        : vm.source === "live"
          ? "source: live poll"
          : "no data yet";
  return [freshness, ...notes.map((n) => `  · ${n}`)];
}

/** The full view shared by `status` and `tui`: tank, user table, then footer. */
export function renderView(vm: ViewModel, now: number = Date.now()): string[] {
  return [...renderContent(vm, now), ...renderFooter(vm, now)];
}
