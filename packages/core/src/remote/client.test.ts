import { describe, expect, it } from "vitest";
import { AccountConflictError } from "../backend/sink.js";
import { ApiRequestError, CcpoolClient, HttpIngestSink, HttpViewSource } from "./client.js";
import type { SharedView } from "../types.js";

const BASE = "http://localhost:9999";

function stubFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: unknown, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers });

describe("CcpoolClient", () => {
  it("posts the request and returns the AuthResponse", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const client = new CcpoolClient(BASE, {
      fetchImpl: stubFetch((url, init) => {
        seen = { url, body: JSON.parse(String(init?.body)) };
        return json({ token: "ccs_t", groupId: "g1", memberName: "sam" });
      }),
    });
    const auth = await client.joinGroup({
      accountId: "acc-1",
      groupPassword: "group-pw-1",
      memberName: "sam",
      memberPassword: "sam-pw-11",
    });
    expect(auth.token).toBe("ccs_t");
    expect(seen!.url).toBe(`${BASE}/v1/groups/join`);
    expect((seen!.body as { memberName: string }).memberName).toBe("sam");
  });

  it("looks up group existence with the accountId in the query", async () => {
    let seenUrl = "";
    const client = new CcpoolClient(BASE, {
      fetchImpl: stubFetch((url) => {
        seenUrl = url;
        return json({ exists: true });
      }),
    });
    const res = await client.lookupGroup("acc-9");
    expect(res.exists).toBe(true);
    expect(seenUrl).toBe(`${BASE}/v1/groups/lookup?accountId=acc-9`);
  });

  it("maps ApiError bodies onto ApiRequestError with the code", async () => {
    const client = new CcpoolClient(BASE, {
      fetchImpl: stubFetch(() => json({ error: "no group", code: "not-found" }, 404)),
    });
    const err = await client
      .login({ accountId: "a", memberName: "sam", memberPassword: "x".repeat(10) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(404);
    expect((err as ApiRequestError).code).toBe("not-found");
    expect((err as ApiRequestError).message).toBe("no group");
  });
});

describe("HttpIngestSink", () => {
  const batch = { samples: [], resets: [], messages: [], markers: [] };

  it("sends one authenticated POST per tick", async () => {
    let auth: string | undefined;
    const sink = new HttpIngestSink(BASE, "ccs_tok", {
      fetchImpl: stubFetch((url, init) => {
        auth = (init?.headers as Record<string, string>).authorization;
        expect(url).toBe(`${BASE}/v1/ingest`);
        return new Response(null, { status: 204 });
      }),
    });
    await sink.ingest(batch, { at: "2026-06-29T20:00:00.000Z", accountId: "acc-1" });
    expect(auth).toBe("Bearer ccs_tok");
  });

  it("turns a 409 into AccountConflictError so the daemon halts writes", async () => {
    const sink = new HttpIngestSink(BASE, "ccs_tok", {
      fetchImpl: stubFetch(() => json({ error: "bound elsewhere", code: "account-conflict" }, 409)),
    });
    await expect(
      sink.ingest(batch, { at: "2026-06-29T20:00:00.000Z", accountId: "acc-2" })
    ).rejects.toBeInstanceOf(AccountConflictError);
  });
});

describe("HttpViewSource", () => {
  const view: SharedView = {
    generatedAt: "2026-06-29T20:00:00.000Z",
    samples: [],
    shares: [],
    members: [],
    users: [],
  };

  it("rejects when a hung server never answers (so the reader shows stale, not a frozen view)", async () => {
    // A fetch that accepts the socket but never responds — it only settles when
    // the request's own abort signal fires. Without a timeout this awaits forever.
    const hangingFetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject((init.signal as AbortSignal).reason));
      })) as typeof fetch;
    const source = new HttpViewSource(BASE, "ccs_tok", { fetchImpl: hangingFetch, timeoutMs: 20 });
    const err = await source.fetchView().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // Not an ApiRequestError → gatherView classifies it as unreachable (stale), not logged-out.
    expect(err).not.toBeInstanceOf(ApiRequestError);
  });

  it("caches by ETag and reuses the cached view on 304", async () => {
    const calls: (string | undefined)[] = [];
    const source = new HttpViewSource(BASE, "ccs_tok", {
      fetchImpl: stubFetch((_url, init) => {
        const inm = (init?.headers as Record<string, string>)["if-none-match"];
        calls.push(inm);
        if (inm === '"42.1"') return new Response(null, { status: 304 });
        return json(view, 200, { ETag: '"42.1"' });
      }),
    });

    const first = await source.fetchView();
    const second = await source.fetchView();
    expect(calls).toEqual([undefined, '"42.1"']); // conditional from the 2nd poll on
    expect(second).toBe(first); // the cached object, no re-parse
  });
});
