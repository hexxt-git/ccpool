import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "ink";
import type { Config } from "@ccshare/core";
import { makeViewSource } from "../lib/backend.js";
import { logout } from "../lib/config.js";
import { isDaemonRunning, spawnDaemon, stopDaemonProcess } from "../commands/daemon.js";
import { App } from "./App.js";
import { InitScreen } from "./screens/Init.js";

/**
 * The TUI-first entry. The bin opens this: not configured → onboarding wizard;
 * configured → the live view, with `r` to re-initialize configuration.
 */
type Screen = "init" | "status";

/** A config is only usable for the live view once it carries a server bearer. */
function isConfigured(cfg: Config | null): cfg is Config {
  return !!cfg?.server?.url && !!cfg.server.token;
}

export function Root({ initialConfig }: { initialConfig: Config | null }): React.ReactElement {
  const { exit } = useApp();
  const [config, setConfig] = useState<Config | null>(initialConfig);
  const [screen, setScreen] = useState<Screen>(isConfigured(initialConfig) ? "status" : "init");

  const configured = isConfigured(config);

  // The server rejected our bearer (revoked/rotated, or the ledger was reset).
  // Retrying can't fix a dead token, so log out: stop the doomed daemon, delete the
  // token file, drop it from the in-memory config (→ unconfigured), and send the
  // user to the re-init wizard to re-authenticate (§13).
  const handleLoggedOut = useCallback(() => {
    if (config) stopDaemonProcess(config);
    void logout();
    setConfig((c) => (c?.server ? { ...c, server: { url: c.server.url } } : c));
    setScreen("init");
  }, [config]);

  // One long-lived ViewSource for the live view; recreated only when the backend
  // target changes (a reconfigure), and closed on unmount / swap. Only built once
  // the config is complete — an incomplete config (no token) means onboarding,
  // and `makeViewSource` would otherwise throw.
  const viewSource = useMemo(
    () => (configured ? makeViewSource(config) : null),
    [configured, config?.server?.url, config?.server?.token]
  );
  useEffect(() => () => void viewSource?.close(), [viewSource]);

  // A live view expects a live observer. While showing it, keep the daemon up —
  // if it's down, bring it back (the header shows "down" in red until it's back).
  // spawnDaemon is a no-op once it owns the pidfile.
  useEffect(() => {
    if (!configured || screen !== "status") return;
    const tryUp = (): void => {
      if (!isDaemonRunning(config)) {
        try {
          spawnDaemon(config);
        } catch {
          // best effort — the header keeps showing "down" and we retry
        }
      }
    };
    tryUp();
    const t = setInterval(tryUp, 5000);
    return () => clearInterval(t);
  }, [configured, screen, config]);

  if (!configured || screen === "init")
    return (
      <InitScreen
        initialConfig={config}
        onDone={(cfg) => {
          setConfig(cfg);
          setScreen("status");
        }}
        onQuit={exit}
        onCancel={configured ? () => setScreen("status") : undefined}
      />
    );

  return (
    <App
      cfg={config}
      viewSource={viewSource!}
      onConfigure={() => setScreen("init")}
      onLoggedOut={handleLoggedOut}
    />
  );
}
