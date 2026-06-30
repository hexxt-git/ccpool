import { describe, expect, it } from "vitest";
import type { MessageUsage } from "../types.js";
import { ACTIVE_WINDOW_MS, isActive, summarizeMembers } from "./members.js";

const msg = (over: Partial<MessageUsage>): MessageUsage => ({
  uuid: Math.random().toString(36),
  user: "sam",
  timestamp: "2026-06-30T00:00:00.000Z",
  model: "claude-sonnet-4-6",
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  ...over,
});

describe("summarizeMembers", () => {
  it("sums every token component per name and keeps the latest timestamp", () => {
    const rows = summarizeMembers([
      msg({ user: "sam", inputTokens: 10, outputTokens: 5, timestamp: "2026-06-30T00:00:00.000Z" }),
      msg({
        user: "sam",
        cacheCreationTokens: 100,
        cacheReadTokens: 1,
        timestamp: "2026-06-30T01:00:00.000Z",
      }),
      msg({ user: "alex", outputTokens: 7 }),
    ]);
    const sam = rows.find((r) => r.user === "sam")!;
    expect(sam.tokens).toBe(116);
    expect(sam.lastActivityAt).toBe("2026-06-30T01:00:00.000Z");
    expect(rows.find((r) => r.user === "alex")!.tokens).toBe(7);
  });

  it("returns null lastActivity when no timestamp parses", () => {
    const rows = summarizeMembers([msg({ timestamp: "not-a-date" })]);
    expect(rows[0]!.lastActivityAt).toBeNull();
  });

  it("returns an empty array for no messages", () => {
    expect(summarizeMembers([])).toEqual([]);
  });
});

describe("isActive", () => {
  const now = Date.parse("2026-06-30T12:00:00.000Z");
  it("is true within the window, false outside, false for null", () => {
    expect(isActive(new Date(now - 1000).toISOString(), now)).toBe(true);
    expect(isActive(new Date(now - ACTIVE_WINDOW_MS - 1000).toISOString(), now)).toBe(false);
    expect(isActive(null, now)).toBe(false);
  });
});
