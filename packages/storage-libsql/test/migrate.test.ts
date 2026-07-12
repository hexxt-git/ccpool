import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@ccpool/core";
import { LibsqlStorage } from "../src/index.js";

// A faithful forward-migration test: hand-build a *legacy v1* database — the
// ledger tables that existed before history, a ccpool_meta row stamped
// schemaVersion=1, and NO history tables — then prove migrate(SCHEMA_VERSION)
// heals it forward: it adds the history tables and bumps the version without
// disturbing the account binding, and history reads/writes work afterward.
const clients: Client[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

async function legacyV1Db(groupId: string): Promise<{ client: Client; storage: LibsqlStorage }> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  await client.batch(
    [
      `CREATE TABLE ccpool_meta (
         group_id TEXT PRIMARY KEY, app TEXT NOT NULL, schemaVersion INTEGER NOT NULL,
         projectId TEXT NOT NULL, createdAt TEXT NOT NULL, accountId TEXT,
         writeSeq INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE usage_samples (
         group_id TEXT NOT NULL, cap TEXT NOT NULL, pct REAL NOT NULL,
         resetsAt TEXT, capturedAt TEXT NOT NULL)`,
      `CREATE TABLE reset_events (
         group_id TEXT NOT NULL, cap TEXT NOT NULL, at TEXT NOT NULL, previousPct REAL NOT NULL)`,
      {
        sql: `INSERT INTO ccpool_meta (group_id, app, schemaVersion, projectId, createdAt, accountId, writeSeq)
              VALUES (?, 'ccpool', 1, 'proj', ?, 'acc-legacy', 3)`,
        args: [groupId, new Date().toISOString()],
      },
    ],
    "write"
  );
  return { client, storage: new LibsqlStorage(client, groupId) };
}

const window = {
  cap: "five_hour" as const,
  windowStart: "2026-06-29T00:00:00.000Z",
  windowEnd: "2026-06-29T05:00:00.000Z",
  overall: 80,
  closedAt: "2026-06-29T05:30:00.000Z",
};
const shares = [
  { cap: "five_hour" as const, windowStart: "2026-06-29T00:00:00.000Z", user: "alice", pct: 80 },
];

describe("migrate: legacy v1 → current", () => {
  it("reports v1, then heals in the history tables and bumps to the current version", async () => {
    const { storage } = await legacyV1Db("g");

    // Reads as a bound v1 ledger.
    expect(await storage.inspect()).toMatchObject({
      kind: "ccpool",
      schemaVersion: 1,
      accountId: "acc-legacy",
    });
    // History doesn't exist yet — writing one fails.
    await expect(storage.recordHistoryWindow(window, shares)).rejects.toThrow();

    await storage.migrate(SCHEMA_VERSION);

    // Version advanced; the account binding survived untouched.
    expect(await storage.inspect()).toMatchObject({
      kind: "ccpool",
      schemaVersion: SCHEMA_VERSION,
      accountId: "acc-legacy",
    });
    // The change token still reads (writeSeq preserved from the legacy row).
    expect(await storage.getChangeToken()).toBe("3");

    // History now works end to end.
    await storage.recordHistoryWindow(window, shares);
    const windows = await storage.getHistoryWindows("five_hour");
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ windowStart: "2026-06-29T00:00:00.000Z", overall: 80 });
    expect(await storage.getHistoryShares("five_hour", "2026-06-29T00:00:00.000Z")).toEqual(shares);
  });

  it("is idempotent — a second migrate is a harmless no-op", async () => {
    const { storage } = await legacyV1Db("g2");
    await storage.migrate(SCHEMA_VERSION);
    await storage.migrate(SCHEMA_VERSION); // must not throw or clobber
    await storage.recordHistoryWindow(window, shares);
    await storage.recordHistoryWindow(window, shares); // frozen: first write wins
    expect(await storage.getHistoryWindows("five_hour")).toHaveLength(1);
    expect(await storage.inspect()).toMatchObject({ schemaVersion: SCHEMA_VERSION });
  });
});
