import { describe, expect, it } from "vitest";
import {
  computeSharedView,
  LedgerWindow,
  MemoryStorage,
  StorageIngestSink,
  StorageViewSource,
  type CapKind,
  type SharedView,
  type TickBatch,
} from "../src/index.js";
import { emptyBatch } from "../src/storage/storage.js";

/**
 * The LedgerWindow equivalence suite: the windowed view path (hydrate once,
 * append per ingest, prune mirroring) must produce the SAME SharedView as the
 * full storage scan, at every point in a ledger's life. Row *values* must match
 * exactly; only array order within a view is normalized (attribution is
 * order-independent for distinct timestamps, which every fixture uses).
 */

const NOW = Date.parse("2026-06-29T20:00:00.000Z");
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function sample(cap: CapKind, pct: number, msAgo: number) {
  return { cap, pct, resetsAt: null, capturedAt: at(msAgo) };
}

function msg(uuid: string, user: string, msAgo: number, model: string | null = null, tokens = 10) {
  return {
    uuid,
    user,
    timestamp: at(msAgo),
    model,
    inputTokens: tokens,
    outputTokens: tokens,
    cacheCreationTokens: tokens,
    cacheReadTokens: tokens,
  };
}

function batchOf(partial: Partial<TickBatch>): TickBatch {
  return { ...emptyBatch(), ...partial };
}

/** A ledger with activity across caps, users, resets, and markers. */
function seedBatches(): TickBatch[] {
  return [
    batchOf({
      samples: [
        sample("five_hour", 10, 3 * HOUR),
        sample("seven_day", 50, 3 * HOUR),
        // this cap's ONLY reading is older than the 7-day window — it must
        // still surface via `latest` and attribute to unknown, in both paths
        sample("seven_day_opus", 33, 7 * DAY + 5 * HOUR),
      ],
      resets: [{ cap: "five_hour", at: at(4 * HOUR), previousPct: 90 }],
    }),
    batchOf({
      messages: [
        msg("m-sam-1", "sam", 2.6 * HOUR, "claude-opus-4-8", 30),
        msg("m-alex-1", "alex", 2.5 * HOUR, "claude-sonnet-4-6", 10),
      ],
      markers: [{ id: "k1", user: "sam", at: at(2.4 * HOUR), model: null, weight: 5 }],
    }),
    batchOf({
      samples: [sample("five_hour", 22, 2 * HOUR), sample("seven_day", 57, 2 * HOUR)],
      messages: [msg("m-sam-2", "sam", 1.5 * HOUR, "claude-opus-4-8", 20)],
    }),
    batchOf({
      samples: [sample("five_hour", 31, 1 * HOUR), sample("seven_day", 60, 1 * HOUR)],
    }),
  ];
}

function normalized(v: SharedView): SharedView {
  return {
    ...v,
    shares: [...v.shares].sort(
      (a, b) => a.cap.localeCompare(b.cap) || a.user.localeCompare(b.user)
    ),
    members: [...v.members].sort((a, b) => a.user.localeCompare(b.user)),
  };
}

async function expectEquivalent(
  source: StorageViewSource,
  storage: MemoryStorage,
  now: number
): Promise<void> {
  const windowed = await source.fetchView(now);
  const fullScan = await computeSharedView(storage, now);
  expect(normalized(windowed)).toEqual(normalized(fullScan));
  // sanity: the fixtures actually exercise attribution, not an empty view
  expect(fullScan.shares.length).toBeGreaterThan(0);
}

interface Composed {
  storage: MemoryStorage;
  window: LedgerWindow;
  sink: StorageIngestSink;
  source: StorageViewSource;
}

function compose(
  storage = new MemoryStorage(),
  sinkOpts: { pruneIntervalMs?: number; now?: () => number } = {}
): Composed {
  const window = new LedgerWindow(storage);
  return {
    storage,
    window,
    sink: new StorageIngestSink(storage, { ...sinkOpts, window }),
    source: new StorageViewSource(storage, { window }),
  };
}

const meta = { at: at(0), accountId: "acc-1" };

describe("LedgerWindow equivalence with the full storage scan", () => {
  it("hydrate-only: a pre-existing ledger reads identically at several nows", async () => {
    const { storage, source } = compose();
    await storage.initializeSchema("acc-1");
    await storage.upsertUser("sam");
    await storage.upsertUser("alex");
    for (const b of seedBatches()) await storage.recordBatch(b);

    await expectEquivalent(source, storage, NOW);
    await expectEquivalent(source, storage, NOW + 61_000); // next cache bucket
    await expectEquivalent(source, storage, NOW + 6 * HOUR); // window slides
  });

  it("hydrate + append: ingested ticks land in both paths identically", async () => {
    const { storage, sink, source } = compose();
    await storage.initializeSchema("acc-1");
    const [first, ...rest] = seedBatches();
    await sink.ingest(first!, meta); // window idle — dropped, hydration covers it
    await expectEquivalent(source, storage, NOW); // hydrates here
    let bump = 0;
    for (const b of rest) {
      await sink.ingest(b, meta); // window ready — appended
      await expectEquivalent(source, storage, NOW + ++bump * 61_000);
    }
  });

  it("a retried batch with mutated values keeps the first write, like the DB", async () => {
    const { storage, sink, source } = compose();
    await storage.initializeSchema("acc-1");
    const original = batchOf({
      samples: [sample("five_hour", 10, 2 * HOUR), sample("five_hour", 25, 1 * HOUR)],
      messages: [msg("m-retry", "sam", 1.5 * HOUR, null, 30)],
    });
    await sink.ingest(original, meta);
    await expectEquivalent(source, storage, NOW); // hydrated

    // The re-send carries DIFFERENT values under the same natural keys — the
    // DB's ON CONFLICT DO NOTHING keeps the originals, so the window must too.
    const mutated = batchOf({
      samples: [{ ...original.samples[1]!, pct: 999 }],
      messages: [{ ...original.messages[0]!, inputTokens: 999_999 }],
    });
    await sink.ingest(mutated, meta);
    await expectEquivalent(source, storage, NOW + 61_000);
    const view = await source.fetchView(NOW + 61_000);
    expect(view.samples.find((s) => s.cap === "five_hour")?.pct).toBe(25); // not 999
  });

  it("prune parity: the window drops exactly what the DB drops", async () => {
    let t = NOW;
    const { storage, sink, source } = compose(new MemoryStorage(), {
      pruneIntervalMs: 1000,
      now: () => t,
    });
    await storage.initializeSchema("acc-1");
    for (const b of seedBatches()) await sink.ingest(b, meta);
    await expectEquivalent(source, storage, t); // hydrated; opus cap present via `latest`
    expect((await source.fetchView(t)).samples.some((s) => s.cap === "seven_day_opus")).toBe(true);

    // Advance past the prune interval; the next ingest sweeps rows older than
    // the retention window (8 days) — including the opus cap's only sample.
    t = NOW + 2 * DAY;
    await sink.ingest(
      batchOf({
        samples: [{ cap: "five_hour", pct: 40, resetsAt: null, capturedAt: at(-2 * DAY) }],
      }),
      meta
    );
    await expectEquivalent(source, storage, t);
    expect((await source.fetchView(t)).samples.some((s) => s.cap === "seven_day_opus")).toBe(false);
  });

  it("eviction/re-hydrate: a fresh window over the same storage reads identically", async () => {
    const { storage, sink, source } = compose();
    await storage.initializeSchema("acc-1");
    for (const b of seedBatches()) await sink.ingest(b, meta);
    await expectEquivalent(source, storage, NOW);

    // "Eviction": the tenant (window + sources) is dropped and rebuilt.
    const rebuilt = compose(storage);
    await expectEquivalent(rebuilt.source, storage, NOW + 61_000);
  });

  it("append-during-hydration: a batch racing the hydration read is buffered, not lost", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    class GatedStorage extends MemoryStorage {
      override async getUsageSamplesSince(since: string) {
        await gate;
        return super.getUsageSamplesSince(since);
      }
    }
    const storage = new GatedStorage();
    const { sink, source } = compose(storage);
    await storage.initializeSchema("acc-1");
    const [first, second, ...rest] = seedBatches();
    await storage.recordBatch(first!);

    const inFlight = source.fetchView(NOW); // hydration starts, blocked on the gate
    await sink.ingest(second!, meta); // commits + buffers into the hydrating window
    release();
    const view = await inFlight;
    // The buffered batch is in the hydrated snapshot, identical to a full scan.
    expect(normalized(view)).toEqual(normalized(await computeSharedView(storage, NOW)));
    expect(view.members.map((m) => m.user).sort()).toEqual(["alex", "sam"]);

    for (const b of rest) await sink.ingest(b, meta);
    await expectEquivalent(source, storage, NOW + 61_000);
  });

  it("idle-drop: a tick ingested before any view read is not lost", async () => {
    const { storage, sink, source } = compose();
    await storage.initializeSchema("acc-1");
    for (const b of seedBatches()) await sink.ingest(b, meta); // window idle throughout
    await expectEquivalent(source, storage, NOW); // first read hydrates everything
  });
});
