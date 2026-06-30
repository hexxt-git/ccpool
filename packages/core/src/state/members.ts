import type { MessageUsage } from "../types.js";

/** A name is "active" if it produced a message within this window. */
export const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/** Per-name rollup of measured Code activity: total tokens and last seen. */
export interface MemberSummary {
  user: string;
  /** input + output + cache (creation + read) across the window. */
  tokens: number;
  /** ISO 8601 of the most recent message, or null if none parsed. */
  lastActivityAt: string | null;
}

/**
 * Aggregate raw messages into one row per name. Pure: tokens sum every component
 * (cache included — raw input/output undercount, §"only new activity"), and
 * `lastActivityAt` is the max timestamp seen. Attribution stays separate; this is
 * just the measured-activity rollup the views show as `tokens`/`active`.
 */
export function summarizeMembers(messages: MessageUsage[]): MemberSummary[] {
  const acc = new Map<string, { tokens: number; last: number }>();
  for (const m of messages) {
    const tokens = m.inputTokens + m.outputTokens + m.cacheCreationTokens + m.cacheReadTokens;
    const t = Date.parse(m.timestamp);
    const cur = acc.get(m.user) ?? { tokens: 0, last: 0 };
    cur.tokens += tokens;
    if (Number.isFinite(t) && t > cur.last) cur.last = t;
    acc.set(m.user, cur);
  }
  return [...acc].map(([user, v]) => ({
    user,
    tokens: v.tokens,
    lastActivityAt: v.last > 0 ? new Date(v.last).toISOString() : null,
  }));
}

/** Whether a summary's last activity falls inside {@link ACTIVE_WINDOW_MS}. */
export function isActive(lastActivityAt: string | null, now: number = Date.now()): boolean {
  if (!lastActivityAt) return false;
  const t = Date.parse(lastActivityAt);
  return Number.isFinite(t) && now - t <= ACTIVE_WINDOW_MS;
}
