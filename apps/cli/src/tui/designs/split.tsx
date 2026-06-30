import React from "react";
import { Box, Text } from "ink";
import type { DesignModel } from "../../lib/design-model.js";
import { P, personColor } from "./palette.js";
import {
  Clawd,
  Header,
  MiniCap,
  Panel,
  StatusDot,
  VMeter,
  lpad,
  pad,
  scrollLabel,
  tok,
} from "./parts.js";

// 2 — SPLIT VIEW: vertical split — overall meters + members list
const ENTRY = 5;

function layout(capCount: number, cols: number, rows: number) {
  const panelH = rows - 6; // bordered header(3 + 2 border) + blank(1)
  const meters = Math.max(1, capCount);
  const mw = cols >= 150 ? 10 : cols >= 110 ? 8 : cols >= 85 ? 6 : 4;
  const leftW = meters * (mw + 4) + 4;
  const rightW = Math.max(28, cols - leftW - 2);
  const meterH = Math.max(3, panelH - 8);
  const barW = Math.max(8, rightW - 23);
  const visible = Math.max(1, Math.floor((panelH - 2) / ENTRY));
  return { mw, leftW, rightW, meterH, barW, visible, panelH };
}

export function splitVisible(cols: number, rows: number): number {
  return layout(3, cols, rows).visible;
}

export function split(
  model: DesignModel,
  cols: number,
  rows: number,
  off: number
): React.ReactElement {
  const { mw, leftW, rightW, meterH, barW, visible, panelH } = layout(
    model.caps.length,
    cols,
    rows
  );
  const shown = model.members.slice(off, off + visible);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box
        width={leftW + 2 + rightW}
        borderStyle="round"
        borderColor={P.green}
        paddingX={1}
        flexShrink={0}
      >
        <Header
          model={model}
          color={P.green}
          pal={{ label: P.dim, value: P.cream, accent: P.green }}
        />
      </Box>
      <Box>
        <Panel title="overall" color={P.orange} width={leftW} height={panelH}>
          <Box marginTop={1} justifyContent="center">
            {model.caps.map((c) => (
              <VMeter
                key={c.kind}
                pct={c.pct}
                h={meterH}
                w={mw}
                label={c.short}
                resets={c.resets}
              />
            ))}
          </Box>
        </Panel>
        <Box marginLeft={2}>
          <Panel
            title="members"
            color={P.green}
            width={rightW}
            height={panelH}
            right={scrollLabel(off, visible, model.members.length)}
          >
            {shown.map((u, i) => {
              const col = personColor(u, off + i);
              return (
                <Box key={u.name} flexDirection="column" marginTop={1}>
                  <Text>
                    <Text color={P.faint}>{pad("#" + (off + i + 1), 2)} </Text>
                    <Text color={col}>{pad(u.name + (u.isMe ? " ◂" : ""), 10)}</Text>
                    <StatusDot active={u.active} />
                    <Text color={P.dim}>
                      {"   "}
                      {lpad(tok(u.tokens), 6)} tok
                    </Text>
                  </Text>
                  <Box marginLeft={1}>
                    <Clawd color={col} />
                    <Box flexDirection="column" marginLeft={2}>
                      {model.caps.map((c) => (
                        <MiniCap
                          key={c.kind}
                          label={c.short === "opus" ? "op" : c.short}
                          pct={u.byCap[c.kind] ?? 0}
                          w={barW - 1}
                          color={col}
                        />
                      ))}
                    </Box>
                  </Box>
                </Box>
              );
            })}
          </Panel>
        </Box>
      </Box>
    </Box>
  );
}
