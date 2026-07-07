import { describe, expect, it } from "vitest";
import { renderStatusLines } from "../src/lib/status-render.js";
import type { DesignModel } from "../src/lib/design-model.js";

/** A no-tank model (caps empty) with the daemon flag we want to vary. */
function emptyModel(daemonRunning: boolean): DesignModel {
  return {
    me: "sam",
    account: "a@b.c",
    source: "none",
    sync: "never",
    daemonRunning,
    members: [],
    active: 0,
    caps: [],
    notes: [],
    loggedOut: false,
    alert: null,
  };
}

describe("renderStatusLines empty state", () => {
  it("tells the user to start the daemon only when it isn't running", () => {
    const out = renderStatusLines(emptyModel(false)).join("\n");
    expect(out).toContain("start the daemon");
  });

  it("does NOT say 'start the daemon' when the daemon is already running", () => {
    const out = renderStatusLines(emptyModel(true)).join("\n");
    expect(out).not.toContain("start the daemon");
    expect(out).toMatch(/waiting for the first usage poll/);
  });
});
