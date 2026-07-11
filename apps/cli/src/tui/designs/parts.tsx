import React from "react";
import { Box, Text } from "ink";
import type { CapKind, DesignMember, DesignModel } from "../../lib/design-model.js";
import { M, P, heat } from "./palette.js";

export const rep = (s: string, n: number): string => s.repeat(Math.max(0, n));
export const pad = (s: string, w: number): string =>
  s.length >= w ? s : s + rep(" ", w - s.length);
export const lpad = (s: string, w: number): string =>
  s.length >= w ? s : rep(" ", w - s.length) + s;
export const tok = (n: number): string =>
  n === 0 ? "—" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : Math.round(n / 1e3) + "k";
export const pct = (n: number): string => n.toFixed(0) + "%";
/** Share of a cap as text, or "—" when the member has no row for it. */
export const share = (m: DesignMember, c: CapKind): string => {
  const v = m.byCap[c];
  return v === undefined ? "—" : pct(v);
};
export const scrollLabel = (off: number, visible: number, total: number): string =>
  `${off > 0 ? "▲" : " "} ${off + 1}–${Math.min(total, off + visible)} of ${total} ${
    off + visible < total ? "▼" : " "
  }`;

export const CLAWD = [" ▐▛███▜▌", "▝▜█████▛▘", "  ▘▘ ▝▝"];

export function Bar({
  pct: p,
  width,
  color,
  fill = "█",
  empty = "░",
  track = P.ghost,
}: {
  pct: number;
  width: number;
  color?: string;
  fill?: string;
  empty?: string;
  track?: string;
}): React.ReactElement {
  const w = Math.max(1, width);
  const f = Math.round((Math.min(100, Math.max(0, p)) / 100) * w);
  return (
    <Text>
      <Text color={color ?? heat(p)}>{rep(fill, f)}</Text>
      <Text color={track}>{rep(empty, w - f)}</Text>
    </Text>
  );
}

export function Cell({
  w,
  align = "left",
  children,
}: {
  w: number;
  align?: "left" | "right" | "center";
  children: React.ReactNode;
}): React.ReactElement {
  const jc = align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start";
  return (
    <Box width={w} flexShrink={0} justifyContent={jc}>
      {children}
    </Box>
  );
}

export const Clawd = ({ color }: { color: string }): React.ReactElement => (
  <Box flexDirection="column">
    {CLAWD.map((l, i) => (
      <Text key={i} color={color}>
        {l}
      </Text>
    ))}
  </Box>
);

export const Rule = ({
  w,
  color = P.ghost,
  ch = "─",
}: {
  w: number;
  color?: string;
  ch?: string;
}): React.ReactElement => <Text color={color}>{rep(ch, w)}</Text>;

export const StatusDot = ({
  active,
  flip,
}: {
  active: boolean;
  flip?: boolean;
}): React.ReactElement =>
  active ? (
    <Text>
      {flip && <Text color={P.dim}>active </Text>}
      <Text color={P.green}>●</Text>
      {!flip && <Text color={P.dim}> active</Text>}
    </Text>
  ) : (
    <Text color={P.faint}>{flip ? "idle ○" : "○ idle"}</Text>
  );

export function MiniCap({
  label,
  pct: p,
  w,
  color,
}: {
  label: string;
  pct: number;
  w: number;
  color: string;
}): React.ReactElement {
  return (
    <Text>
      <Text color={P.dim}>{pad(label, 2)} </Text>
      <Bar pct={p} width={w} color={color} />
      <Text color={P.cream}> {lpad(pct(p), 4)}</Text>
    </Text>
  );
}

export function VMeter({
  pct: p,
  h,
  w,
  label,
  resets,
}: {
  pct: number;
  h: number;
  w: number;
  label: string;
  resets: string;
}): React.ReactElement {
  const filled = Math.round((p / 100) * h);
  return (
    <Box flexDirection="column" alignItems="center" marginX={1}>
      <Text color={heat(p)} bold>
        {Math.round(p)}%
      </Text>
      <Box flexDirection="column" borderStyle="round" borderColor={P.faint}>
        {Array.from({ length: h }, (_, i) => (
          <Text key={i} color={i >= h - filled ? heat(p) : P.ghost}>
            {rep(i >= h - filled ? "█" : "░", w)}
          </Text>
        ))}
      </Box>
      <Text color={P.cream}>{label}</Text>
      <Text color={P.dim}>{resets}</Text>
    </Box>
  );
}

/** Title-in-the-border panel (top/bottom by hand, left/right by Ink). */
export function Panel({
  title,
  color,
  width,
  height,
  right,
  children,
}: {
  title: string;
  color: string;
  width: number;
  height: number;
  right?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const head = "╭─ " + title + " ";
  const tail = right ? " " + right + " ─╮" : "─╮";
  const fill = rep("─", Math.max(0, width - head.length - tail.length));
  return (
    <Box flexDirection="column" width={width} height={height} flexShrink={0}>
      <Text color={color}>
        {"╭─ "}
        <Text bold>{title}</Text> {fill}
        {right ? (
          <Text>
            {" "}
            <Text color={P.dim}>{right}</Text>
            {" ─╮"}
          </Text>
        ) : (
          "─╮"
        )}
      </Text>
      <Box
        flexGrow={1}
        flexDirection="column"
        borderStyle="round"
        borderColor={color}
        borderTop={false}
        borderBottom={false}
        paddingX={1}
      >
        {children}
      </Box>
      <Text color={color}>{"╰" + rep("─", Math.max(0, width - 2)) + "╯"}</Text>
    </Box>
  );
}

/** Dotted leader; with `pct` the leading dots brighten as a gauge. */
export function Leader({
  left,
  right,
  width,
  pct: p,
  lc = M.hi,
  rc = M.mid,
}: {
  left: string;
  right: string;
  width: number;
  pct?: number;
  lc?: string;
  rc?: string;
}): React.ReactElement {
  const total = Math.max(1, width - left.length - right.length - 2);
  const filled = p === undefined ? 0 : Math.round((Math.min(100, Math.max(0, p)) / 100) * total);
  return (
    <Text>
      <Text color={lc}>{left}</Text> <Text color={M.hi}>{rep("=", filled)}</Text>
      <Text color={M.track}>{rep("-", total - filled)}</Text> <Text color={rc}>{right}</Text>
    </Text>
  );
}

/** Shared identity header (clawd + account/you/members/source/sync/daemon). */
export function Header({
  model,
  color,
  pal,
}: {
  model: DesignModel;
  color: string;
  pal: { label: string; value: string; accent: string };
}): React.ReactElement {
  const chip = (sep: boolean, body: React.ReactNode): React.ReactElement => (
    <Box flexShrink={0} marginRight={1}>
      <Text color={pal.label}>
        {sep ? "· " : ""}
        {body}
      </Text>
    </Box>
  );
  return (
    <Box>
      <Box flexShrink={0}>
        <Clawd color={color} />
      </Box>
      <Box flexDirection="column" marginLeft={3} flexShrink={1} flexGrow={1}>
        <Text color={color} bold>
          ccpool
        </Text>
        <Box flexWrap="wrap">
          {chip(
            false,
            <>
              you are{" "}
              <Text color={pal.value} bold>
                {model.me}
              </Text>
            </>
          )}
          {chip(
            true,
            <>
              {model.members.length} members ({model.active} active)
            </>
          )}
        </Box>
        <Box flexWrap="wrap">
          {chip(
            false,
            <>
              account <Text color={pal.value}>{model.account}</Text>
            </>
          )}
          {chip(
            true,
            <>
              synced <Text color={pal.value}>{model.sync}</Text>
            </>
          )}
          {/* Only surfaced when down — the TUI is bringing it back up (§App). */}
          {!model.daemonRunning &&
            chip(
              true,
              <>
                daemon{" "}
                <Text color={P.red} bold>
                  down
                </Text>
              </>
            )}
        </Box>
      </Box>
    </Box>
  );
}
