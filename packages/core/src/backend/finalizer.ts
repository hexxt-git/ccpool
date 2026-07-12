import type { CapKind, HistoryShare, MessageUsage, UsageMarker, UsageSample } from "../types.js";
import type { Storage } from "../storage/storage.js";
import { attributeShares } from "../state/shares.js";
import { RETENTION_MS } from "../state/view.js";

/**
 * How long after a reset a just-closed window stays amendable before it freezes
 * into history. Late idempotent re-sends within this window still move its shares;
 * after it, the record is immutable.
 */
const DEFAULT_GRACE_MS = 30 * 60_000;
/** Finalization is checked at most this often — grace is 30 min, so cheap. */
const DEFAULT_FINALIZE_INTERVAL_MS = 60_000;

export interface HistoryFinalizerOptions {
  /** Grace after a reset before a closed window freezes into history. */
  graceMs?: number;
  /** How often finalization is actually attempted (throttled). */
  finalizeIntervalMs?: number;
  /** How far back to scan for closable windows (the retention window). */
  retentionMs?: number;
  now?: () => number;
}

/**
 * Freezes completed cap cycles into immutable {@link HistoryWindow} rows + shares.
 *
 * Shared per group by the ingest sink (ticked after each batch) and the read
 * routes (ticked on every `/v1/view` and `/v1/history` poll), so a group that
 * goes quiet right after a reset still freezes its last window when anyone looks,
 * not only on its next ingest. Ticking from both sides is safe: the throttle
 * check-and-set is synchronous, `recordHistoryWindow` is idempotent, and `frozen`
 * skips already-frozen windows.
 */
export class HistoryFinalizer {
  private readonly graceMs: number;
  private readonly finalizeIntervalMs: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private lastFinalizeMs = 0;
  /** `${cap} ${windowStart}` of windows already frozen — skip recompute. */
  private readonly frozen = new Set<string>();

  constructor(
    private readonly storage: Storage,
    opts: HistoryFinalizerOptions = {}
  ) {
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.finalizeIntervalMs = opts.finalizeIntervalMs ?? DEFAULT_FINALIZE_INTERVAL_MS;
    this.retentionMs = opts.retentionMs ?? RETENTION_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Freeze any window whose closing reset is now past the grace period. Throttled.
   * A window spans two consecutive resets of the cap (the first opens at the
   * earliest retained sample); shares come from the same `attributeShares` the live
   * view uses.
   */
  async maybeFinalize(now = this.now()): Promise<void> {
    if (now - this.lastFinalizeMs < this.finalizeIntervalMs) return;
    this.lastFinalizeMs = now;
    const since = new Date(now - this.retentionMs).toISOString();
    const resets = await this.storage.getResetsSince(since);
    if (resets.length === 0) return;

    const capResets = new Map<CapKind, number[]>();
    for (const r of resets) {
      const t = Date.parse(r.at);
      if (!Number.isFinite(t)) continue;
      const arr = capResets.get(r.cap);
      if (arr) arr.push(t);
      else capResets.set(r.cap, [t]);
    }

    let samples: UsageSample[] | null = null;
    let messages: MessageUsage[] | null = null;
    let markers: UsageMarker[] | null = null;

    for (const [cap, times] of capResets) {
      times.sort((a, b) => a - b);
      for (let i = 0; i < times.length; i++) {
        const endMs = times[i]!;
        if (endMs + this.graceMs > now) continue; // still amendable

        // Load the trajectory/activity once, lazily, only when something freezes.
        if (samples === null) {
          [samples, messages, markers] = await Promise.all([
            this.storage.getUsageSamplesSince(since),
            this.storage.getMessageUsageSince(since),
            this.storage.getUsageMarkersSince(since).catch(() => []),
          ]);
        }

        const capSamples = samples.filter((s) => s.cap === cap);
        // Window start = the previous reset, or the earliest retained sample.
        const startMs =
          i > 0
            ? times[i - 1]!
            : Math.min(...capSamples.map((s) => Date.parse(s.capturedAt)).filter(Number.isFinite));
        if (!Number.isFinite(startMs) || startMs >= endMs) continue;
        const windowStart = new Date(startMs).toISOString();
        const key = `${cap} ${windowStart}`;
        if (this.frozen.has(key)) continue;
        const windowEnd = new Date(endMs).toISOString();

        const inWin = (iso: string) => {
          const t = Date.parse(iso);
          return t >= startMs && t < endMs;
        };
        const winSamples = capSamples.filter((s) => inWin(s.capturedAt));
        if (winSamples.length === 0) {
          this.frozen.add(key);
          continue;
        }
        const winMsgs = messages!.filter((m) => inWin(m.timestamp));
        const winMarkers = markers!.filter((m) => inWin(m.at));
        // Anchor attribution at the window end, bounded by its opening reset.
        const openingReset = [{ cap, at: windowStart, previousPct: 0 }];
        const shares = attributeShares(winSamples, winMsgs, endMs, openingReset, winMarkers).filter(
          (sh) => sh.cap === cap
        );
        const overall = Math.max(...winSamples.map((s) => s.pct));
        const historyShares: HistoryShare[] = shares.map((sh) => ({
          cap,
          windowStart,
          user: sh.user,
          pct: sh.pct,
        }));
        await this.storage.recordHistoryWindow(
          { cap, windowStart, windowEnd, overall, closedAt: new Date(now).toISOString() },
          historyShares
        );
        this.frozen.add(key);
      }
    }
  }
}
