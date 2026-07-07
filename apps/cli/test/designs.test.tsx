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
  source: "db",
  stale: false,
  loggedOut: false,
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
    expect(model.members.find((m) => m.name === "unknown")!.active).toBe(false); // never active
    expect(model.active).toBe(1); // only alice; unknown is never counted active
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

describe("no data / never sync designs render", () => {
  const noneVm: ViewModel = {
    samples: [],
    shares: [],
    members: [],
    users: [],
    source: "none",
    stale: false,
    loggedOut: false,
    daemonRunning: false,
    tokenExpired: false,
    account: null,
    updatedAt: null,
  };
  const model = toDesignModel(noneVm, "alice", now);

  it("shows no members and no fabricated caps when there is no data", () => {
    expect(model.members).toEqual([]);
    expect(model.caps).toEqual([]);
    expect(model.alert).toBeNull();
  });

  for (const d of DESIGNS) {
    it(`renders "${d.name}" on empty data without throwing (no fake rows)`, () => {
      const { lastFrame, unmount } = render(<Box>{d.render(model, 108, 24, 0)}</Box>);
      const frame = lastFrame() ?? "";
      expect(frame).not.toContain("xxxx");
      unmount();
    });
  }
});

describe("logged out (server rejected the bearer)", () => {
  const loggedOutVm: ViewModel = {
    samples: [{ cap: "five_hour", pct: 40, resetsAt: null, capturedAt: iso(1) }], // local tank
    shares: [],
    members: [],
    users: [],
    source: "state",
    stale: false,
    loggedOut: true,
    daemonRunning: true,
    tokenExpired: false,
    account: "zeghdns@gmail.com",
    updatedAt: iso(1),
  };
  const model = toDesignModel(loggedOutVm, "alice", now);

  it("surfaces a logged-out alert and shows only the unattributed unknown row", () => {
    expect(model.alert).toMatch(/logged out/i);
    expect(model.loggedOut).toBe(true);
    // No fabricated members; the tank we do have falls entirely to `unknown`.
    expect(model.members.map((m) => m.name)).toEqual(["unknown"]);
    expect(model.members[0]!.byCap.five_hour).toBe(40);
  });

  for (const d of DESIGNS) {
    it(`renders "${d.name}" with the logged-out alert`, () => {
      const { lastFrame, unmount } = render(<Box>{d.render(model, 108, 24, 0)}</Box>);
      const frame = lastFrame() ?? "";
      expect(frame).toMatch(/logged out/i);
      expect(frame).not.toContain("xxxx");
      unmount();
    });
  }
});

describe("usage poll rate-limited (429)", () => {
  // The daemon is up and the roster is intact — a 429 only stalls the sync. We
  // must still show everyone, plus a red alert explaining the paused sync.
  const rateLimitedVm: ViewModel = {
    ...vm,
    stale: false,
    loggedOut: false,
    pollError: { status: 429, message: "rate-limited (429)", at: iso(1) },
  };
  const model = toDesignModel(rateLimitedVm, "alice", now);

  it("raises a red alert naming the 429 while keeping the members", () => {
    expect(model.alert).toMatch(/rate-limited \(429\)/);
    expect(model.loggedOut).toBe(false);
    // The roster is NOT blanked — everyone still shows.
    expect(model.members.some((m) => m.name === "alice")).toBe(true);
  });

  for (const d of DESIGNS) {
    it(`renders "${d.name}" with the 429 alert`, () => {
      const { lastFrame, unmount } = render(<Box>{d.render(model, 108, 24, 0)}</Box>);
      expect(lastFrame() ?? "").toMatch(/429/);
      unmount();
    });
  }
});

describe("freshly initialized ledger (connected, no usage yet)", () => {
  // A live view whose ledger has a tank reading but no attributed activity: shares
  // are empty until someone uses Claude Code. The table must still show `unknown`
  // holding the whole tank — never empty.
  const freshVm: ViewModel = {
    samples: [
      { cap: "five_hour", pct: 12, resetsAt: null, capturedAt: iso(0) },
      { cap: "seven_day", pct: 3, resetsAt: null, capturedAt: iso(0) },
    ],
    shares: [],
    members: [],
    users: [{ name: "sam", createdAt: iso(5) }],
    source: "db",
    stale: false,
    loggedOut: false,
    daemonRunning: true,
    tokenExpired: false,
    account: "zeghdns@gmail.com",
    updatedAt: iso(0),
  };
  const model = toDesignModel(freshVm, "sam", now);

  it("shows exactly the unknown row, holding the full tank per cap", () => {
    expect(model.alert).toBeNull();
    expect(model.members.map((m) => m.name)).toEqual(["unknown"]);
    const u = model.members[0]!;
    expect(u.byCap.five_hour).toBe(12);
    expect(u.byCap.seven_day).toBe(3);
    expect(u.active).toBe(false);
  });

  for (const d of DESIGNS) {
    it(`renders "${d.name}" with an unknown row (never an empty table)`, () => {
      const { lastFrame, unmount } = render(<Box>{d.render(model, 108, 24, 0)}</Box>);
      expect(lastFrame() ?? "").toContain("unknown");
      unmount();
    });
  }
});
