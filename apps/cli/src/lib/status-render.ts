import { pctLabel } from "@ccpool/core";
import type { DesignCap, DesignMember, DesignModel } from "./design-model.js";
import { GITHUB_URL, SITE_URL, link } from "./links.js";
import { heat } from "./heat.js";

/**
 * `status` as plain string lines. Color is a wrapping layer (`paint`) that is a
 * no-op when off, so the colored terminal output and the piped/redirected
 * plaintext share ONE layout — no Ink width-guessing, no escape codes in a pipe.
 * Targets a 70-col terminal and degrades on narrower widths (drops the per-member
 * bar, then trailing cap columns) rather than wrapping.
 */

// palette (only emitted when color is on)
const HEX = {
  cream: "#f0e8c8",
  dim: "#8c8c96",
  faint: "#56565e",
  ghost: "#34343a",
  orange: "#e8632a",
  green: "#5a8f4a",
  red: "#d4604a",
  amber: "#d4a030",
  blue: "#7fa5d8",
  pink: "#ff5fa2",
  coral: "#ff8c75",
  purple: "#a884d0",
  cyan: "#6db3c0",
} as const;
const PERSON = [HEX.blue, HEX.green, HEX.pink, HEX.coral, HEX.purple, HEX.amber, HEX.cyan];

export type Paint = (s: string, hex: string, bold?: boolean) => string;
function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function makePaint(enabled: boolean): Paint {
  if (!enabled) return (s) => s;
  return (s, hex, bold = false) => {
    const [r, g, b] = rgb(hex);
    return `${bold ? "\x1b[1m" : ""}\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
  };
}

const rep = (s: string, n: number) => s.repeat(Math.max(0, n));
const padEnd = (s: string, w: number) => (s.length >= w ? s : s + rep(" ", w - s.length));
const padStart = (s: string, w: number) => (s.length >= w ? s : rep(" ", w - s.length) + s);

function bar(p: number, w: number, paint: Paint, color?: string): string {
  const f = Math.round((Math.min(100, Math.max(0, p)) / 100) * w);
  return paint(rep("█", f), color ?? heat(p)) + paint(rep("░", w - f), HEX.ghost);
}
const personColor = (m: DesignMember, i: number) =>
  m.name === "unknown" ? HEX.faint : PERSON[i % PERSON.length]!;

function header(m: DesignModel, width: number, paint: Paint): string[] {
  const CLAWD = [" ▐▛███▜▌", "▝▜█████▛▘", "  ▘▘ ▝▝"];
  const lines = [
    paint("ccpool", HEX.orange, true) +
      paint(" · status", HEX.dim) +
      paint("  ·  you are ", HEX.dim) +
      paint(m.me, HEX.cream, true),
    paint("account ", HEX.dim) +
      paint(m.account, HEX.cream) +
      paint(`  ·  ${m.members.length} members (${m.active} active)`, HEX.dim),
    paint(`synced ${m.sync}`, HEX.dim) +
      (m.daemonRunning ? "" : paint("  ·  daemon ", HEX.dim) + paint("down", HEX.red, true)),
  ];
  if (width >= 56)
    return CLAWD.map((art, i) => paint(padEnd(art, 9), HEX.orange) + "  " + (lines[i] ?? ""));
  return lines;
}

function overall(m: DesignModel, width: number, paint: Paint): string[] {
  const out = [paint("overall", HEX.dim, true)];
  for (const cap of m.caps) {
    const prefix = "  " + padEnd(cap.label, 8);
    const resets = cap.resets ? `  · resets ${cap.resets}` : "";
    const plainTailLen = 2 + 4 + resets.length;
    const barW = Math.max(6, width - prefix.length - plainTailLen);
    out.push(
      prefix +
        bar(cap.pct, barW, paint) +
        "  " +
        paint(padStart(pctLabel(cap.pct), 4), heat(cap.pct), true) +
        paint(resets, HEX.dim)
    );
  }
  return out;
}

/** Which cap columns fit, and how wide the optional 5h bar can be. */
function memberLayout(m: DesignModel, width: number, nameW: number) {
  const lead = 2 + 2 + 1 + nameW; // indent + rank(2) + sp + name
  const stateW = 8; // "  active"
  const colW = 5; // " 100%"
  let cols: DesignCap[] = [...m.caps];
  while (cols.length > 1 && lead + cols.length * colW + stateW > width) cols.pop();
  const barW = width - lead - cols.length * colW - stateW - 1;
  return { cols, barW: barW >= 8 ? barW : 0, lead };
}

function members(m: DesignModel, width: number, paint: Paint): string[] {
  if (m.members.length === 0) return [];
  const nameW = Math.max(6, ...m.members.map((u) => u.name.length)) + 2; // +2 for " ◂"
  const { cols, barW } = memberLayout(m, width, nameW);
  const primary = m.caps[0]?.kind;

  const head =
    "  " +
    padStart("#", 2) +
    " " +
    padEnd("member", nameW) +
    (barW ? padEnd(" usage", barW + 1) : "") +
    cols.map((c) => padStart(c.short, 5)).join("") +
    "  state";
  const out = [paint("members", HEX.dim, true), paint(head, HEX.faint)];

  m.members.forEach((u, i) => {
    const cell = (c: DesignCap) => {
      const v = u.byCap[c.kind];
      return " " + padStart(v === undefined ? "—" : pctLabel(v), 4);
    };
    const h5 = primary ? (u.byCap[primary] ?? 0) : 0;
    out.push(
      "  " +
        paint(padStart(String(i + 1), 2), HEX.faint) +
        " " +
        paint(padEnd(u.name + (u.isMe ? " ◂" : ""), nameW), personColor(u, i)) +
        (barW ? " " + bar(h5, barW, paint, personColor(u, i)) : "") +
        cols
          .map((c) =>
            c.kind === primary
              ? " " + paint(padStart(pctLabel(u.byCap[c.kind] ?? 0), 4), HEX.cream)
              : paint(cell(c), HEX.dim)
          )
          .join("") +
        "  " +
        (u.active ? paint("active", HEX.green) : paint("idle", HEX.faint))
    );
  });
  return out;
}

/** The full `status` snapshot as lines, color optional. */
export function renderStatusLines(
  model: DesignModel,
  opts: { width?: number; color?: boolean } = {}
): string[] {
  const width = Math.max(40, opts.width ?? 70);
  const paint = makePaint(opts.color ?? false);
  const lines = [...header(model, width, paint)];
  if (model.alert) lines.push("", paint(model.alert, HEX.red, true));
  if (model.caps.length === 0) {
    // No tank reading yet. Only tell the user to start the daemon when it really
    // isn't running — if it is up (just waiting on its first poll, e.g. while
    // rate-limited), saying "start the daemon" is wrong and misleading.
    const empty = model.daemonRunning
      ? "no reading yet — waiting for the first usage poll…"
      : "no data yet — start the daemon with `ccpool daemon start`";
    lines.push("", paint(empty, HEX.dim));
  } else {
    lines.push("", ...overall(model, width, paint), "", ...members(model, width, paint));
  }
  if (model.notes.length > 0) {
    lines.push("");
    for (const n of model.notes) lines.push(paint(`  · ${n}`, HEX.dim));
  }
  const color = opts.color ?? false;
  const gh = paint(link("github.com/hexxt-git/ccpool", GITHUB_URL, color), HEX.blue);
  const site = paint(link("ccpool.hexxt.dev", SITE_URL, color), HEX.blue);
  lines.push("", `  ${gh}${paint("  ·  ", HEX.faint)}${site}`);
  return lines;
}
