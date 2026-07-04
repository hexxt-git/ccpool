import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { AuthResponse, SharedView } from "@ccshare/core";
import { makeApp } from "../src/app.js";
import { makeServerDeps } from "../src/backend.js";
import type { ServerDeps } from "../src/deps.js";

/**
 * Full server against a real Postgres: registry tables + per-group ledgers in ONE
 * database, scoped by `group_id`. Gated by CCSHARE_TEST_PG_URL (CI provides one),
 * like the storage contract. Everything lands in a throwaway schema via
 * search_path so runs don't collide; the schema is dropped afterwards.
 */
const url = process.env.CCSHARE_TEST_PG_URL;

if (url) {
  const regSchema = `ccshare_srv_${Date.now()}`;
  const withSearchPath = (base: string): string => {
    const u = new URL(base);
    u.searchParams.set("options", `-c search_path=${regSchema}`);
    return u.toString();
  };

  describe("server against Postgres", () => {
    let deps: ServerDeps;

    afterAll(async () => {
      await deps?.tenants.close();
      await deps?.db.close();
      const admin = postgres(url);
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${regSchema}" CASCADE`);
      await admin.end();
    });

    it("creates a group, ingests, and serves the cached view end to end", async () => {
      const admin = postgres(url);
      await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS "${regSchema}"`);
      await admin.end();

      deps = makeServerDeps({ driver: "postgres", url: withSearchPath(url) });
      await deps.db.init();
      const app = makeApp(deps);

      const account = `acc-${Date.now()}`;
      const created = await app.request("/v1/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: account,
          groupPassword: "group-pass-1",
          memberName: "sam",
          memberPassword: "sam-pass-1",
        }),
      });
      expect(created.status).toBe(201);
      const auth = (await created.json()) as AuthResponse;

      const ingest = await app.request("/v1/ingest", {
        method: "POST",
        headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          at: new Date().toISOString(),
          accountId: account,
          samples: [
            { cap: "five_hour", pct: 37, resetsAt: null, capturedAt: new Date().toISOString() },
          ],
          resets: [],
          messages: [
            {
              uuid: "pg-m1",
              user: "spoofed",
              timestamp: new Date().toISOString(),
              model: null,
              inputTokens: 1,
              outputTokens: 2,
              cacheCreationTokens: 3,
              cacheReadTokens: 4,
            },
          ],
          markers: [],
        }),
      });
      expect(ingest.status).toBe(204);

      const view = await app.request("/v1/view", {
        headers: { authorization: `Bearer ${auth.token}` },
      });
      expect(view.status).toBe(200);
      const body = (await view.json()) as SharedView;
      expect(body.samples[0]?.pct).toBe(37);
      expect(body.members.map((m) => m.user)).toEqual(["sam"]); // stamped, not spoofed
      expect(body.users.map((u) => u.name)).toEqual(["sam"]);

      const etag = view.headers.get("etag")!;
      const cached = await app.request("/v1/view", {
        headers: { authorization: `Bearer ${auth.token}`, "if-none-match": etag },
      });
      expect(cached.status).toBe(304);
    }, 30_000);

    it("isolates two groups' ledgers by group_id in one database", async () => {
      const app = makeApp(deps);
      const mk = async (account: string, name: string): Promise<AuthResponse> => {
        const res = await app.request("/v1/groups", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            accountId: account,
            groupPassword: "grp-pass-xyz",
            memberName: name,
            memberPassword: "member-pass-xyz",
          }),
        });
        expect(res.status).toBe(201);
        return (await res.json()) as AuthResponse;
      };
      const a = await mk(`acc-a-${Date.now()}`, "alice");
      const b = await mk(`acc-b-${Date.now()}`, "bob");

      await app.request("/v1/ingest", {
        method: "POST",
        headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          at: new Date().toISOString(),
          accountId: null,
          samples: [
            { cap: "five_hour", pct: 55, resetsAt: null, capturedAt: new Date().toISOString() },
          ],
          resets: [],
          messages: [],
          markers: [],
        }),
      });

      // B's view must not see A's rows or members.
      const bView = await app.request("/v1/view", {
        headers: { authorization: `Bearer ${b.token}` },
      });
      const body = (await bView.json()) as SharedView;
      expect(body.samples).toEqual([]);
      expect(body.users.map((u) => u.name)).toEqual(["bob"]);
    }, 30_000);
  });
} else {
  describe("server against Postgres", () => {
    it.skip("set CCSHARE_TEST_PG_URL to run the server Postgres integration", () => {});
  });
}
