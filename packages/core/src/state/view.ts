import type { SharedView, UsageMarker } from "../types.js";
import type { Storage } from "../storage/storage.js";
import { attributeShares, CAP_WINDOW_MS } from "./shares.js";
import { summarizeMembers } from "./members.js";

/**
 * Rows older than the widest cap window can never influence the view again, so
 * retention prunes past it (one day of slack for clock skew between machines).
 */
export const RETENTION_MS = CAP_WINDOW_MS.seven_day + 24 * 3600_000;

/**
 * The cache key a computed {@link SharedView} stays valid under. Two parts:
 * - the storage change token — any ledger write invalidates the view;
 * - a coarse time bucket — `attributeShares` windows slide with `now`, so an
 *   idle ledger must still drift (never serve a frozen split forever). 60s
 *   matches the daemon cadence: a healthy group recomputes ~once a minute
 *   anyway, so the bucket adds ~nothing; an idle one recomputes once a minute.
 *
 * The same string doubles as the HTTP ETag for `GET /v1/view`.
 */
export function viewCacheKey(changeToken: string, now: number): string {
  return `${changeToken}.${Math.floor(now / 60_000)}`;
}

/**
 * Assemble the shared picture from raw rows: the 7-day trajectory feeds
 * `attributeShares`, messages feed the member rollup, and the roster rides
 * along. This is the ONE heavy read path — everything above it (CLI self-host,
 * server) caches the result under {@link viewCacheKey} and only calls back in
 * when the key moves.
 */
export async function computeSharedView(storage: Storage, now = Date.now()): Promise<SharedView> {
  // Pull enough history to cover the widest window, then attribute deltas.
  const since = new Date(now - CAP_WINDOW_MS.seven_day).toISOString();
  const [latest, samplesSince, messagesSince, resetsSince, users] = await Promise.all([
    storage.getLatestSamples(),
    storage.getUsageSamplesSince(since),
    storage.getMessageUsageSince(since),
    storage.getResetsSince(since),
    storage.getUsers(),
  ]);
  // Fetch markers defensively: a DB missing the table for any reason should
  // degrade to "no markers", not make the whole (reachable) view look
  // unreachable — the view still renders from samples + messages.
  let markersSince: UsageMarker[] = [];
  try {
    markersSince = await storage.getUsageMarkersSince(since);
  } catch {
    /* no markers table — attribute without markers */
  }

  // Merge latest samples with samplesSince (deduplicating by cap + capturedAt)
  // to ensure that a cap with a current reading (even if older than the window)
  // is always attributed (falling back to unknown) rather than skipped entirely.
  const allSamples = [...samplesSince];
  const seen = new Set(samplesSince.map((s) => `${s.cap}:${s.capturedAt}`));
  for (const s of latest) {
    const key = `${s.cap}:${s.capturedAt}`;
    if (!seen.has(key)) {
      allSamples.push(s);
      seen.add(key);
    }
  }

  return {
    generatedAt: new Date(now).toISOString(),
    samples: latest,
    shares: attributeShares(allSamples, messagesSince, now, resetsSince, markersSince),
    members: summarizeMembers(messagesSince),
    users,
  };
}
