import React from "react";
import { render } from "ink";
import { requireInit } from "../lib/guard.js";
import { App } from "../tui/App.js";

/** Live shared view. Holds one open ViewSource for the session and polls it. */
export async function runTui(): Promise<void> {
  const ctx = await requireInit();
  if (!ctx) return;
  const { cfg, viewSource } = ctx;
  process.stdout.write("\x1B[2J\x1B[H");
  const app = render(<App cfg={cfg} viewSource={viewSource} />);

  const cleanExit = () => {
    process.stdout.write("\x1B[2J\x1B[H");
  };

  const sigintHandler = () => {
    cleanExit();
    void viewSource
      .close()
      .catch(() => {})
      .then(() => {
        process.exit(0);
      });
  };
  process.once("SIGINT", sigintHandler);
  process.once("SIGTERM", sigintHandler);

  try {
    await app.waitUntilExit();
  } finally {
    process.off("SIGINT", sigintHandler);
    process.off("SIGTERM", sigintHandler);
    cleanExit();
    await viewSource.close();
  }
}
