import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { MemoryStorage, type Config } from "@ccshare/core";
import { App } from "../src/tui/App.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ccshareDir: string;
let cfg: Config;

beforeEach(() => {
  ccshareDir = mkdtempSync(join(tmpdir(), "ccshare-tui-"));
  process.env.CCSHARE_DIR = ccshareDir;
  cfg = {
    storage: { driver: "memory", url: "" },
    name: "sam",
    pollIntervalMs: 60_000,
    configDirs: [join(ccshareDir, "config")],
    logLevel: "info",
  };
});

afterEach(() => {
  delete process.env.CCSHARE_DIR;
});

describe("TUI App", () => {
  it("renders the tank header from the shared view", async () => {
    const storage = new MemoryStorage();
    await storage.initializeSchema();
    await storage.recordUsageSample({
      cap: "five_hour",
      pct: 42,
      resetsAt: null,
      capturedAt: new Date().toISOString(),
    });
    await storage.recordUsageSample({
      cap: "seven_day",
      pct: 68,
      resetsAt: null,
      capturedAt: new Date().toISOString(),
    });

    const { lastFrame, unmount } = render(<App cfg={cfg} storage={storage} />);
    await delay(60); // let the async gatherView resolve

    const frame = lastFrame() ?? "";
    expect(frame).toContain("you are ");
    expect(frame).toContain("sam");
    expect(frame).toContain("5h");
    expect(frame).toContain("42%");
    expect(frame).toContain("weekly");
    expect(frame).toContain("68%");
    // daemon isn't running in the test -> header shows it stopped
    expect(frame).toContain("daemon ");
    expect(frame).toContain("stopped");

    unmount();
  });
});
