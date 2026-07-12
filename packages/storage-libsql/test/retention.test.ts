import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { LibsqlRegistry } from "../src/index.js";

// deleteStaleTokens keys off COALESCE(lastUsedAt, createdAt). Real timestamps
// can't be forced through the registry API (insert/touch both stamp "now"), so
// this drives a raw client with hand-set timestamps to pin the precedence rule:
// a recent lastUsedAt keeps a token even when its createdAt is ancient.
const clients: Client[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

async function freshTokens(): Promise<{ client: Client; reg: LibsqlRegistry }> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  await client.execute(
    `CREATE TABLE tokens (
       tokenHash TEXT PRIMARY KEY, memberId TEXT NOT NULL,
       createdAt TEXT NOT NULL, lastUsedAt TEXT
     )`
  );
  return { client, reg: new LibsqlRegistry(client) };
}

const insert = (client: Client, hash: string, createdAt: string, lastUsedAt: string | null) =>
  client.execute({
    sql: `INSERT INTO tokens (tokenHash, memberId, createdAt, lastUsedAt) VALUES (?, 'm', ?, ?)`,
    args: [hash, createdAt, lastUsedAt],
  });

describe("deleteStaleTokens (bearer retention)", () => {
  it("sweeps by COALESCE(lastUsedAt, createdAt), keeping recently-used tokens", async () => {
    const { client, reg } = await freshTokens();
    // never used, ancient createdAt → swept (createdAt drives it)
    await insert(client, "never-used-old", "2020-01-01T00:00:00.000Z", null);
    // ancient createdAt but used recently → kept (lastUsedAt wins over createdAt)
    await insert(client, "old-but-active", "2020-01-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
    // freshly created, never used → kept
    await insert(client, "recent", "2026-07-10T00:00:00.000Z", null);

    const removed = await reg.deleteStaleTokens("2026-01-01T00:00:00.000Z");
    expect(removed).toBe(1);

    const { rows } = await client.execute(`SELECT tokenHash FROM tokens ORDER BY tokenHash`);
    expect(rows.map((r) => String(r.tokenHash))).toEqual(["old-but-active", "recent"]);
  });

  it("removes nothing when the cutoff predates every token", async () => {
    const { client, reg } = await freshTokens();
    await insert(client, "a", "2026-07-01T00:00:00.000Z", null);
    await insert(client, "b", "2026-07-02T00:00:00.000Z", "2026-07-03T00:00:00.000Z");
    expect(await reg.deleteStaleTokens("2000-01-01T00:00:00.000Z")).toBe(0);
    const { rows } = await client.execute(`SELECT COUNT(*) AS n FROM tokens`);
    expect(Number(rows[0]!.n)).toBe(2);
  });
});
