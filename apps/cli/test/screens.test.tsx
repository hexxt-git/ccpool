import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import type { Config } from "@ccpool/core";
import { InitScreen } from "../src/tui/screens/Init.js";

let ccpoolDir: string;
let cfg: Config;

beforeEach(() => {
  ccpoolDir = mkdtempSync(join(tmpdir(), "ccpool-screens-"));
  process.env.CCPOOL_DIR = ccpoolDir;
  cfg = {
    server: { url: "https://api.example.test", token: "tok" },
    name: "sam",
    pollIntervalMs: 60_000,
    configDirs: [join(ccpoolDir, "config")],
    logLevel: "info",
  };
});

afterEach(() => {
  delete process.env.CCPOOL_DIR;
});

describe("InitScreen", () => {
  it("opens on the first question with empty fields when not configured", () => {
    const { lastFrame, unmount } = render(<InitScreen onDone={() => {}} onQuit={() => {}} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ccpool setup");
    expect(frame).toContain("Not configured on this machine yet.");
    expect(frame).toContain("1. What is your name?");
    unmount();
  });

  it("indicates re-initialization when initialConfig is provided", () => {
    const { lastFrame, unmount } = render(
      <InitScreen onDone={() => {}} onQuit={() => {}} initialConfig={cfg} />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ccpool re-initialization");
    expect(frame).toContain("Re-configuring settings on this machine.");
    expect(frame).toContain("1. What is your name?");
    unmount();
  });
});
