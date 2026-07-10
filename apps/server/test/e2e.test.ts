import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { CcshareClient, HttpIngestSink, HttpViewSource } from "@ccshare/core";
import { Daemon } from "@ccshare/daemon";
import { makeApp } from "../src/app.js";
import type { ServerDeps } from "../src/deps.js";
import { makeTestDeps } from "./helpers.js";

/**
 * The full client-to-server loop over a real socket, zero infrastructure: a
 * daemon observes a fixture transcript + a stubbed usage poll, writes through
 * HttpIngestSink to the served app (a libSQL `:memory:` database), and
 * HttpViewSource reads the attributed view back — daemon → server → view end to
 * end.
 */

// Anchored to the current time, not a fixed date: the server rolls members up
// over a 7-day window from real `Date.now()`, so a hardcoded past timestamp
// would silently age out of the window and fail this test 7 days later.
const NOW = Date.now() - 60_000;
const ACCOUNT = "acc-e2e-1";

let server: ServerType;
let baseUrl: string;
let deps: ServerDeps;

beforeAll(async () => {
  deps = await makeTestDeps();
  const app = makeApp(deps);
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      baseUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  server.close();
  await deps.tenants.close();
  await deps.db.close();
  delete process.env.CLAUDE_CONFIG_DIR;
});

function fixtureConfigDir(): string {
  const root = mkdtempSync(join(tmpdir(), "ccshare-e2e-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: NOW + 3_600_000 } })
  );
  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT, emailAddress: "a@b.c" } })
  );
  return configDir;
}

function writeTranscript(configDir: string): void {
  const proj = join(configDir, "projects", "p");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "s.jsonl"),
    JSON.stringify({
      type: "assistant",
      requestId: "req-e2e-1",
      timestamp: new Date(NOW).toISOString(),
      message: {
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
      },
    }) + "\n"
  );
}

describe("client to server end to end", () => {
  it("daemon tick → POST /v1/ingest → GET /v1/view shows the member's usage", async () => {
    const auth = await new CcshareClient(baseUrl).createGroup({
      accountId: ACCOUNT,
      groupPassword: "group-pw-1",
      memberName: "sam",
      memberPassword: "sam-pw-11",
    });

    const configDir = fixtureConfigDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const paths = {
      pidFile: join(configDir, "d.pid"),
      stateFile: join(configDir, "state.json"),
      logFile: join(configDir, "d.log"),
    };
    const pollBody = { five_hour: { utilization: 42, resets_at: null } };
    const daemon = new Daemon({
      sink: new HttpIngestSink(baseUrl, auth.token),
      paths,
      configDir,
      name: "sam",
      pollIntervalMs: 60_000,
      now: () => NOW,
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify(pollBody), { status: 200 })
      ) as unknown as typeof fetch,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    await daemon.tick(); // baselines the reader, ships the first samples
    writeTranscript(configDir);
    await daemon.tick(); // ships the transcript message

    const source = new HttpViewSource(baseUrl, auth.token);
    const view = await source.fetchView();
    expect(view.samples).toEqual([expect.objectContaining({ cap: "five_hour", pct: 42 })]);
    expect(view.members).toEqual([expect.objectContaining({ user: "sam", tokens: 100 })]);
    expect(view.users.map((u) => u.name)).toEqual(["sam"]);

    // steady-state poll: nothing changed -> the 304 path hands back the cache
    const again = await source.fetchView();
    expect(again).toBe(view);
  });

  it("a daemon under the WRONG account gets 409s and never lands in the ledger", async () => {
    const login = await new CcshareClient(baseUrl).login({
      accountId: ACCOUNT,
      memberName: "sam",
      memberPassword: "sam-pw-11",
    });
    const sink = new HttpIngestSink(baseUrl, login.token);
    await expect(
      sink.ingest(
        {
          samples: [
            { cap: "five_hour", pct: 99, resetsAt: null, capturedAt: new Date(NOW).toISOString() },
          ],
          resets: [],
          messages: [],
          markers: [],
        },
        { at: new Date(NOW).toISOString(), accountId: "acc-SOMEONE-ELSE" }
      )
    ).rejects.toThrow(/account/i);

    const view = await new HttpViewSource(baseUrl, login.token).fetchView();
    expect(view.samples.find((s) => s.pct === 99)).toBeUndefined();
  });
});
