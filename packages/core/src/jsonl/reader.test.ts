import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlReader, parseLine } from "./reader.js";

const assistantLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    uuid: over.uuid ?? "u-1",
    requestId: over.requestId ?? "req-1",
    timestamp: over.timestamp ?? "2026-06-29T12:00:00.000Z",
    message: {
      model: "claude-opus-4-8",
      role: "assistant",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
      },
    },
  }) + "\n";

describe("parseLine", () => {
  it("extracts usage from an assistant line, keyed by requestId", () => {
    const row = parseLine(assistantLine(), "sam");
    expect(row).toEqual({
      uuid: "req-1",
      user: "sam",
      timestamp: "2026-06-29T12:00:00.000Z",
      model: "claude-opus-4-8",
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 100,
      cacheReadTokens: 200,
    });
  });

  it("falls back to unknown for an invalid name", () => {
    expect(parseLine(assistantLine(), "")?.user).toBe("unknown");
    expect(parseLine(assistantLine(), "bad name!")?.user).toBe("unknown");
  });

  it("ignores non-assistant and usage-less lines", () => {
    expect(parseLine(JSON.stringify({ type: "user" }), "sam")).toBeNull();
    expect(parseLine(JSON.stringify({ type: "assistant", message: {} }), "sam")).toBeNull();
    expect(parseLine("not json", "sam")).toBeNull();
    expect(parseLine("", "sam")).toBeNull();
  });
});

describe("JsonlReader", () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ccpool-jsonl-"));
    await mkdir(join(dir, "proj-a"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("baselines at EOF and never backfills existing history", async () => {
    const f = join(dir, "proj-a", "session.jsonl");
    await writeFile(f, assistantLine({ requestId: "old" }));

    const reader = new JsonlReader(dir);
    expect(await reader.collectNew("sam")).toEqual([]); // baseline, no backfill

    await appendFile(f, assistantLine({ requestId: "new" }));
    const rows = await reader.collectNew("sam");
    expect(rows.map((r) => r.uuid)).toEqual(["new"]);
  });

  it("includes agent-*.jsonl and dedups a requestId emitted twice", async () => {
    const reader = new JsonlReader(dir);
    await reader.collectNew("sam"); // baseline (empty dir state)

    const agent = join(dir, "proj-a", "agent-123.jsonl");
    // same requestId on two lines (different uuids) -> one row
    await writeFile(
      agent,
      assistantLine({ requestId: "r9", uuid: "a" }) + assistantLine({ requestId: "r9", uuid: "b" })
    );
    const rows = await reader.collectNew("alex");
    expect(rows.map((r) => r.uuid)).toEqual(["r9"]);
    expect(rows[0]?.user).toBe("alex");
  });

  it("does not advance past a partial trailing line", async () => {
    const f = join(dir, "proj-a", "s.jsonl");
    await writeFile(f, "");
    const reader = new JsonlReader(dir);
    await reader.collectNew("sam"); // baseline

    // append a complete line plus a partial (no trailing newline)
    await appendFile(f, assistantLine({ requestId: "done" }) + '{"type":"assist');
    expect((await reader.collectNew("sam")).map((r) => r.uuid)).toEqual(["done"]);

    // finish the partial line
    await appendFile(f, 'ant","requestId":"later","message":{"usage":{"output_tokens":1}}}\n');
    expect((await reader.collectNew("sam")).map((r) => r.uuid)).toEqual(["later"]);
  });
});
