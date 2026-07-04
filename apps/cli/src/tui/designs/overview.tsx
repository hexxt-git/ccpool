import React from "react";
import { Box, Text } from "ink";
import type { DesignModel } from "../../lib/design-model.js";
import { P, heat, personColor } from "./palette.js";
import { Bar, Cell, Header, Rule, StatusDot, lpad, pct, scrollLabel, share, tok } from "./parts.js";

// 1 — OVERVIEW: header + overall gauges + member table
const COL = { rank: 3, member: 10, weekly: 7, opus: 6, tokens: 8, status: 11 };

export function overviewVisible(_cols: number, rows: number): number {
  // top-blank(1) header(3) blank(1) overall-hd(1) gauges(3) blank(1) members-hd(1) table-chrome(4)
  return Math.max(1, rows - 15);
}

export function overview(
  model: DesignModel,
  cols: number,
  rows: number,
  off: number
): React.ReactElement {
  // `cols` is the drawable content width (the app applies its own paddingX), so
  // fill it — the member table box spans the full width, no right-edge gap.
  const inner = cols;
  const hasOpus = model.caps.some((c) => c.kind === "seven_day_opus");
  const fixed =
    COL.rank + COL.member + COL.weekly + (hasOpus ? COL.opus : 0) + COL.tokens + COL.status;
  const gaugeW = Math.max(10, inner - 35);
  const barW = Math.max(8, inner - 4 - fixed - 5);
  const fiveCol = barW + 5;
  const visible = overviewVisible(cols, rows);
  const shown = model.members.slice(off, off + visible);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box height={1} />
      <Header
        model={model}
        color={P.orange}
        pal={{ label: P.dim, value: P.cream, accent: P.green }}
      />
      <Box height={1} />
      <Text color={P.dim} bold>
        overall
      </Text>
      {model.caps.map((c) => (
        <Box key={c.kind}>
          <Cell w={13}>
            <Text color={P.cream} bold>
              {c.label}
            </Text>
          </Cell>
          <Bar pct={c.pct} width={gaugeW} />
          <Text color={heat(c.pct)} bold>
            {" "}
            {lpad(pct(c.pct), 4)}
          </Text>
          <Text color={P.dim}>
            {c.resets ? (c.resets === "due" ? " reset is due" : ` resets in ${c.resets}`) : ""}
          </Text>
        </Box>
      ))}
      <Box height={1} />
      <Box justifyContent="space-between">
        <Text color={P.dim} bold>
          members
        </Text>
        <Text color={P.dim}>{scrollLabel(off, visible, model.members.length)}</Text>
      </Box>
      {model.disconnected ? <Text color={P.red}>ERROR: can't reach the database</Text> : null}
      <Box
        width={inner}
        flexDirection="column"
        borderStyle="round"
        borderColor={P.faint}
        paddingX={1}
        flexShrink={0}
      >
        <Box flexShrink={0}>
          <Cell w={COL.rank}>
            <Text color={P.orange} bold>
              #
            </Text>
          </Cell>
          <Cell w={COL.member}>
            <Text color={P.orange} bold>
              member
            </Text>
          </Cell>
          <Cell w={fiveCol}>
            <Text color={P.orange} bold>
              5h
            </Text>
          </Cell>
          <Cell w={COL.weekly} align="right">
            <Text color={P.orange} bold>
              weekly
            </Text>
          </Cell>
          {hasOpus ? (
            <Cell w={COL.opus} align="right">
              <Text color={P.orange} bold>
                opus
              </Text>
            </Cell>
          ) : null}
          <Cell w={COL.tokens} align="right">
            <Text color={P.orange} bold>
              tokens
            </Text>
          </Cell>
          <Cell w={COL.status} align="center">
            <Text color={P.orange} bold>
              status
            </Text>
          </Cell>
        </Box>
        <Box flexShrink={0}>
          <Rule w={inner - 4} color={P.faint} />
        </Box>
        {shown.map((u, i) => (
          <Box key={off + i} flexShrink={0}>
            <Cell w={COL.rank}>
              <Text color={P.faint}>{off + i + 1}</Text>
            </Cell>
            <Cell w={COL.member}>
              <Text color={personColor(u, off + i)}>{u.name}</Text>
              {u.isMe ? <Text color={personColor(u, off + i)}>◂</Text> : null}
            </Cell>
            <Cell w={fiveCol}>
              <Text>
                <Bar pct={u.byCap.five_hour ?? 0} width={barW} color={personColor(u, off + i)} />{" "}
                {lpad(share(u, "five_hour"), 4)}
              </Text>
            </Cell>
            <Cell w={COL.weekly} align="right">
              <Text color={P.cream}>{share(u, "seven_day")}</Text>
            </Cell>
            {hasOpus ? (
              <Cell w={COL.opus} align="right">
                <Text color={P.cream}>{share(u, "seven_day_opus")}</Text>
              </Cell>
            ) : null}
            <Cell w={COL.tokens} align="right">
              <Text color={P.dim}>{tok(u.tokens)}</Text>
            </Cell>
            <Cell w={COL.status} align="right">
              <StatusDot active={u.active} flip />
            </Cell>
          </Box>
        ))}
      </Box>
      <Box flexGrow={1} />
    </Box>
  );
}
