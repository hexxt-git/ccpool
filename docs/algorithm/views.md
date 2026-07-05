# The view model — status, TUI, and the watermark cache

_Part of the [ccshare algorithm docs](../ALGORITHM.md)._

---

## 8. The view model — what `status` and `tui` render

Both surfaces render from one model, assembled by `gatherView`. It prefers the **shared backend** (everyone-included), falls back to the local **`state.json`** (instant, no network), and finally to a one-shot **live poll** so the view is never empty before the daemon's first write.

The heavy half — the raw-row reads plus attribution — lives in core as `computeSharedView` (the reads below, feeding the pure `assembleSharedView`) and produces the compact **`SharedView`** (latest samples, shares, member rollups, and the roster — a few KB, never raw rows):

```ts
// packages/core/src/state/view.ts  (abridged)
const since = new Date(now - CAP_WINDOW_MS.seven_day).toISOString();
const [latest, samplesSince, messagesSince, resetsSince, users] = await Promise.all([
  storage.getLatestSamples(), // the header bars
  storage.getUsageSamplesSince(since), // the trajectory, for attribution
  storage.getMessageUsageSince(since), // everyone's measured activity
  storage.getResetsSince(since), // reset events bound the window (§7)
  storage.getUsers(), // the roster
]);
// Fetch markers defensively — a DB missing the table for any reason degrades to
// "no markers" rather than letting one missing table blank the whole view.
const markersSince = await storage.getUsageMarkersSince(since).catch(() => []);

// Merge latest samples into samplesSince (deduplicating) to guarantee that
// a cap with a current reading (even if older than the window) is always
// attributed (falling back to unknown) rather than skipped entirely.
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
  generatedAt,
  samples: latest,
  shares: attributeShares(allSamples, messagesSince, now, resetsSince, markersSince), // §7
  members: summarizeMembers(messagesSince), // per-name token totals + last-seen
  users,
};
```

`gatherView` (apps/cli) wraps a `ViewSource.fetchView()` in the local decoration — daemon pid, `state.json` fallback, live-poll fallback, the cached account email — exactly as before.

### 8.5 The watermark — why a 2s refresh is cheap

The TUI refreshes every 2 seconds, but the ledger changes at most about once per minute (the daemon cadence). Re-reading a 7-day window of samples (~30k rows) and re-running attribution on every refresh was the original cost problem — hundreds of thousands of heavy queries a day per viewer. The fix is a **write watermark**:

- Every ledger mutation (`recordBatch`, `upsertUser`, `prune`) bumps a single counter, `ccshare_meta.writeSeq`, **inside the same transaction**. Reading it (`getChangeToken`) is one single-row SELECT.
- A computed view is cached under `viewCacheKey(token, now)` — the token plus a **60-second time bucket**. The bucket exists because `attributeShares` windows slide with `now`: without it, a group whose daemons stopped writing would be served a frozen split forever. Worst case is one recompute per minute even with zero writes; a healthy group writes ~1/min anyway, so the bucket adds ~nothing.
- **Server side:** `StorageViewSource.fetchView()` does the 1-row token read; only a changed key recomputes. The heavy read drops from every-2s to ~1/min per viewer (~30×), and `reset_events` scans sit behind a real index now.
- **Client side:** the same key doubles as the **ETag** of `GET /v1/view`. The client sends `If-None-Match`; the steady-state answer is a bodyless **304** backed by one single-row SELECT on the server. Only a real change re-sends the few-KB view (§13).

### 8.6 The ledger window — why even the ~1/min recompute reads no rows

The watermark bounds _how often_ the heavy work runs; the **`LedgerWindow`** (`packages/core/src/backend/window.ts`) removes the heavy read itself. The server composes one per live group, shared by that group's ingest sink and view source:

- **Hydration, once:** the first view read performs the same full-window scan `computeSharedView` would, into in-memory maps keyed by the DB's natural keys.
- **Append, ever after:** the ingest sink already holds each tick's rows when `recordBatch` commits, so it pushes them straight into the window. A steady-state recompute runs `assembleSharedView` over memory — the only storage read left is the tiny roster (plus the 1-row watermark).
- **Byte-identical by construction:** appends are insert-if-absent per natural key (a retried tick's mutated values lose, matching `ON CONFLICT DO NOTHING`); an un-hydrated window drops appends (the hydration read covers them) and a hydrating one buffers them; the window trims only when the sink's prune actually deletes rows — never on a clock — so `latest` can keep surfacing a cap whose only sample is older than the 7-day window, exactly like the SQL path. Late-arriving batches (a machine re-sending a retained tick) are appended like any other and the next recompute re-attributes the full window, so attribution self-heals identically in both paths. An equivalence suite (`packages/core/test/window.test.ts`) pins windowed == full-scan across hydrate/append/retry/prune/eviction races.
- **Eviction is free:** tenants hold no connections (their `Storage` is a facade over the one process pool), so the LRU just drops the window; the group re-hydrates with one scan on its next touch.

Retention rides the same path: rows older than the widest cap window (+1 day of slack — `RETENTION_MS`, 8 days) can never influence a view again, so the sink prunes them on a throttled sweep and every table stays bounded.

`toDesignModel` flattens this into one presentation model: **caps** (the header bars) and **members** (each person's per-window share, joined with their token total and an `active` flag). `active` is deliberately simple — the member is holding more than 0% of the **5-hour** window right now. The member list is keyed on the people attribution produced; `unknown` is always last.

Two surfaces render that model:

- **`status`** is a plain-string renderer (`status-render.ts`): one frame, **coloured when stdout is a TTY and plain text when piped/redirected**, so `status | grep` and `status > file` stay clean. It targets 70 columns and sheds columns (the per-member bar, then trailing caps) on narrower terminals. Bar colour comes from a calculated green→red ramp (`heat.ts`, hue 120°→0° in HSL); each member's bar matches their name colour.
- **`tui`** re-runs `gatherView` every 2s (cheap — §8.5; the clock ticks every 1s so countdowns move), rendering the same model through one of three interchangeable Ink layouts — **overview · split · mono**, cycled with **Tab** (Shift+Tab reverses) — adding per-person token totals and scrolling for large groups. The views fill the terminal width and reflow live on resize (`useTermSize`).

Bare **`ccshare`** opens a **TUI-first shell** (`tui/Root.tsx`): unconfigured, it lands on a guided onboarding wizard (the interactive form of `init`); configured, it opens the live view, where **`c`** opens a tabbed **configure** screen (general · daemon, same Tab / Shift+Tab cycling). Configure writes config, tests a storage connection before saving, and starts/stops the daemon — all the interactive form of the flag commands, which stay as a scriptable fallback.

Edge states (token expired, daemon down, live-poll badge) render as footnotes. When the **database is unreachable** but the tank is still cached (offline), the member table can't show the real split, so it degrades to a placeholder rather than an empty list: `DISCONNECTED_ROWS` grey `xxxx` rows whose shares are a random — but seed-stable, so they don't flicker across re-renders — partition summing to each cached window, all marked idle, under a red (mono: white) "can't reach the database" line. It reverts to the real per-person split the moment the DB is reachable again.

```
 ▐▛███▜▌   ccshare · status  ·  you are sam
▝▜█████▛▘  account sam@example.com  ·  2 members (1 active)
  ▘▘ ▝▝    shared db · synced 12s ago · daemon running

overall
  5h      ███████████████████████████░░   92%  · resets 4h 02m
  weekly  ██████░░░░░░░░░░░░░░░░░░░░░░░░   21%  · resets 6d 4h

members
   # member    usage                          5h   wk  state
   1 sam ◂     █░░░░░░░░░░░░░░░░░░░░░░░░░░   5%   1%  active
   2 unknown   ██████████████████████████  87%  20%  idle
```
