import React from "react";
import { Box, Text } from "ink";
import { UNKNOWN_NOTE, type DesignMember, type DesignModel } from "../../lib/design-model.js";
import { M, P } from "./palette.js";
import { Leader, lpad, pad, pct, scrollLabel, share, tok } from "./parts.js";

// 3 — MONO: dotted leader lines (monochrome), overall + members
export function monoVisible(_cols: number, rows: number): number {
  // list-header(7) blank(1) overall-hd(1) gauges(3) blank(1) members-hd(1) table-hd(1)
  return Math.max(1, rows - 15);
}

export function mono(
  model: DesignModel,
  cols: number,
  rows: number,
  off: number
): React.ReactElement {
  const w = cols; // fill the drawable width; the app owns the outer padding
  const visible = monoVisible(cols, rows);
  const shown = model.members.slice(off, off + visible);
  const hasOpus = model.caps.some((c) => c.kind === "seven_day_opus");
  const rightW = hasOpus ? 32 : 27;
  const headRight = hasOpus ? "  5h   wk   op    tokens  status" : "  5h   wk    tokens  status";
  const fig = (u: DesignMember) =>
    `${lpad(share(u, "five_hour"), 4)}${lpad(share(u, "seven_day"), 5)}${
      hasOpus ? lpad(share(u, "seven_day_opus"), 5) : ""
    }${lpad(tok(u.tokens), 10)}${lpad(u.active ? "active" : "idle", 8)}`;
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color={M.hi} bold>
          ccpool
        </Text>
        <Text color={M.lo}>
          account <Text color={M.hi}>{model.account}</Text>
        </Text>
        <Text color={M.lo}>
          user <Text color={M.hi}>{model.me}</Text>
        </Text>
        <Text color={M.lo}>
          members <Text color={M.hi}>{model.members.length}</Text> ({model.active} active)
        </Text>
        <Text color={M.lo}>
          synced <Text color={M.hi}>{model.sync}</Text>
        </Text>
        {/* Only surfaced when down — the TUI is bringing it back up (the TUI App component). */}
        {!model.daemonRunning ? (
          <Text color={M.lo}>
            daemon{" "}
            <Text color={P.red} bold>
              down
            </Text>
          </Text>
        ) : null}
      </Box>
      <Text color={M.lo}>overall</Text>
      {model.caps.map((c) => (
        <Leader
          key={c.kind}
          left={pad(c.label, 15)}
          pct={c.pct}
          right={lpad(`${lpad(pct(c.pct), 4)}${c.resets ? `  resets ${c.resets}` : ""}`, 32)}
          width={w}
          lc={M.hi}
        />
      ))}
      <Box height={1} />
      <Box justifyContent="space-between">
        <Text color={M.lo}>members</Text>
        <Text color={M.mid}>{scrollLabel(off, visible, model.members.length)}</Text>
      </Box>
      {model.alert ? <Text color={P.red}>{model.alert}</Text> : null}
      <Text color={M.lo}>
        {pad(" # name", w - rightW)}
        {headRight}
      </Text>
      {shown.map((u, i) => (
        <Leader
          key={off + i}
          left={pad(`${lpad(String(off + i + 1), 2)} ${u.name}${u.isMe ? " ◂" : ""}`, 15)}
          pct={u.byCap.five_hour ?? 0}
          right={fig(u)}
          width={w}
          lc={M.hi}
          rc={M.mid}
        />
      ))}
      {model.unknownNote ? (
        <Box width={w}>
          <Text color={M.mid}>{UNKNOWN_NOTE}</Text>
        </Box>
      ) : null}
      <Box flexGrow={1} />
    </Box>
  );
}
