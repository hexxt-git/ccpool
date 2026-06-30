import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { toDesignModel } from "../src/lib/design-model.js";
import { DESIGNS } from "../src/tui/designs/index.js";
import type { ViewModel } from "../src/lib/view.js";

const now = Date.parse("2026-06-30T12:00:00.000Z");
const iso = (minAgo: number) => new Date(now - minAgo * 60000).toISOString();

const vm: ViewModel = {
  samples: [
    { cap: "five_hour", pct: 91, resetsAt: iso(-160), capturedAt: iso(0) },
    { cap: "seven_day", pct: 83, resetsAt: iso(-6000), capturedAt: iso(0) },
    { cap: "seven_day_opus", pct: 24, resetsAt: iso(-6000), capturedAt: iso(0) },
  ],
  shares: [
    { user: "alice", cap: "five_hour", pct: 42 }, // 5h > 0 -> active
    { user: "ben", cap: "five_hour", pct: 0 }, // 5h == 0 -> inactive
    { user: "unknown", cap: "five_hour", pct: 21 },
    { user: "alice", cap: "seven_day", pct: 31 },
    { user: "unknown", cap: "seven_day", pct: 52 },
    { user: "alice", cap: "seven_day_opus", pct: 12 },
  ],
  members: [
    { user: "alice", tokens: 1_240_000, lastActivityAt: iso(2) },
    { user: "ben", tokens: 840_000, lastActivityAt: iso(40) },
  ],
  budgets: [],
  source: "db",
  stale: false,
  daemonRunning: true,
  tokenExpired: false,
  account: "zeghdns@gmail.com",
  updatedAt: iso(0.2),
};

describe("toDesignModel", () => {
  const model = toDesignModel(vm, "alice", now);

  it("flattens caps, joins tokens/active, and keeps unknown last", () => {
    expect(model.caps.map((c) => c.short)).toEqual(["5h", "wk", "opus"]);
    expect(model.account).toBe("zeghdns@gmail.com");
    expect(model.members.at(-1)!.name).toBe("unknown"); // always last
    expect(model.members[0]!.name).toBe("alice"); // highest 5h share
    const alice = model.members.find((m) => m.name === "alice")!;
    expect(alice.tokens).toBe(1_240_000);
    expect(alice.active).toBe(true); // 5h share 42 > 0
    expect(model.members.find((m) => m.name === "ben")!.active).toBe(false); // 5h share 0
    expect(model.active).toBe(2); // alice + unknown (both have 5h > 0)
  });

  it("leaves a cap undefined for a member with no row (renders as —)", () => {
    const unknown = model.members.find((m) => m.name === "unknown")!;
    expect(unknown.byCap.seven_day_opus).toBeUndefined();
  });
});

describe("designs render", () => {
  const model = toDesignModel(vm, "alice", now);
  for (const d of DESIGNS) {
    it(`renders "${d.name}" without throwing, showing identity + members`, () => {
      const { lastFrame, unmount } = render(<Box>{d.render(model, 108, 24, 0)}</Box>);
      const frame = lastFrame() ?? "";
      expect(frame).toContain("ccshare");
      expect(frame).toContain("alice");
      expect(frame).toContain("unknown");
      expect(frame).toContain("91%"); // 5h tank
      unmount();
    });
  }
});
