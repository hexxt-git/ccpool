import { afterAll, describe, expect, it } from "vitest";
import type { Storage } from "../src/index.js";

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
      const msgs = await s.getMessageUsageSince("2026-06-29T00:00:00.000Z");
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.inputTokens).toBe(1);
    });

    it("returns the sample trajectory since a cutoff, ascending", async () => {
      const s = await open(h.fresh());
      await s.initializeSchema();
      await s.recordUsageSample(mkSample("five_hour", 10, "2026-06-29T10:00:00.000Z"));
      await s.recordUsageSample(mkSample("five_hour", 30, "2026-06-29T11:00:00.000Z"));
      await s.recordUsageSample(mkSample("five_hour", 5, "2026-06-29T08:00:00.000Z"));
      const traj = await s.getUsageSamplesSince("2026-06-29T09:00:00.000Z");
      expect(traj.map((x) => x.pct)).toEqual([10, 30]); // 08:00 excluded, ascending
    });

    it("returns measured messages since a cutoff", async () => {
      const s = await open(h.fresh());
      await s.initializeSchema();
      await s.recordMessageUsage([mkMsg("a", "sam", 30, "2026-06-29T12:00:00.000Z")]);
      await s.recordMessageUsage([mkMsg("b", "alex", 10, "2026-06-28T12:00:00.000Z")]);
      const msgs = await s.getMessageUsageSince("2026-06-29T00:00:00.000Z");
      expect(msgs.map((m) => m.uuid).sort()).toEqual(["a"]);
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

function mkMsg(uuid: string, user: string, tokens: number, timestamp = "2026-06-29T12:00:00.000Z") {
  return {
    uuid,
    user,
    timestamp,
    model: null,
    inputTokens: tokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}

function mkSample(
  cap: "five_hour" | "seven_day" | "seven_day_opus",
  pct: number,
  capturedAt: string
) {
  return { cap, pct, resetsAt: null, capturedAt };
}
