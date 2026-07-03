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
  sourceLabel: string; // "shared db" | "local state" | "live poll" | "no data"
  sync: string; // "12s ago" | "never"
  daemonRunning: boolean;
  members: DesignMember[]; // sorted by first cap desc, unknown last
  active: number; // count of active members
  caps: DesignCap[]; // present caps only, in CAP_KINDS order
  notes: string[]; // warnings (token expired, daemon down, stale, live)
  /** DB unreachable but the tank is still cached — members are placeholder
   * `xxxx` rows (a random split of each cached window) and designs show a
   * "can't reach the database" line. */
  disconnected: boolean;
}

/** Display name for the placeholder rows shown while the DB is unreachable. */
export const DISCONNECTED_USER = "xxxx";
/** How many placeholder rows to split the cached tank across. */
const DISCONNECTED_ROWS = 4;

const SOURCE_LABEL: Record<ViewOrigin, string> = {
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

  let members: DesignMember[] = [...names].map((name) => {
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

  // sort by the first present cap's share desc; unknown always last
  const sortCap = caps[0]?.kind;
  members.sort((a, b) => {
    if (a.name === UNKNOWN_USER) return 1;
    if (b.name === UNKNOWN_USER) return -1;
    if (!sortCap) return a.name.localeCompare(b.name);
    return (b.byCap[sortCap] ?? 0) - (a.byCap[sortCap] ?? 0);
  });

  // DB unreachable but the tank is still cached (offline): we can't know the real
  // per-person split, so show a placeholder — `DISCONNECTED_ROWS` rows with
  // random-looking shares that add up to each cached window — rather than an empty
  // list. The split is seeded from the cap value so it stays put across the TUI's
  // frequent re-renders (only changing if the cached tank changes).
  const disconnected = vm.stale && caps.length > 0;
  if (disconnected) {
    const splits = new Map<CapKind, number[]>(
      caps.map((c) => [c.kind, splitTotal(c.pct, DISCONNECTED_ROWS, seedFor(c.kind, c.pct))])
    );
    members = Array.from({ length: DISCONNECTED_ROWS }, (_, i) => ({
      name: DISCONNECTED_USER,
      isMe: false,
      byCap: Object.fromEntries(caps.map((c) => [c.kind, splits.get(c.kind)![i]!])) as Partial<
        Record<CapKind, number>
      >,
      tokens: 0,
      active: false,
    }));
    // order by the first cap's share desc, like the real member table
    const first = caps[0]?.kind;
    if (first) members.sort((a, b) => (b.byCap[first] ?? 0) - (a.byCap[first] ?? 0));
  }

  const notes: string[] = [];
  // Loudest first: a mismatched account means the ledger is NOT recording this
  // machine — everything below reflects only the local poll, not the shared group.
  if (vm.accountConflict)
    notes.push(
      "account mismatch — this machine's Claude account differs from the shared DB's; not recording to the ledger"
    );
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
    disconnected,
  };
}

/** Seed a split deterministically from the cap and its cached value, so the same
 * offline tank always produces the same placeholder shares (no per-render jitter). */
function seedFor(kind: string, pct: number): number {
  let h = Math.round(pct * 10) >>> 0;
  for (let i = 0; i < kind.length; i++) h = (Math.imul(h, 31) + kind.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/** Small seeded PRNG (mulberry32) — deterministic given the seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Split `total` into `n` non-negative integers that sum to round(total), with
 * random-looking (but seed-stable) weights. */
function splitTotal(total: number, n: number, seed: number): number[] {
  const target = Math.round(total);
  if (target <= 0) return Array<number>(n).fill(0);
  const rnd = mulberry32(seed);
  const weights = Array.from({ length: n }, () => rnd() + 0.15); // +bias so none is ~0
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (w / sum) * target);
  const out = raw.map((v) => Math.floor(v));
  let rem = target - out.reduce((a, b) => a + b, 0);
  // hand the rounding remainder to the largest fractional parts
  const order = raw.map((v, i) => ({ i, f: v - Math.floor(v) })).sort((a, b) => b.f - a.f);
  for (let k = 0; rem > 0 && k < n; k++, rem--) out[order[k]!.i]!++;
  return out;
}

// re-export so consumers can keep CAP types handy without reaching into core
export { CAP_KINDS };
export type { CapKind };
