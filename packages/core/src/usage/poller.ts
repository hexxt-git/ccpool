import type { CapKind, UsageSample } from "../types.js";
import { CAP_KINDS } from "../types.js";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const OAUTH_BETA = "oauth-2025-04-20";

/** The endpoint key for each cap. Caps absent on a plan come back as `null`. */
const CAP_FIELD: Record<CapKind, string> = {
  five_hour: "five_hour",
  seven_day: "seven_day",
  seven_day_opus: "seven_day_opus",
};

/** Thrown on 401 / expired token so callers can skip the tick, not crash. */
export class UsageAuthError extends Error {
  override name = "UsageAuthError";
}

/** Thrown on any other non-2xx (e.g. 429 rate-limit) — carries the status so
 * callers can surface *why* the poll failed instead of a bare backoff. */
export class UsageRequestError extends Error {
  override name = "UsageRequestError";
  constructor(readonly status: number) {
    super(`usage endpoint returned ${status}`);
  }
}

/**
 * Parse the usage payload into one sample per *available* cap. A cap that is
 * `null` (not applicable to the plan) is skipped — never rendered as 0.
 * `pct` is taken verbatim from `utilization`; we never derive it from tokens.
 */
export function parseUsage(
  body: unknown,
  capturedAt: string = new Date().toISOString()
): UsageSample[] {
  const obj = (body ?? {}) as Record<string, unknown>;
  const out: UsageSample[] = [];
  for (const cap of CAP_KINDS) {
    const node = obj[CAP_FIELD[cap]] as
      | { utilization?: unknown; resets_at?: unknown }
      | null
      | undefined;
    // `typeof NaN === "number"`, so guard finiteness too: a NaN/Infinity pct would
    // poison reset detection and attribution. Skip the cap like a null one; a
    // *finite* pct we still trust verbatim, never estimated from tokens.
    if (!node || typeof node.utilization !== "number" || !Number.isFinite(node.utilization)) {
      continue;
    }
    out.push({
      cap,
      pct: node.utilization,
      resetsAt: typeof node.resets_at === "string" ? node.resets_at : null,
      capturedAt,
    });
  }
  return out;
}

export interface PollOptions {
  version?: string;
  fetchImpl?: typeof fetch;
  capturedAt?: string;
}

/**
 * Read the account-wide tank. Caller must have verified `now < expiresAt` first
 * (§9). 401 → {@link UsageAuthError}; other non-2xx → generic Error for backoff.
 */
export async function pollUsage(
  accessToken: string,
  opts: PollOptions = {}
): Promise<UsageSample[]> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": OAUTH_BETA,
      "User-Agent": `claude-code/${opts.version ?? "1.0.0"}`,
    },
  });

  if (res.status === 401) {
    throw new UsageAuthError("usage endpoint returned 401 (token expired?)");
  }
  if (!res.ok) {
    throw new UsageRequestError(res.status);
  }

  return parseUsage(await res.json(), opts.capturedAt);
}
