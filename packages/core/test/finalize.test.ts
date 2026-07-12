import { afterEach, describe, it, expect } from "vitest";
import { emptyBatch } from "../src/storage/storage.js";
import { StorageIngestSink } from "../src/backend/storage.js";
import { HistoryFinalizer } from "../src/backend/finalizer.js";
import type { CapKind, TickBatch, UsageSample } from "../src/types.js";
import { closeStorages, freshStorage } from "./libsql.js";

afterEach(closeStorages);

const sample = (cap: CapKind, pct: number, capturedAt: string): UsageSample => ({
  cap,
  pct,
  resetsAt: null,
  capturedAt,
});
const msg = (uuid: string, user: string, timestamp: string) => ({
  uuid,
  user,
  timestamp,
  model: null,
  inputTokens: 0,
  outputTokens: 10,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
});

describe("window finalization → history", () => {
  it("freezes a closed window past the grace, attributing its shares", async () => {
    const s = await freshStorage();
    await s.initializeSchema("acc");
    let clock = Date.parse("2026-06-29T10:00:00.000Z");
    const sink = new StorageIngestSink(s, {
      now: () => clock,
      graceMs: 60_000,
      finalizeIntervalMs: 0,
    });
    await sink.bootstrap();
    const send = (b: Partial<TickBatch>) =>
      sink.ingest(
        { ...emptyBatch(), ...b },
        { at: new Date(clock).toISOString(), accountId: "acc" }
      );

    // Window 1: rises 10→30→50, alice drives the first rise, bob the second.
    await send({
      samples: [
        sample("five_hour", 10, "2026-06-29T10:00:00.000Z"),
        sample("five_hour", 30, "2026-06-29T10:01:00.000Z"),
        sample("five_hour", 50, "2026-06-29T10:02:00.000Z"),
      ],
      messages: [
        msg("a1", "alice", "2026-06-29T10:00:30.000Z"),
        msg("b1", "bob", "2026-06-29T10:01:30.000Z"),
      ],
    });

    // Reset closes window 1 and opens window 2.
    await send({
      resets: [{ cap: "five_hour", at: "2026-06-29T10:05:00.000Z", previousPct: 50 }],
      samples: [sample("five_hour", 2, "2026-06-29T10:05:01.000Z")],
    });

    // Nothing frozen yet (inside grace).
    expect(await s.getHistoryWindows("five_hour")).toHaveLength(0);

    // Advance past the grace and touch the sink → the window freezes.
    clock = Date.parse("2026-06-29T10:40:00.000Z");
    await send({});

    const windows = await s.getHistoryWindows("five_hour");
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      cap: "five_hour",
      windowStart: "2026-06-29T10:00:00.000Z",
      windowEnd: "2026-06-29T10:05:00.000Z",
      overall: 50,
    });

    const shares = await s.getHistoryShares("five_hour", "2026-06-29T10:00:00.000Z");
    const by = Object.fromEntries(shares.map((x) => [x.user, x.pct]));
    expect(by.alice).toBeCloseTo(20);
    expect(by.bob).toBeCloseTo(20);
    expect(by.unknown).toBeCloseTo(10); // baseline
    expect(shares.reduce((n, x) => n + x.pct, 0)).toBeCloseTo(50); // sums to overall

    // Idempotent: a later touch doesn't duplicate or mutate the frozen window.
    clock = Date.parse("2026-06-29T11:00:00.000Z");
    await send({});
    expect(await s.getHistoryWindows("five_hour")).toHaveLength(1);
  });

  it("freezes on a read-path tick after the group stops ingesting", async () => {
    // Sink and read path share ONE finalizer (as the server composes per tenant).
    const s = await freshStorage();
    await s.initializeSchema("acc");
    let clock = Date.parse("2026-06-29T10:00:00.000Z");
    const finalizer = new HistoryFinalizer(s, {
      now: () => clock,
      graceMs: 60_000,
      finalizeIntervalMs: 0,
    });
    const sink = new StorageIngestSink(s, { now: () => clock, finalizer });
    await sink.bootstrap();
    const send = (b: Partial<TickBatch>) =>
      sink.ingest(
        { ...emptyBatch(), ...b },
        { at: new Date(clock).toISOString(), accountId: "acc" }
      );

    // A window is driven, then a reset closes it — and the group goes silent.
    await send({
      samples: [
        sample("five_hour", 10, "2026-06-29T10:00:00.000Z"),
        sample("five_hour", 40, "2026-06-29T10:01:00.000Z"),
      ],
      messages: [msg("a1", "alice", "2026-06-29T10:00:30.000Z")],
    });
    await send({
      resets: [{ cap: "five_hour", at: "2026-06-29T10:05:00.000Z", previousPct: 40 }],
      samples: [sample("five_hour", 2, "2026-06-29T10:05:01.000Z")],
    });

    // No more ingest ever comes. Time passes beyond the grace period.
    clock = Date.parse("2026-06-29T10:40:00.000Z");
    // Nothing ingested to trigger a freeze — the ingest path would never fire again.
    expect(await s.getHistoryWindows("five_hour")).toHaveLength(0);

    // A read-path tick (what GET /v1/view and /v1/history do) freezes it with no ingest.
    await finalizer.maybeFinalize(clock);

    const windows = await s.getHistoryWindows("five_hour");
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      windowStart: "2026-06-29T10:00:00.000Z",
      windowEnd: "2026-06-29T10:05:00.000Z",
      overall: 40,
    });
    const shares = await s.getHistoryShares("five_hour", "2026-06-29T10:00:00.000Z");
    expect(shares.reduce((n, x) => n + x.pct, 0)).toBeCloseTo(40);
  });
});
