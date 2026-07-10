import React from "react";
import { Box, Text } from "ink";
import type { CapKind, HistoryWindowView } from "@ccshare/core";
import { Bar, Cell, Rule, lpad, pct, scrollLabel } from "./designs/parts.js";
import { P } from "./designs/palette.js";
import { CAP_LABEL } from "../lib/history-render.js";

const PERSON = [P.blue, P.green, P.pink, P.coral, P.purple, P.amber, P.cyan];
const colorFor = (name: string, i: number): string =>
  name === "unknown" ? P.faint : PERSON[i % PERSON.length]!;

const WCOL = 12;
const OCOL = 7;
const MCOL = 8;

/** MM-DD HH:MM from an ISO instant. */
const winLabel = (iso: string) => iso.slice(5, 16).replace("T", " ");

/** The stable top-K member ordering (all-time share desc, ties by name). ADR-0005. */
export function rankMembers(windows: HistoryWindowView[]): string[] {
  const totals = new Map<string, number>();
  for (const w of windows) {
    for (const s of w.shares) totals.set(s.user, (totals.get(s.user) ?? 0) + s.pct);
  }
  return [...totals.keys()].sort(
    (a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || a.localeCompare(b)
  );
}

export interface HistoryState {
  capIdx: number;
  windows: HistoryWindowView[] | null; // null = loading
  error: string | null;
  cursor: number;
  expanded: boolean;
  memberOff: number;
}

/**
 * The TUI history screen (ADR-0005): a `window | overall | top-K | +N` matrix with
 * a row cursor, `⏎` to expand the selected window into its full per-member
 * breakdown, and `⇥` cycling the cap. Pure render — the App owns state + keys, so
 * this is snapshot-testable with ink-testing-library.
 */
export function renderHistory(
  cap: CapKind,
  state: HistoryState,
  cols: number,
  rows: number
): React.ReactElement {
  const title = (
    <Box>
      <Text color={P.orange} bold>
        history
      </Text>
      <Text color={P.dim}> · {CAP_LABEL[cap]} </Text>
      <Text color={P.faint}>(⇥ cap · ⏎ expand · h live)</Text>
    </Box>
  );

  if (state.error) {
    return frame(title, <Text color={P.red}>could not load history: {state.error}</Text>);
  }
  if (state.windows === null) {
    return frame(title, <Text color={P.dim}>loading…</Text>);
  }
  if (state.windows.length === 0) {
    return frame(title, <Text color={P.dim}>no {CAP_LABEL[cap]} history yet</Text>);
  }

  if (state.expanded) return expandedView(title, cap, state, cols, rows);

  // ── the matrix ────────────────────────────────────────────────────────────
  const ranked = rankMembers(state.windows);
  const avail = cols - WCOL - OCOL - 2;
  const fit = Math.max(1, Math.floor(avail / (MCOL + 1)));
  let members = ranked;
  let extra = 0;
  if (ranked.length > fit) {
    members = ranked.slice(0, Math.max(1, fit - 1));
    extra = ranked.length - members.length;
  }

  const visible = Math.max(1, rows - 4);
  const cursor = clamp(state.cursor, 0, state.windows.length - 1);
  const off = cursor < visible ? 0 : cursor - visible + 1;
  const shown = state.windows.slice(off, off + visible);

  const header = (
    <Box>
      <Cell w={WCOL}>
        <Text color={P.orange} bold>
          window
        </Text>
      </Cell>
      <Cell w={OCOL} align="right">
        <Text color={P.orange} bold>
          overall
        </Text>
      </Cell>
      {members.map((m, i) => (
        <Cell key={m} w={MCOL} align="right">
          <Text color={colorFor(m, i)} bold>
            {m.slice(0, MCOL)}
          </Text>
        </Cell>
      ))}
      {extra ? (
        <Cell w={MCOL} align="right">
          <Text color={P.dim} bold>
            +{extra}
          </Text>
        </Cell>
      ) : null}
    </Box>
  );

  return frame(
    title,
    <>
      {header}
      <Rule
        w={Math.min(cols, WCOL + OCOL + members.length * (MCOL + 1) + (extra ? MCOL + 1 : 0))}
        color={P.faint}
      />
      {shown.map((w, i) => {
        const idx = off + i;
        const sel = idx === cursor;
        const by = new Map(w.shares.map((s) => [s.user, s.pct]));
        return (
          <Box key={w.windowStart}>
            <Cell w={WCOL}>
              <Text color={sel ? P.green : P.cream} bold={sel}>
                {sel ? "▸" : " "}
                {winLabel(w.windowStart)}
              </Text>
            </Cell>
            <Cell w={OCOL} align="right">
              <Text color={P.cream}>{pct(w.overall)}</Text>
            </Cell>
            {members.map((m, mi) => (
              <Cell key={m} w={MCOL} align="right">
                <Text color={by.has(m) ? colorFor(m, mi) : P.ghost}>
                  {by.has(m) ? pct(by.get(m)!) : "–"}
                </Text>
              </Cell>
            ))}
            {extra ? (
              <Cell w={MCOL} align="right">
                <Text color={P.ghost}> </Text>
              </Cell>
            ) : null}
          </Box>
        );
      })}
      <Box>
        <Text color={P.dim}>{scrollLabel(off, visible, state.windows.length)}</Text>
      </Box>
    </>
  );
}

/** One window's full per-member breakdown, sorted by share desc, scrollable. */
function expandedView(
  title: React.ReactElement,
  cap: CapKind,
  state: HistoryState,
  cols: number,
  rows: number
): React.ReactElement {
  const w = state.windows![clamp(state.cursor, 0, state.windows!.length - 1)]!;
  const shares = [...w.shares].sort((a, b) => b.pct - a.pct);
  const visible = Math.max(1, rows - 4);
  const off = clamp(state.memberOff, 0, Math.max(0, shares.length - visible));
  const shown = shares.slice(off, off + visible);
  const barW = Math.max(8, cols - 24);

  return frame(
    title,
    <>
      <Box>
        <Text color={P.cream} bold>
          {winLabel(w.windowStart)} → {w.windowEnd.slice(11, 16)}
        </Text>
        <Text color={P.dim}> · overall </Text>
        <Text color={P.orange} bold>
          {pct(w.overall)}
        </Text>
        <Text color={P.faint}> (esc back)</Text>
      </Box>
      <Rule w={Math.min(cols, barW + 24)} color={P.faint} />
      {shown.map((s, i) => (
        <Box key={s.user}>
          <Cell w={14}>
            <Text color={colorFor(s.user, off + i)}>{s.user.slice(0, 14)}</Text>
          </Cell>
          <Text>
            <Bar pct={s.pct} width={barW} color={colorFor(s.user, off + i)} /> {lpad(pct(s.pct), 4)}
          </Text>
        </Box>
      ))}
    </>
  );
}

function frame(title: React.ReactElement, body: React.ReactNode): React.ReactElement {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box height={1} />
      {title}
      <Box height={1} />
      {body}
      <Box flexGrow={1} />
    </Box>
  );
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
