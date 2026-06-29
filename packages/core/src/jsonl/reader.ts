import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MessageUsage } from "../types.js";
import { UNKNOWN_USER, isValidName } from "../types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Parse one transcript line into a usage row, or null if it isn't a usage-bearing
 * assistant message. Dedup id is `requestId` (a single request emits several
 * assistant lines with identical usage — counting each would double-count) and
 * falls back to `uuid`. Cache fields are reliable; raw input/output undercount.
 */
export function parseLine(line: string, user: string): MessageUsage | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let j: any;
  try {
    j = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (j?.type !== "assistant") return null;
  const usage = j?.message?.usage;
  if (!usage) return null;
  const id: unknown = j.requestId ?? j.uuid;
  if (typeof id !== "string" || id.length === 0) return null;

  return {
    uuid: id,
    user: isValidName(user) ? user : UNKNOWN_USER,
    timestamp: typeof j.timestamp === "string" ? j.timestamp : new Date().toISOString(),
    model: typeof j.message?.model === "string" ? j.message.model : null,
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Tails Claude Code transcripts, returning only lines appended *after* the daemon
 * came up. The first {@link collectNew} call baselines every existing file at its
 * current end-of-file and returns nothing — old history is never backfilled (§8).
 * On restart a fresh reader re-baselines to EOF, so activity that landed while the
 * daemon was down is skipped by design.
 */
export class JsonlReader {
  /** file -> byte offset already consumed (held in memory only). */
  private offsets = new Map<string, number>();
  private baselined = false;

  constructor(private readonly projectsDir: string) {}

  /** Collect usage rows appended since the last call (empty on the first call). */
  async collectNew(user: string): Promise<MessageUsage[]> {
    const files = await this.listFiles();

    if (!this.baselined) {
      for (const f of files) this.offsets.set(f, await sizeOf(f));
      this.baselined = true;
      return [];
    }

    const seen = new Set<string>();
    const rows: MessageUsage[] = [];
    for (const file of files) {
      for (const row of await this.readAppended(file, user)) {
        if (seen.has(row.uuid)) continue; // in-batch dedup across files
        seen.add(row.uuid);
        rows.push(row);
      }
    }
    return rows;
  }

  private async readAppended(file: string, user: string): Promise<MessageUsage[]> {
    const size = await sizeOf(file);
    let start = this.offsets.get(file) ?? 0; // new files start at 0 (new activity)
    if (size < start) start = 0; // truncated/rotated
    if (size <= start) {
      this.offsets.set(file, size);
      return [];
    }

    const fh = await open(file, "r");
    try {
      const len = size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      const text = buf.toString("utf8");

      const lastNl = text.lastIndexOf("\n");
      if (lastNl === -1) {
        // no complete line yet; leave the offset where it was
        return [];
      }
      const complete = text.slice(0, lastNl + 1);
      this.offsets.set(file, start + Buffer.byteLength(complete, "utf8"));

      const rows: MessageUsage[] = [];
      for (const line of complete.split("\n")) {
        const row = parseLine(line, user);
        if (row) rows.push(row);
      }
      return rows;
    } finally {
      await fh.close();
    }
  }

  /** All `*.jsonl` under projects/ recursively (includes `agent-*.jsonl`). */
  private async listFiles(): Promise<string[]> {
    let entries: string[];
    try {
      entries = (await readdir(this.projectsDir, { recursive: true })) as string[];
    } catch {
      return []; // projects/ may not exist yet (pre-onboarding)
    }
    return entries.filter((e) => e.endsWith(".jsonl")).map((e) => join(this.projectsDir, e));
  }
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}
