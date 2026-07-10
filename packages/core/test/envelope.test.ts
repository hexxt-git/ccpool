import { afterEach, describe, it, expect } from "vitest";
import { emptyBatch } from "../src/storage/storage.js";
import { StorageIngestSink } from "../src/backend/storage.js";
import type { CapKind, TickBatch, UsageSample } from "../src/types.js";
import { closeStorages, freshStorage } from "./libsql.js";

afterEach(closeStorages);

const sample = (cap: CapKind, pct: number, capturedAt: string): UsageSample => ({
  cap,
  pct,
  resetsAt: null,
  capturedAt,
});
const at = (m: number) => `2026-06-29T10:${String(m).padStart(2, "0")}:00.000Z`;

async function freshSink() {
  const s = await freshStorage();
  await s.initializeSchema("acc");
  const sink = new StorageIngestSink(s);
  await sink.bootstrap();
  const send = (b: Partial<TickBatch>, t = at(59)) =>
    sink.ingest({ ...emptyBatch(), ...b }, { at: t, accountId: "acc" });
  const stored = async () =>
    (await s.getUsageSamplesSince("2000-01-01T00:00:00.000Z")).map((x) => x.pct);
  return { s, send, stored };
}

describe("envelope filter (sink)", () => {
  it("stores only envelope-raising samples — flats and dips are dropped", async () => {
    const { send, stored } = await freshSink();
    await send({
      samples: [
        sample("five_hour", 10, at(0)),
        sample("five_hour", 10, at(1)), // flat
        sample("five_hour", 25, at(2)), // rise
        sample("five_hour", 20, at(3)), // dip (skew/wobble)
        sample("five_hour", 25, at(4)), // flat at max
        sample("five_hour", 40, at(5)), // rise
      ],
    });
    expect(await stored()).toEqual([10, 25, 40]);
  });

  it("restarts the envelope after a reset, keeping the post-reset baseline", async () => {
    const { send, stored } = await freshSink();
    await send({ samples: [sample("five_hour", 80, "2026-06-29T10:00:00.000Z")] });
    await send({
      resets: [{ cap: "five_hour", at: "2026-06-29T15:00:00.000Z", previousPct: 80 }],
      samples: [
        sample("five_hour", 3, "2026-06-29T15:00:01.000Z"), // new floor
        sample("five_hour", 12, "2026-06-29T15:05:00.000Z"), // rise
      ],
    });
    expect(await stored()).toEqual([80, 3, 12]);
  });

  it("a flat no-op tick writes nothing (change token unmoved)", async () => {
    const { s, send } = await freshSink();
    await send({ samples: [sample("five_hour", 10, at(0))] });
    const tok = await s.getChangeToken();
    await send({ samples: [sample("five_hour", 10, at(1))] }); // flat — elided
    expect(await s.getChangeToken()).toBe(tok);
  });

  it("collapses a second machine reporting a level the tank already reached", async () => {
    const { send, stored } = await freshSink();
    // Two members' interleaved streams of the one global tank.
    await send({
      samples: [
        sample("five_hour", 30, at(0)),
        sample("five_hour", 30, at(0).replace("00.000", "30.000")),
      ],
    });
    expect(await stored()).toEqual([30]);
  });
});
