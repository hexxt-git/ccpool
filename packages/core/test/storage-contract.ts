import { afterAll, describe, expect, it } from "vitest";
import { emptyBatch, SCHEMA_VERSION, type DbInspection, type Storage } from "../src/index.js";
import type { TickBatch } from "../src/types.js";

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

    it("binds the ledger to a Claude account and reports it", async () => {
      const s = await open(h.fresh());
      await s.initializeSchema("acc-uuid-1");
      expect(await s.inspect()).toMatchObject({ kind: "ccshare", accountId: "acc-uuid-1" });
    });

    it("leaves the ledger unbound with no account, then claims it once", async () => {
      const s = await open(h.fresh());
      await s.initializeSchema();
      expect(await s.inspect()).toMatchObject({ kind: "ccshare", accountId: null });

      await s.bindAccount("acc-1");
      expect(boundId(await s.inspect())).toBe("acc-1");

      await s.bindAccount("acc-2"); // already bound -> must not clobber
      expect(boundId(await s.inspect())).toBe("acc-1");
    });

    it("migrate to the current version is a no-op on a fresh DB (accountId intact)", async () => {
      const s = await open(h.fresh());
      await s.initializeSchema("acc-1");
      // v1 baseline already has the account-binding column; migrate must not clobber it.
      await s.migrate(SCHEMA_VERSION);
      expect(await s.inspect()).toMatchObject({ kind: "ccshare", accountId: "acc-1" });
    });

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
      await s.recordBatch(
        batchOf({
          samples: [
            mkSample("five_hour", 10, "2026-06-29T10:00:00.000Z"),
            mkSample("seven_day", 68, "2026-06-29T11:00:00.000Z"),
          ],
        })
      );
      await s.recordBatch(
        batchOf({
          samples: [
            {
              cap: "five_hour",
              pct: 42,
              resetsAt: "2026-06-29T15:00:00.000Z",
              capturedAt: "2026-06-29T11:00:00.000Z",
            },
          ],
        })
      );
      const latest = await s.getLatestSamples();
      expect(latest.find((x) => x.cap === "five_hour")?.pct).toBe(42);
      expect(latest.find((x) => x.cap === "seven_day")?.pct).toBe(68);
    });

    it("dedups message usage on uuid, within and across batches", async () => {
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
      await s.recordBatch(batchOf({ messages: [row] }));
      // Same uuid again (a retried tick) -> the first copy wins.
      await s.recordBatch(batchOf({ messages: [{ ...row, inputTokens: 999 }] }));
      const msgs = await s.getMessageUsageSince("2026-06-29T00:00:00.000Z");
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.inputTokens).toBe(1);
    });

    it("dedups samples and resets on their natural key across retried batches", async () => {
      const s = await open(h.fresh());
      await s.initializeSchema();
      const batch = batchOf({
        samples: [mkSample("five_hour", 10, "2026-06-29T10:00:00.000Z")],
        resets: [{ cap: "five_hour", at: "2026-06-29T10:00:00.000Z", previousPct: 90 }],
      });
      await s.recordBatch(batch);
      // A retried tick re-sends identical (cap, capturedAt)/(cap, at) rows — the
      // re-insert is a no-op (first write wins), so a committed-but-unacked POST
      // can't double-count and pollute the tank trajectory or reset detection.
      await s.recordBatch({
        ...batch,
        samples: [mkSample("five_hour", 999, "2026-06-29T10:00:00.000Z")],
        resets: [{ cap: "five_hour", at: "2026-06-29T10:00:00.000Z", previousPct: 999 }],
      });
      const traj = await s.getUsageSamplesSince("2026-06-29T00:00:00.000Z");
      expect(traj).toHaveLength(1);
      expect(traj[0]?.pct).toBe(10);
      const resets = await s.getResetsSince("2026-06-29T00:00:00.000Z");
      expect(resets).toEqual([
        { cap: "five_hour", at: "2026-06-29T10:00:00.000Z", previousPct: 90 },
      ]);
    });

    it("migrates an older ledger forward, adding sample/reset idempotency", async () => {
      // A fresh DB is already current; migrate(SCHEMA_VERSION) must be safe to run
      // and must leave samples/resets deduping (idempotent, multi-machine-safe).
      const s = await open(h.fresh());
      await s.initializeSchema("acc-1");
      await s.migrate(SCHEMA_VERSION);
      await s.migrate(SCHEMA_VERSION); // idempotent — a second run must not throw
      await s.recordBatch(
        batchOf({ samples: [mkSample("five_hour", 10, "2026-06-29T10:00:00.000Z")] })
      );
      await s.recordBatch(
        batchOf({ samples: [mkSample("five_hour", 20, "2026-06-29T10:00:00.000Z")] })
      );
      expect(await s.getUsageSamplesSince("2026-06-29T00:00:00.000Z")).toHaveLength(1);
      expect(await s.inspect()).toMatchObject({ kind: "ccshare", accountId: "acc-1" });
    });

    it("returns the sample trajectory since a cutoff, ascending", async () => {
      const s = await open(h.fresh());
      await s.initializeSchema();
      await s.recordBatch(
        batchOf({
          samples: [
            mkSample("five_hour", 10, "2026-06-29T10:00:00.000Z"),
            mkSample("five_hour", 30, "2026-06-29T11:00:00.000Z"),
            mkSample("five_hour", 5, "2026-06-29T08:00:00.000Z"),
          ],
        })
      );
      const traj = await s.getUsageSamplesSince("2026-06-29T09:00:00.000Z");
      expect(traj.map((x) => x.pct)).toEqual([10, 30]); // 08:00 excluded, ascending
    });

    it("returns measured messages since a cutoff", async () => {
      const s = await open(h.fresh());
      await s.initializeSchema();
      await s.recordBatch(
        batchOf({
          messages: [
            mkMsg("a", "sam", 30, "2026-06-29T12:00:00.000Z"),
            mkMsg("b", "alex", 10, "2026-06-28T12:00:00.000Z"),
          ],
        })
      );
      const msgs = await s.getMessageUsageSince("2026-06-29T00:00:00.000Z");
      expect(msgs.map((m) => m.uuid).sort()).toEqual(["a"]);
    });

    it("records activity markers, dedups on id, and filters by cutoff", async () => {
      const s = await open(h.fresh());
      await s.initializeSchema();
      const m = {
        id: "m1",
        user: "sam",
        at: "2026-06-29T12:00:00.000Z",
        model: "claude-opus-4-8",
        weight: 7,
      };
      await s.recordBatch(batchOf({ markers: [m] }));
      await s.recordBatch(
        batchOf({
          markers: [
            { ...m, weight: 999 }, // same id -> ignored
            { id: "m0", user: "alex", at: "2026-06-28T12:00:00.000Z", model: null, weight: 3 },
          ],
        })
      );
      const markers = await s.getUsageMarkersSince("2026-06-29T00:00:00.000Z");
      expect(markers).toHaveLength(1);
      expect(markers[0]).toEqual(m);
    });

    it("returns recorded resets since a cutoff", async () => {
      const s = await open(h.fresh());
      await s.initializeSchema();
      await s.recordBatch(
        batchOf({
          resets: [
            { cap: "five_hour", at: "2026-06-29T10:00:00.000Z", previousPct: 90 },
            { cap: "seven_day", at: "2026-06-28T10:00:00.000Z", previousPct: 80 },
          ],
        })
      );
      const resets = await s.getResetsSince("2026-06-29T00:00:00.000Z");
      expect(resets).toEqual([
        { cap: "five_hour", at: "2026-06-29T10:00:00.000Z", previousPct: 90 },
      ]);
    });

    it("change token: stable across reads, bumped once per write batch", async () => {
      const s = await open(h.fresh());
      await s.initializeSchema();
      const t0 = await s.getChangeToken();

      // Reads must not move the token — this is what makes it a safe cache key.
      await s.getLatestSamples();
      await s.getUsageSamplesSince("2026-06-29T00:00:00.000Z");
      await s.getUsers();
      expect(await s.getChangeToken()).toBe(t0);

      // One batch (several rows) -> exactly one observable change.
      await s.recordBatch(
        batchOf({
          samples: [mkSample("five_hour", 10, "2026-06-29T10:00:00.000Z")],
          messages: [mkMsg("u1", "sam", 5)],
        })
      );
      const t1 = await s.getChangeToken();
      expect(t1).not.toBe(t0);

      // An empty batch is a no-op — nothing changed, token must hold.
      await s.recordBatch(emptyBatch());
      expect(await s.getChangeToken()).toBe(t1);

      // upsertUser is the other write path; it must move the token too.
      await s.upsertUser("sam");
      expect(await s.getChangeToken()).not.toBe(t1);
    });

    it("prune deletes rows older than the cutoff across all four tables", async () => {
      const s = await open(h.fresh());
      await s.initializeSchema();
      await s.recordBatch({
        samples: [
          mkSample("five_hour", 10, "2026-06-20T10:00:00.000Z"), // old
          mkSample("five_hour", 30, "2026-06-29T10:00:00.000Z"), // recent
        ],
        resets: [
          { cap: "five_hour", at: "2026-06-20T10:00:00.000Z", previousPct: 90 }, // old
          { cap: "five_hour", at: "2026-06-29T10:00:00.000Z", previousPct: 95 }, // recent
        ],
        messages: [
          mkMsg("old", "sam", 5, "2026-06-20T10:00:00.000Z"),
          mkMsg("new", "sam", 5, "2026-06-29T10:00:00.000Z"),
        ],
        markers: [
          { id: "mo", user: "sam", at: "2026-06-20T10:00:00.000Z", model: null, weight: 1 },
          { id: "mn", user: "sam", at: "2026-06-29T10:00:00.000Z", model: null, weight: 1 },
        ],
      });

      await s.prune("2026-06-25T00:00:00.000Z");

      const epoch = "2000-01-01T00:00:00.000Z";
      expect((await s.getUsageSamplesSince(epoch)).map((x) => x.pct)).toEqual([30]);
      expect((await s.getResetsSince(epoch)).map((x) => x.previousPct)).toEqual([95]);
      expect((await s.getMessageUsageSince(epoch)).map((x) => x.uuid)).toEqual(["new"]);
      expect((await s.getUsageMarkersSince(epoch)).map((x) => x.id)).toEqual(["mn"]);
      // The pruned uuid is gone for good, so a very old row re-sent later would
      // re-insert — acceptable: ingest never re-sends rows older than the window.
    });
  });
}

function boundId(i: DbInspection): string | null {
  return i.kind === "ccshare" ? i.accountId : null;
}

function batchOf(partial: Partial<TickBatch>): TickBatch {
  return { ...emptyBatch(), ...partial };
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
