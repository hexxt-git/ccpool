import type { CapKind } from "@ccshare/core";
import { requireInit } from "../lib/guard.js";
import { renderHistoryLines } from "../lib/history-render.js";

/** `--cap` accepts friendly aliases; maps to the wire CapKind. */
const CAP_ALIAS: Record<string, CapKind> = {
  "5h": "five_hour",
  five_hour: "five_hour",
  weekly: "seven_day",
  seven_day: "seven_day",
  opus: "seven_day_opus",
  seven_day_opus: "seven_day_opus",
};

/**
 * One-shot table of previous windows and who used each — the non-interactive
 * mirror of the TUI history mode (ADR-0005). Cold read over `GET /v1/history`.
 */
export async function runHistory(opts: { cap?: string; limit?: string }): Promise<void> {
  const ctx = await requireInit();
  if (!ctx) return;
  const { viewSource } = ctx;
  const cap = CAP_ALIAS[(opts.cap ?? "5h").toLowerCase()];
  if (!cap) {
    console.error(`unknown --cap "${opts.cap}" (use: 5h | weekly | opus)`);
    process.exitCode = 1;
    await viewSource.close();
    return;
  }
  const n = Number(opts.limit);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(200, Math.floor(n)) : 20;
  try {
    const page = await viewSource.history({ cap, limit });
    const width = process.stdout.columns ?? 80;
    for (const line of renderHistoryLines(page, { cap, width })) console.log(line);
  } catch (e) {
    console.error(`could not read history: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await viewSource.close();
  }
}
