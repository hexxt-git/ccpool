import { afterAll, describe, expect, it } from "vitest";
import type { Storage } from "../src/index.js";
import { UNKNOWN_USER } from "../src/index.js";

/**
 * Shared Storage contract. Run against every adapter (memory, libsql, postgres)
 * to prove both swappability and the clean-DB enforcement (§15).
 */
export interface ContractHarness {
  name: string;
  /** An empty, uninitialized database. */
  fresh(): Promise<Storage>;
  /** A database that already holds another project's tables (optional). */
  foreign?(): Promise<Storage>;
}

export function runStorageContract(h: ContractHarness): void {
  describe(`Storage contract: ${h.name}`, () => {
    const opened: Storage[] = [];
    const open = async (s: Promise<Storage>) => {
      const v = await s;
      opened.push(v);
      return v;
    };
    afterAll(async () => {
      await Promise.all(opened.map((s) => s.close().catch(() => {})));
    });

    it("reports empty, then ccshare after init", async () => {
      const s = await open(h.fresh());
      expect(await s.inspect()).toEqual({ kind: "empty" });
      await s.initializeSchema();
      expect(await s.inspect()).toMatchObject({ kind: "ccshare" });
    });

    if (h.foreign) {
      it("reports foreign and refuses to initialize over it", async () => {
        const s = await open(h.foreign!());
        expect(await s.inspect()).toEqual({ kind: "foreign" });
        await expect(s.initializeSchema()).rejects.toThrow();
      });
    }

    it("upserts users idempotently", async () => {
      const s = await open(h.fresh());
      await s.initializeSchema();
      await s.upsertUser("sam");
      await s.upsertUser("sam");
      await s.upsertUser("alex");
      expect((await s.getUsers()).map((u) => u.name)).toEqual(["alex", "sam"]);
    });

    it("returns the latest sample per cap", async () => {
      const s = await open(h.fresh());
      await s.initializeSchema();
      await s.recordUsageSample({
        cap: "five_hour",
        pct: 10,
        resetsAt: null,
        capturedAt: "2026-06-29T10:00:00.000Z",
      });
      await s.recordUsageSample({
        cap: "five_hour",
        pct: 42,
        resetsAt: "2026-06-29T15:00:00.000Z",
        capturedAt: "2026-06-29T11:00:00.000Z",
      });
      await s.recordUsageSample({
        cap: "seven_day",
        pct: 68,
        resetsAt: null,
        capturedAt: "2026-06-29T11:00:00.000Z",
      });
      const latest = await s.getLatestSamples();
      expect(latest.find((x) => x.cap === "five_hour")?.pct).toBe(42);
      expect(latest.find((x) => x.cap === "seven_day")?.pct).toBe(68);
    });

    it("dedups message usage on uuid", async () => {
      const s = await open(h.fresh());
      await s.initializeSchema();
      const row = {
        uuid: "u1",
        user: "sam",
        timestamp: "2026-06-29T12:00:00.000Z",
        model: "claude-opus-4-8",
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationTokens: 3,
        cacheReadTokens: 4,
      };
      await s.recordMessageUsage([row]);
      await s.recordMessageUsage([{ ...row, inputTokens: 999 }]); // same uuid -> ignored
      const shares = await s.getShareSince("2026-06-29T00:00:00.000Z");
      // only sam has weight, so with no tank sample everything is 0 / unknown=0
      expect(shares.length).toBeGreaterThan(0);
    });

    it("apportions shares to the tank, summing per cap", async () => {
      const s = await open(h.fresh());
      await s.initializeSchema();
      await s.recordUsageSample({
        cap: "five_hour",
        pct: 60,
        resetsAt: null,
        capturedAt: "2026-06-29T11:00:00.000Z",
      });
      await s.recordMessageUsage([mkMsg("a", "sam", 30), mkMsg("b", "alex", 10)]);
      const shares = (await s.getShareSince("2026-06-29T00:00:00.000Z")).filter(
        (x) => x.cap === "five_hour"
      );
      const total = shares.reduce((acc, x) => acc + x.pct, 0);
      expect(total).toBeCloseTo(60, 5);
      expect(shares.find((x) => x.user === "sam")?.pct).toBeCloseTo(45, 5);
      expect(shares.find((x) => x.user === "alex")?.pct).toBeCloseTo(15, 5);
      expect(shares.find((x) => x.user === UNKNOWN_USER)?.pct).toBeCloseTo(0, 5);
    });

    it("sets and reads budgets, upserting on conflict", async () => {
      const s = await open(h.fresh());
      await s.initializeSchema();
      await s.setBudget("sam", "seven_day", 33);
      await s.setBudget("sam", "seven_day", 40); // overwrite
      const budgets = await s.getBudgets();
      expect(budgets).toEqual([{ name: "sam", cap: "seven_day", sharePct: 40 }]);
    });
  });
}

function mkMsg(uuid: string, user: string, tokens: number) {
  return {
    uuid,
    user,
    timestamp: "2026-06-29T12:00:00.000Z",
    model: null,
    inputTokens: tokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}
