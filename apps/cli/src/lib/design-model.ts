import { CAP_KINDS, countdown, UNKNOWN_USER, type CapKind } from "@ccshare/core";
import type { ViewModel, ViewOrigin } from "./view.js";
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
  source: ViewOrigin;
  sync: string; // "12s ago" | "never"
  daemonRunning: boolean;
  members: DesignMember[]; // sorted by first cap desc, unknown last
  active: number; // count of active members
  caps: DesignCap[]; // present caps only, in CAP_KINDS order
  notes: string[]; // warnings (token expired, daemon down, live)
  /** Whether the server rejected our bearer — we're logged out (§view). */
  loggedOut: boolean;
  /** The single prominent red line to show, or null. Never fabricated data. */
  alert: string | null;
}

export function toDesignModel(vm: ViewModel, me: string, now: number = Date.now()): DesignModel {
  const byCapSample = new Map(vm.samples.map((s) => [s.cap, s]));
  const caps: DesignCap[] = [];

  // Only caps we actually have a sample for — never invent tank values.
  for (const cap of CAP_KINDS) {
    const s = byCapSample.get(cap);
    if (s) {
      caps.push({
        kind: cap,
        label: LONG[cap],
        short: SHORT[cap],
        pct: s.pct,
        resets: countdown(s.resetsAt, now),
      });
    }
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
      // "active" = currently holding any of the 5h window; unknown is never active
      active: name !== UNKNOWN_USER && (byCap.five_hour ?? 0) > 0,
    };
  });

  // `unknown` is always a row while a tank is showing — it holds the unattributed
  // remainder of the tank. Attribution emits it for every cap that has samples, but
  // a freshly initialized ledger has none yet, so synthesize it (holding whatever
  // isn't credited to a real member) rather than showing an empty table under a
  // live tank.
  if (caps.length > 0 && !members.some((m) => m.name === UNKNOWN_USER)) {
    const byCap: Partial<Record<CapKind, number>> = {};
    for (const c of caps) {
      const others = members.reduce((sum, m) => sum + (m.byCap[c.kind] ?? 0), 0);
      byCap[c.kind] = Math.max(0, c.pct - others);
    }
    members.push({ name: UNKNOWN_USER, isMe: false, byCap, tokens: 0, active: false });
  }

  // sort by the first present cap's share desc; unknown always last
  const sortCap = caps[0]?.kind;
  members.sort((a, b) => {
    if (a.name === UNKNOWN_USER) return 1;
    if (b.name === UNKNOWN_USER) return -1;
    if (!sortCap) return a.name.localeCompare(b.name);
    return (b.byCap[sortCap] ?? 0) - (a.byCap[sortCap] ?? 0);
  });

  // The one prominent red line. Logged out (bad/revoked bearer) is NOT the same as
  // unreachable — say so, and point at the fix. When we can't get the shared data we
  // show what's real (the local tank, if any) and an empty member list — never a
  // fabricated split.
  const alert = vm.loggedOut
    ? "logged out — run `ccshare init` to sign back in"
    : vm.stale
      ? "can't reach the ccshare server — showing last-known"
      : null;

  const notes: string[] = [];
  // Loudest first: a mismatched account means the ledger is NOT recording this
  // machine — everything below reflects only the local poll, not the shared group.
  if (vm.accountConflict)
    notes.push(
      "account mismatch — this machine's Claude account differs from the shared DB's; not recording to the ledger"
    );
  if (vm.tokenExpired) notes.push("waiting for Claude Code to refresh auth");
  if (!vm.daemonRunning) notes.push("daemon not running — run `ccshare daemon start`");
  if (vm.source === "live") notes.push("live poll — start the daemon to record history");

  return {
    me,
    account: vm.account ?? "—",
    source: vm.source,
    sync: vm.source === "live" ? "live" : formatAge(vm.syncedAt, now),
    daemonRunning: vm.daemonRunning,
    members,
    active: members.filter((m) => m.active).length,
    caps,
    notes,
    loggedOut: vm.loggedOut,
    alert,
  };
}

// re-export so consumers can keep CAP types handy without reaching into core
export { CAP_KINDS };
export type { CapKind };
