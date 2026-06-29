import { describe, expect, it } from "vitest";
import type { UsageSample, UserShare } from "@ccshare/core";
import { renderUserTable } from "../src/lib/render.js";

const sample = (cap: UsageSample["cap"], pct: number): UsageSample => ({
  cap,
  pct,
  resetsAt: null,
  capturedAt: "2026-06-29T00:00:00.000Z",
});

const share = (user: string, cap: UserShare["cap"], pct: number): UserShare => ({
  user,
  cap,
  pct,
});

describe("renderUserTable", () => {
  it("lists users by share desc with unknown last, columns per cap", () => {
    const samples = [sample("five_hour", 60), sample("seven_day", 30)];
    const shares = [
      share("sam", "five_hour", 45),
      share("alex", "five_hour", 15),
      share("unknown", "five_hour", 0),
      share("sam", "seven_day", 22.5),
      share("alex", "seven_day", 7.5),
      share("unknown", "seven_day", 0),
    ];
    const lines = renderUserTable(shares, samples);
    const body = lines.filter((l) => /sam|alex|unknown/.test(l));
    expect(body[0]).toContain("sam");
    expect(body[1]).toContain("alex");
    expect(body[2]).toContain("unknown"); // always last
    expect(body[0]).toMatch(/45%/);
    expect(body[0]).toMatch(/23%/); // 22.5 rounds to 23
  });

  it("renders nothing without samples or shares", () => {
    expect(renderUserTable([], [])).toEqual([]);
    expect(renderUserTable([share("sam", "five_hour", 10)], [])).toEqual([]);
  });

  it("marks a user over their budget with ▲, within with ·", () => {
    const lines = renderUserTable(
      [share("sam", "five_hour", 45), share("alex", "five_hour", 15)],
      [sample("five_hour", 60)],
      [{ name: "sam", cap: "five_hour", sharePct: 33 }]
    );
    const samRow = lines.find((l) => l.startsWith("sam"))!;
    const alexRow = lines.find((l) => l.startsWith("alex"))!;
    expect(samRow).toContain("▲"); // 45% over 33%
    expect(alexRow).not.toContain("▲"); // no budget set
  });
});
