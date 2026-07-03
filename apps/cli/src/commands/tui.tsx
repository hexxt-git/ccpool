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
  try {
    await app.waitUntilExit();
  } finally {
    await viewSource.close();
  }
}
