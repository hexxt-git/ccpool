import type { CapKind, HistoryPage } from "@ccshare/core";

/** Friendly cap labels, matching the TUI. */
export const CAP_LABEL: Record<CapKind, string> = {
  five_hour: "5h",
  seven_day: "weekly",
  seven_day_opus: "opus",
};

/**
 * `ccshare history` as plain string lines: a `window | overall | <members>` matrix,
 * newest first. Member columns are the top-K by total share across the page (stable
 * ordering, ADR-0005); the rest collapse into a `+N` column. Plain text so it stays
 * clean piped or redirected. A member with no cell in a window shows `-`.
 */
export function renderHistoryLines(
  page: HistoryPage,
  opts: { cap: CapKind; width?: number }
): string[] {
  const width = opts.width ?? 80;
  if (page.windows.length === 0) return [`no ${CAP_LABEL[opts.cap]} history yet`];

  // Rank members by total share across the page (desc), ties by name.
  const totals = new Map<string, number>();
  for (const w of page.windows) {
    for (const s of w.shares) totals.set(s.user, (totals.get(s.user) ?? 0) + s.pct);
  }
  const ranked = [...totals.keys()].sort(
    (a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || a.localeCompare(b)
  );

  const WCOL = 12;
  const OCOL = 7;
  const MCOL = 8;
  const avail = width - WCOL - OCOL - 2;
  const fit = Math.max(1, Math.floor(avail / (MCOL + 1)));
  let cols = ranked;
  let extra = 0;
  if (ranked.length > fit) {
    cols = ranked.slice(0, Math.max(1, fit - 1));
    extra = ranked.length - cols.length;
  }

  const lpad = (s: string, w: number) =>
    s.length >= w ? s.slice(0, w) : " ".repeat(w - s.length) + s;
  const rpad = (s: string, w: number) =>
    s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
  const winLabel = (iso: string) => iso.slice(5, 16).replace("T", " "); // MM-DD HH:MM
  const p = (n: number) => `${Math.round(n)}%`;

  const head = [
    rpad("window", WCOL),
    lpad("overall", OCOL),
    ...cols.map((c) => lpad(c, MCOL)),
    ...(extra ? [lpad(`+${extra}`, MCOL)] : []),
  ].join(" ");
  const lines = [head, "-".repeat(head.length)];
  for (const w of page.windows) {
    const by = new Map(w.shares.map((s) => [s.user, s.pct]));
    const cells = cols.map((c) => lpad(by.has(c) ? p(by.get(c)!) : "-", MCOL));
    lines.push(
      [
        rpad(winLabel(w.windowStart), WCOL),
        lpad(p(w.overall), OCOL),
        ...cells,
        ...(extra ? [lpad("", MCOL)] : []),
      ].join(" ")
    );
  }
  return lines;
}
