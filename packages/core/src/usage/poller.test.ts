import { describe, expect, it } from "vitest";
import { parseUsage, pollUsage, UsageAuthError, UsageRequestError } from "./poller.js";

// A trimmed copy of the real /api/oauth/usage payload shape.
const liveBody = {
  five_hour: { utilization: 46, resets_at: "2026-06-29T21:10:00.85+00:00" },
  seven_day: { utilization: 19, resets_at: "2026-07-05T22:00:00.85+00:00" },
  seven_day_opus: null,
};

describe("parseUsage", () => {
  it("maps each available cap to a sample, verbatim utilization", () => {
    const samples = parseUsage(liveBody, "2026-06-29T20:00:00.000Z");
    expect(samples).toEqual([
      {
        cap: "five_hour",
        pct: 46,
        resetsAt: "2026-06-29T21:10:00.85+00:00",
        capturedAt: "2026-06-29T20:00:00.000Z",
      },
      {
        cap: "seven_day",
        pct: 19,
        resetsAt: "2026-07-05T22:00:00.85+00:00",
        capturedAt: "2026-06-29T20:00:00.000Z",
      },
    ]);
  });

  it("skips null caps instead of rendering them as 0", () => {
    const samples = parseUsage(liveBody);
    expect(samples.some((s) => s.cap === "seven_day_opus")).toBe(false);
  });

  it("tolerates a missing body", () => {
    expect(parseUsage(undefined)).toEqual([]);
    expect(parseUsage({})).toEqual([]);
  });

  it("skips a cap whose utilization is non-finite (NaN/Infinity)", () => {
    // typeof NaN === "number", so a bare typeof guard would let these through and
    // poison reset detection + attribution. They must be dropped, not rendered.
    expect(parseUsage({ five_hour: { utilization: NaN, resets_at: null } })).toEqual([]);
    expect(parseUsage({ five_hour: { utilization: Infinity, resets_at: null } })).toEqual([]);
    expect(parseUsage({ five_hour: { utilization: -Infinity, resets_at: null } })).toEqual([]);
  });

  it("skips a cap whose utilization is not a number", () => {
    expect(parseUsage({ five_hour: { utilization: "46", resets_at: null } })).toEqual([]);
    expect(parseUsage({ five_hour: { utilization: null, resets_at: null } })).toEqual([]);
  });

  it("keeps a finite 0 (a real reading, not garbage)", () => {
    const samples = parseUsage({ five_hour: { utilization: 0, resets_at: null } });
    expect(samples).toEqual([
      { cap: "five_hour", pct: 0, resetsAt: null, capturedAt: samples[0]!.capturedAt },
    ]);
  });
});

describe("pollUsage", () => {
  it("sends the oauth headers and parses the body", async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), headers: init.headers as Record<string, string> };
      return new Response(JSON.stringify(liveBody), { status: 200 });
    }) as unknown as typeof fetch;

    const samples = await pollUsage("tok-123", { fetchImpl, version: "9.9.9" });
    expect(samples.map((s) => s.cap)).toEqual(["five_hour", "seven_day"]);
    expect(seen!.headers.Authorization).toBe("Bearer tok-123");
    expect(seen!.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(seen!.headers["User-Agent"]).toBe("claude-code/9.9.9");
  });

  it("throws UsageAuthError on 401", async () => {
    const fetchImpl = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(pollUsage("tok", { fetchImpl })).rejects.toBeInstanceOf(UsageAuthError);
  });

  it("throws UsageRequestError carrying the status on other failures (for backoff)", async () => {
    const fetchImpl = (async () => new Response("", { status: 429 })) as unknown as typeof fetch;
    const err = await pollUsage("tok", { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(UsageRequestError);
    expect((err as UsageRequestError).status).toBe(429);
    expect((err as Error).message).toContain("429");
  });
});
