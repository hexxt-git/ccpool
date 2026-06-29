import React from "react";
import { render } from "ink";
import { requireInit } from "../lib/guard.js";
import { App } from "../tui/App.js";

/** Live shared view. Holds one open Storage for the session and polls it. */
export async function runTui(): Promise<void> {
  const ctx = await requireInit();
  if (!ctx) return;
  const { cfg, storage } = ctx;
  const app = render(<App cfg={cfg} storage={storage} />);
  try {
    await app.waitUntilExit();
  } finally {
    await storage.close();
  }
}
