import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { emptyBatch, StorageViewSource, type Config } from "@ccshare/core";
import { LibsqlDatabase } from "@ccshare/storage-libsql";
import { App } from "../src/tui/App.js";
import { Root } from "../src/tui/Root.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ccshareDir: string;
let cfg: Config;
let db: LibsqlDatabase | undefined;

beforeEach(() => {
  ccshareDir = mkdtempSync(join(tmpdir(), "ccshare-tui-"));
  process.env.CCSHARE_DIR = ccshareDir;
  cfg = {
    server: { url: "https://api.example.test", token: "tok" },
    name: "sam",
    pollIntervalMs: 60_000,
    configDirs: [join(ccshareDir, "config")],
    logLevel: "info",
  };
});

afterEach(async () => {
  delete process.env.CCSHARE_DIR;
  await db?.close();
  db = undefined;
});

describe("TUI App", () => {
  it("renders the tank header from the shared view", async () => {
    db = new LibsqlDatabase(":memory:");
    await db.init();
    const storage = db.forGroup("g");
    await storage.initializeSchema();
    await storage.recordBatch({
      ...emptyBatch(),
      samples: [
        { cap: "five_hour", pct: 42, resetsAt: null, capturedAt: new Date().toISOString() },
        { cap: "seven_day", pct: 68, resetsAt: null, capturedAt: new Date().toISOString() },
      ],
    });
    const viewSource = new StorageViewSource(storage);

    const { lastFrame, unmount } = render(<App cfg={cfg} viewSource={viewSource} />);
    await delay(60); // let the async gatherView resolve

    const frame = lastFrame() ?? "";
    expect(frame).toContain("you are ");
    expect(frame).toContain("sam");
    expect(frame).toContain("5h");
    expect(frame).toContain("42%");
    expect(frame).toContain("weekly");
    expect(frame).toContain("68%");
    // daemon isn't running in the test -> header shows it "down" (in red)
    expect(frame).toContain("daemon ");
    expect(frame).toContain("down");

    unmount();
  });
});

describe("Root", () => {
  it("routes an incomplete config (server URL, no token) to onboarding instead of crashing", () => {
    // Regression: makeViewSource throws without a token, so Root must treat a
    // token-less config as "not configured" and show the wizard.
    const incomplete = {
      server: { url: "https://api.example.test" }, // no token
      name: "sam",
      pollIntervalMs: 60_000,
      configDirs: [join(ccshareDir, "config")],
      logLevel: "info",
    } as Config;
    const { lastFrame, unmount } = render(<Root initialConfig={incomplete} />);
    const frame = lastFrame() ?? "";
    // The onboarding wizard is up (its first step), not a crash / the live view.
    expect(frame).toContain("What is your name?");
    unmount();
  });
});
