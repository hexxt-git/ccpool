import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { AuthResponse, SharedView } from "@ccshare/core";
import { makeApp } from "../src/app.js";
import { PgRegistry } from "../src/registry-pg.js";
import { PgTenantProvider } from "../src/tenants-pg.js";

/**
 * Full server against a real Postgres: registry tables + schema-per-group
 * ledgers. Gated by CCSHARE_TEST_PG_URL (CI provides one), like the storage
 * contract. Registry tables land in a throwaway schema via search_path so runs
 * don't collide; group schemas are dropped afterwards.
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
    const createdSchemas: string[] = [];
    let registry: PgRegistry;
    let tenants: PgTenantProvider;

    afterAll(async () => {
      await registry?.close();
      await tenants?.close();
      const admin = postgres(url);
      for (const s of createdSchemas) {
        await admin.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${regSchema}" CASCADE`);
      await admin.end();
    });

    it("creates a group, ingests, and serves the cached view end to end", async () => {
      const admin = postgres(url);
      await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS "${regSchema}"`);
      await admin.end();

      registry = new PgRegistry(withSearchPath(url));
      tenants = new PgTenantProvider(url);
      await registry.ensure();
      const app = makeApp({ registry, tenants });

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
      createdSchemas.push("grp_" + auth.groupId.replaceAll("-", ""));

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
  });
} else {
  describe("server against Postgres", () => {
    it.skip("set CCSHARE_TEST_PG_URL to run the server Postgres integration", () => {});
  });
}
