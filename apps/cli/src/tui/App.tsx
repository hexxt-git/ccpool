import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import type { Config, Storage } from "@ccshare/core";
import { gatherView, type ViewModel } from "../lib/view.js";
import { renderView } from "../lib/render.js";

/**
 * Live shared view. Polls the DB / state.json every 2s (gatherView) and re-renders
 * the clock every 1s so reset countdowns tick smoothly. Renders the exact same
 * lines as `ccshare status` via the shared renderView.
 */
export function App({ cfg, storage }: { cfg: Config; storage: Storage }): React.ReactElement {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const [vm, setVm] = useState<ViewModel | null>(null);
  const [, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setVm(await gatherView(cfg, storage));
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

  const lines = vm ? renderView(vm) : ["loading…"];

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="gray">
      <Box marginBottom={1}>
        <Text dimColor>ccshare · you are </Text>
        <Text>{cfg.name}</Text>
      </Box>
      {lines.map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
      {err ? <Text color="red">error: {err}</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>r refresh · q quit</Text>
      </Box>
    </Box>
  );
}
