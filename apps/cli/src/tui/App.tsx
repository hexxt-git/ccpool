import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import type { Config, Storage } from "@ccshare/core";
import { gatherView, type ViewModel } from "../lib/view.js";
import { renderContent, renderFooter } from "../lib/render.js";
import { loadConfig } from "../lib/config.js";

/**
 * Live shared view. Polls the DB / state.json every 2s (gatherView) and re-renders
 * the clock every 1s so reset countdowns tick smoothly. Renders the exact same
 * lines as `ccshare status` via the shared renderView.
 */
export function App({ cfg, storage }: { cfg: Config; storage: Storage }): React.ReactElement {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const [vm, setVm] = useState<ViewModel | null>(null);
  const [name, setName] = useState<string>(cfg.name);
  const [, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [newVm, freshCfg] = await Promise.all([gatherView(cfg, storage), loadConfig()]);
      setVm(newVm);
      if (freshCfg?.name) setName(freshCfg.name);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [cfg, storage]);

  useInput(
    (input) => {
      if (input === "q") exit();
      if (input === "r") void refresh();
    },
    { isActive: isRawModeSupported }
  );

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), 2000);
    const clock = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [refresh]);

  const now = Date.now();
  const contentLines = vm ? renderContent(vm, now) : ["loading…"];
  const footerLines = vm ? renderFooter(vm, now) : [];
  const termHeight = stdout?.rows ?? 24;
  const termWidth = stdout?.columns ?? 80;
  // border (2) + padding (2) on each side = 4 chars overhead; need room for both sides
  const wide = termWidth - 4 >= 72;

  const shortcuts = <Text dimColor>r refresh · q quit</Text>;

  const footer = wide ? (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="column">
        {footerLines.map((l, i) => (
          <Text key={i} dimColor>
            {l}
          </Text>
        ))}
      </Box>
      {shortcuts}
    </Box>
  ) : (
    <Box flexDirection="column">
      {footerLines.map((l, i) => (
        <Text key={i} dimColor>
          {l}
        </Text>
      ))}
      {shortcuts}
    </Box>
  );

  return (
    <Box
      flexDirection="column"
      paddingTop={1}
      paddingLeft={1}
      paddingRight={1}
      borderStyle="round"
      borderColor="gray"
      minHeight={termHeight}
    >
      <Box marginBottom={1}>
        <Text dimColor>ccshare · you are </Text>
        <Text>{name}</Text>
      </Box>
      {contentLines.map((l, i) =>
        l === "" ? <Box key={i} height={1} /> : <Text key={i}>{l}</Text>
      )}
      {err ? <Text color="red">error: {err}</Text> : null}
      <Box flexGrow={1} />
      {footer}
    </Box>
  );
}
