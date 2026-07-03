import React, { useEffect, useMemo, useState } from "react";
import { useApp } from "ink";
import type { Config } from "@ccshare/core";
import { makeViewSource } from "../lib/backend.js";
import { App } from "./App.js";
import { InitScreen } from "./screens/Init.js";

/**
 * The TUI-first entry. The bin opens this: not configured → onboarding wizard;
 * configured → the live view, with `c` to re-initialize configuration.
 */
type Screen = "init" | "status";

export function Root({ initialConfig }: { initialConfig: Config | null }): React.ReactElement {
  const { exit } = useApp();
  const [config, setConfig] = useState<Config | null>(initialConfig);
  const [screen, setScreen] = useState<Screen>(initialConfig ? "status" : "init");

  // One long-lived ViewSource for the live view; recreated only when the backend
  // target changes (a reconfigure), and closed on unmount / swap.
  const viewSource = useMemo(
    () => (config ? makeViewSource(config) : null),
    [
      config?.mode,
      config?.storage?.driver,
      config?.storage?.url,
      config?.storage?.token,
      config?.server?.url,
      config?.server?.token,
    ]
  );
  useEffect(() => () => void viewSource?.close(), [viewSource]);

  if (!config || screen === "init")
    return (
      <InitScreen
        initialConfig={config}
        onDone={(cfg) => {
          setConfig(cfg);
          setScreen("status");
        }}
        onQuit={exit}
        onCancel={config ? () => setScreen("status") : undefined}
      />
    );

  return <App cfg={config} viewSource={viewSource!} onConfigure={() => setScreen("init")} />;
}
