import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthResponse, SharedView } from "@ccpool/core";
import { makeApp } from "../src/app.js";
import { makeServerDeps, resolveServerBackend } from "../src/backend.js";
import type { ServerDeps } from "../src/deps.js";

/**
 * Full server over a `file:` libSQL database (throwaway temp dir — no external
 * infra). The rest of the server suite runs on `:memory:`; this one pins the
 * on-disk path: URL normalization + parent-dir creation, and registry tables +
 * per-group ledgers isolated by `group_id` in ONE database.
 */
describe("server on libSQL (file:)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccpool-srv-libsql-"));
  // A nested, not-yet-created subdir: the registry must create the parent dir and
  // normalize the URL before opening it (regression: `file:~/…` / missing dir).
  const url = `file:${join(dir, "nested", "server.db")}`;
  let deps: ServerDeps;

  afterAll(async () => {
    await deps?.tenants.close();
    await deps?.db.close();
  });

  it("reads the connection from DATABASE_URL", () => {
    const backend = resolveServerBackend({ DATABASE_URL: url } as NodeJS.ProcessEnv);
    expect(backend.url).toBe(url);
    expect(backend.authToken).toBeUndefined();
  });

  it("creates two groups, ingests, and isolates their ledgers by group_id", async () => {
    deps = makeServerDeps({ url });
    await deps.db.init();
    const app = makeApp(deps);

    const mk = async (account: string, name: string): Promise<AuthResponse> => {
      const res = await app.request("/v1/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: account,
          groupPassword: "group-pass-1",
          memberName: name,
          memberPassword: "member-pass-1",
        }),
      });
      expect(res.status).toBe(201);
      return (await res.json()) as AuthResponse;
    };

    const a = await mk("acc-a", "alice");
    const b = await mk("acc-b", "bob");

    const ingest = await app.request("/v1/ingest", {
      method: "POST",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        at: new Date().toISOString(),
        accountId: "acc-a",
        samples: [
          { cap: "five_hour", pct: 37, resetsAt: null, capturedAt: new Date().toISOString() },
        ],
        resets: [],
        messages: [
          {
            uuid: "ls-m1",
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

    // A sees its own row, stamped with the authenticated member.
    const aView = (await (
      await app.request("/v1/view", { headers: { authorization: `Bearer ${a.token}` } })
    ).json()) as SharedView;
    expect(aView.samples[0]?.pct).toBe(37);
    expect(aView.members.map((m) => m.user)).toEqual(["alice"]);

    // B's ledger is empty — no leakage across group_id.
    const bView = (await (
      await app.request("/v1/view", { headers: { authorization: `Bearer ${b.token}` } })
    ).json()) as SharedView;
    expect(bView.samples).toEqual([]);
    expect(bView.users.map((u) => u.name)).toEqual(["bob"]);
  }, 30_000);
});
