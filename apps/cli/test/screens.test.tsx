import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import type { Config } from "@ccshare/core";
import { InitScreen } from "../src/tui/screens/Init.js";

let ccshareDir: string;
let cfg: Config;

beforeEach(() => {
  ccshareDir = mkdtempSync(join(tmpdir(), "ccshare-screens-"));
  process.env.CCSHARE_DIR = ccshareDir;
  cfg = {
    mode: "selfhost",
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

describe("InitScreen", () => {
  it("opens on the first question with empty fields when not configured", () => {
    const { lastFrame, unmount } = render(<InitScreen onDone={() => {}} onQuit={() => {}} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ccshare setup");
    expect(frame).toContain("Not configured on this machine yet.");
    expect(frame).toContain("1. What is your name?");
    unmount();
  });

  it("indicates re-initialization when initialConfig is provided", () => {
    const { lastFrame, unmount } = render(
      <InitScreen onDone={() => {}} onQuit={() => {}} initialConfig={cfg} />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ccshare re-initialization");
    expect(frame).toContain("Re-configuring settings on this machine.");
    expect(frame).toContain("1. What is your name?");
    unmount();
  });
});
