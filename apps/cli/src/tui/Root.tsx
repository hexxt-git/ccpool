import React, { useEffect, useMemo, useState } from "react";
import { useApp } from "ink";
import type { Config } from "@ccshare/core";
import { makeViewSource } from "../lib/backend.js";
import { App } from "./App.js";
import { InitScreen } from "./screens/Init.js";
import { ConfigScreen } from "./screens/Config.js";

/**
 * The TUI-first entry. The bin opens this: not configured → onboarding wizard;
 * configured → the live view, with `c` to open the tabbed config screen. The old
 * `init` / `config` flag commands stay as a scriptable fallback but everything
 * here is reachable without them.
 */
type Screen = "init" | "status" | "config";

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
        onDone={(cfg) => {
          setConfig(cfg);
          setScreen("status");
        }}
        onQuit={exit}
      />
    );

  if (screen === "config")
    return (
      <ConfigScreen
        config={config}
        onChange={(cfg) => setConfig(cfg)}
        onBack={() => setScreen("status")}
      />
    );

  return <App cfg={config} viewSource={viewSource!} onConfigure={() => setScreen("config")} />;
}
