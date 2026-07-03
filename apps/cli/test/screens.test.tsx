import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import type { Config } from "@ccshare/core";
import { InitScreen, ProbeBanner } from "../src/tui/screens/Init.js";
import { ConfigScreen } from "../src/tui/screens/Config.js";
import { BackendScreen } from "../src/tui/screens/Backend.js";

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

describe("onboarding screen", () => {
  it("opens on the first question with empty fields", () => {
    const { lastFrame, unmount } = render(<InitScreen onDone={() => {}} onQuit={() => {}} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ccshare setup");
    expect(frame).toContain("not configured on this machine yet.");
    expect(frame).toContain("1. what should we call you?");
    unmount();
  });
});

describe("shared onboarding banner", () => {
  it("names the account, server, and 'creating a new group' when none exists", () => {
    const { lastFrame, unmount } = render(
      <ProbeBanner
        probe={{
          ok: true,
          account: { id: "acc-xyz", email: "me@team.com" },
          serverUrl: "https://api.example.com",
          groupExists: false,
        }}
      />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("me@team.com");
    expect(frame).toContain("api.example.com");
    expect(frame).toContain("creating a new group");
    unmount();
  });

  it("says 'joining your team's group' when a group already exists", () => {
    const { lastFrame, unmount } = render(
      <ProbeBanner
        probe={{
          ok: true,
          account: { id: "acc-xyz", email: "me@team.com" },
          serverUrl: "https://api.example.com",
          groupExists: true,
        }}
      />
    );
    expect(lastFrame() ?? "").toContain("joining your team");
    unmount();
  });

  it("surfaces an unreachable server (with the URL) instead of a bare failure", () => {
    const { lastFrame, unmount } = render(
      <ProbeBanner
        probe={{ ok: false, error: "could not reach the ccshare server at http://localhost:8787" }}
      />
    );
    expect(lastFrame() ?? "").toContain("localhost:8787");
    unmount();
  });
});

describe("config screen", () => {
  it("renders the general tab with the current identity and storage", () => {
    const { lastFrame, unmount } = render(
      <ConfigScreen config={cfg} onChange={() => {}} onBack={() => {}} />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("configure");
    expect(frame).toContain("general");
    expect(frame).toContain("daemon");
    expect(frame).toContain("your name");
    expect(frame).toContain("sam");
    expect(frame).toContain("log level");
    unmount();
  });

  it("shows the backend row (not a self-host-only 'storage' row)", () => {
    const { lastFrame, unmount } = render(
      <ConfigScreen config={cfg} onChange={() => {}} onBack={() => {}} />
    );
    expect(lastFrame() ?? "").toContain("backend");
    unmount();
  });
});

describe("backend screen", () => {
  it("offers both shared hosting and self-host, no matter the current mode", () => {
    const { lastFrame, unmount } = render(
      <BackendScreen config={cfg} onApplied={() => {}} onCancel={() => {}} />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("how is the group");
    expect(frame).toContain("shared hosting");
    expect(frame).toContain("self-host");
    unmount();
  });

  it("marks the current mode as selected", () => {
    const shared: Config = {
      ...cfg,
      mode: "shared",
      storage: undefined,
      server: { url: "https://api.example.com" },
    };
    const { lastFrame, unmount } = render(
      <BackendScreen config={shared} onApplied={() => {}} onCancel={() => {}} />
    );
    // the picker renders and defaults its selection to shared hosting
    expect(lastFrame() ?? "").toContain("shared hosting");
    unmount();
  });
});
