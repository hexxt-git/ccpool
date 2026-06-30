import { CAP_KINDS, countdown, UNKNOWN_USER, type CapKind } from "@ccshare/core";
import type { ViewModel, ViewSource } from "./view.js";
import { formatAge } from "./render.js";

/**
 * The single presentation model the `status` renderer and every TUI design read
 * from. It flattens the ViewModel (samples + shares + member rollups) into caps
 * and members, so neither layer re-derives joins or sort order.
 */

const SHORT: Record<CapKind, string> = {
  five_hour: "5h",
  seven_day: "wk",
  seven_day_opus: "opus",
};
/** Display label: like CAP_LABEL but "opus" reads better than "weekly-opus". */
const LONG: Record<CapKind, string> = {
  five_hour: "5h",
  seven_day: "weekly",
  seven_day_opus: "opus",
};

export interface DesignCap {
  kind: CapKind;
  label: string; // "5h" | "weekly" | "opus"
  short: string; // "5h" | "wk" | "opus"
  pct: number;
  resets: string; // "2h 41m" | "" when unknown
}

export interface DesignMember {
  name: string;
  isMe: boolean;
  /** Share of each present cap, 0..100. Missing cap => undefined (render "—"). */
  byCap: Partial<Record<CapKind, number>>;
  tokens: number;
  active: boolean;
}

export interface DesignModel {
  me: string;
  account: string; // email/id, or "—"
  source: ViewSource;
  sourceLabel: string; // "shared db" | "local state" | "live poll" | "no data"
  sync: string; // "12s ago" | "never"
  daemonRunning: boolean;
  members: DesignMember[]; // sorted by first cap desc, unknown last
  active: number; // count of active members
  caps: DesignCap[]; // present caps only, in CAP_KINDS order
  notes: string[]; // warnings (token expired, daemon down, stale, live)
}

const SOURCE_LABEL: Record<ViewSource, string> = {
  db: "shared db",
  state: "local state",
  live: "live poll",
  none: "no data",
};

export function toDesignModel(vm: ViewModel, me: string, now: number = Date.now()): DesignModel {
  const byCapSample = new Map(vm.samples.map((s) => [s.cap, s]));
  const caps: DesignCap[] = [];
  for (const cap of CAP_KINDS) {
    const s = byCapSample.get(cap);
    if (!s) continue;
    caps.push({
      kind: cap,
      label: LONG[cap],
      short: SHORT[cap],
      pct: s.pct,
      resets: countdown(s.resetsAt, now),
    });
  }

  // gather every name that appears in shares (authoritative; sums to the tank)
  const names = new Set<string>(vm.shares.map((sh) => sh.user));
  const shareOf = new Map<string, number>(); // `user:cap` -> pct
  for (const sh of vm.shares) shareOf.set(`${sh.user}:${sh.cap}`, sh.pct);
  const statByName = new Map(vm.members.map((m) => [m.user, m]));

  const members: DesignMember[] = [...names].map((name) => {
    const byCap: Partial<Record<CapKind, number>> = {};
    for (const c of caps) {
      const v = shareOf.get(`${name}:${c.kind}`);
      if (v !== undefined) byCap[c.kind] = v;
    }
    const stat = statByName.get(name);
    return {
      name,
      isMe: name === me,
      byCap,
      tokens: stat?.tokens ?? 0,
      // "active" = currently holding any of the 5h window
      active: (byCap.five_hour ?? 0) > 0,
    };
  });

  // sort by the first present cap's share desc; unknown always last
  const sortCap = caps[0]?.kind;
  members.sort((a, b) => {
    if (a.name === UNKNOWN_USER) return 1;
    if (b.name === UNKNOWN_USER) return -1;
    if (!sortCap) return a.name.localeCompare(b.name);
    return (b.byCap[sortCap] ?? 0) - (a.byCap[sortCap] ?? 0);
  });

  const notes: string[] = [];
  if (vm.tokenExpired) notes.push("waiting for Claude Code to refresh auth");
  if (!vm.daemonRunning) notes.push("daemon not running — run `ccshare daemon start`");
  if (vm.stale) notes.push("database unreachable — showing last-known");
  if (vm.source === "live") notes.push("live poll — start the daemon to record history");

  return {
    me,
    account: vm.account ?? "—",
    source: vm.source,
    sourceLabel: SOURCE_LABEL[vm.source],
    sync: vm.source === "live" ? "live" : formatAge(vm.updatedAt, now),
    daemonRunning: vm.daemonRunning,
    members,
    active: members.filter((m) => m.active).length,
    caps,
    notes,
  };
}

// re-export so consumers can keep CAP types handy without reaching into core
export { CAP_KINDS };
export type { CapKind };
