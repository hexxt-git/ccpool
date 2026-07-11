# Attribution — the per-person split

_Part of the [ccpool algorithm docs](../ALGORITHM.md)._

---

## 7. Attribution — the heart of the per-person split

This is the algorithm that says "sam used 5%, unknown 87%". It's the one that was subtly wrong at first; the correct version is **delta-based time correlation**.

### Why the obvious approach is wrong

The tempting approach — split the _current tank_ across users by their token weight — fails badly:

- It can't see chat/mobile/web usage, so that usage gets dumped on whoever ran Code.
- The tank that built up _before_ the daemon started gets attributed to the first person who runs anything.

A single measured message would make you "responsible" for 100% of the tank.

### The right model

Attribute **changes in the tank**, correlated in time with the activity that caused them:

1. The tank level at the **earliest reading in the window** is `unknown`'s **baseline** (pre-daemon usage is nobody's).
2. Walk consecutive samples, tracking a **monotonic envelope** (the running max so far in the window). For each step, the rise `Δ = newMax − oldMax` is the genuine new-high; look at the Code activity whose timestamp falls in that interval:
   - activity present → split `Δ` across those users by token weight;
   - none → the whole `Δ` is `unknown` (mobile / web / chat, or daemon was down) — _unless_ a machine left an **activity marker** for that interval (a lagged or uncaptured local rise), which claims it for that user instead (see below). A reading that **dips** below the running max (clock-skew reorder across machines, or sub-point float wobble) is a new-high of zero — it neither inflates the active user nor discards their interval.
3. The window is bounded by **recorded reset events**, not by re-detecting drops here (a multi-machine series sorted by `capturedAt` can reorder under clock skew, and a view-time drop check would read that as a phantom reset).
4. `unknown` absorbs any remainder so the column totals the current tank.

```ts
// packages/core/src/state/shares.ts  (the core loop, abridged)
const attributed = new Map<string, number>();
attributed.set(UNKNOWN_USER, win[0].pct);            // 1. baseline = pre-daemon tank

let mi = 0;                                          // pointer into time-sorted messages
while (mi < msgs.length && msgs[mi].t <= win[0].t) mi++;   // skip pre-baseline activity

let envMax = win[0].pct;                              // monotonic envelope (running max)
for (let i = 1; i < win.length; i++) {
  const cur = win[i];

  // 2a. collect this interval's activity (advance pointer regardless of Δ)
  const weights = new Map<string, number>(); let total = 0;
  while (mi < msgs.length && msgs[mi].t <= cur.t) {
    const m = msgs[mi++];
    if (opusOnly && !isOpus(m.model)) continue;      // opus cap only counts opus models
    weights.set(m.user, (weights.get(m.user) ?? 0) + m.w);
    total += m.w;
  }
  // …and this interval's activity markers into markerWeights/markerTotal the same way

  const newMax = Math.max(envMax, cur.pct);
  const delta = newMax - envMax; envMax = newMax;    // rise off the running max
  if (delta <= 0) continue;                          // 3. dip/wobble → zero new-high

  if (total > 0) {                                   // 2b. split the rise by weight
    for (const [u, w] of weights) attributed.set(u, (attributed.get(u) ?? 0) + delta * w / total);
  } else if (markerTotal > 0) {                       // 2c. no message, but a machine
    for (const [u, w] of markerWeights)               //     flagged local Code was active
      attributed.set(u, (attributed.get(u) ?? 0) + delta * w / markerTotal);
  } else {                                           // 2d. nobody active → unknown
    attributed.set(UNKNOWN_USER, (attributed.get(UNKNOWN_USER) ?? 0) + delta);
  }
}

// 4. normalize to the latest tank, dumping drift into unknown (the bias we want)
const target = win[win.length - 1].pct;
const nonUnknown = sum(users except unknown);
if (nonUnknown > target) {
  // guard: measured users can't collectively exceed the tank — scale them down
  const scale = target / nonUnknown;
  for each non-unknown user: user.pct *= scale;
  unknown.pct = 0;
} else {
  unknown.pct = Math.max(0, target - nonUnknown);
}
```

The window (`win`) is bounded to the **current reset cycle** — it starts at the most recent **recorded reset event** (§3) for the cap and never looks back further than the cap's length. It deliberately does **not** re-detect resets from pct drops in the merged series: machines have skewed clocks, so a genuine rise can land out of order (46% before 45%), and a view-time drop check would read that one-percent dip as a phantom reset and dump the whole split into `unknown`. Reset events are recorded on a single machine's clock between two of its own readings, so they don't suffer that.

```ts
const cutoff = now - CAP_WINDOW_MS[cap]; // 5h or 7d
let start = 0;
for (let i = 1; i < capSamples.length; i++) {
  if (capSamples[i].t < cutoff) start = i; // too old
}
const lastReset = resetTimes.length ? Math.max(...resetTimes) : -Infinity;
if (lastReset > -Infinity) {
  // drop the previous cycle: begin at the first sample at/after the reset
  const firstAfter = capSamples.findIndex((s) => s.t >= lastReset);
  start = Math.max(start, firstAfter < 0 ? capSamples.length - 1 : firstAfter);
}
const win = capSamples.slice(start);
```

The daemon seeds its `prev` reading from the shared DB at startup, so a reset that happened while it was down is caught — and recorded as an event — on the first poll, rather than being missed because `prev` began empty.

### Worked example

Daemon comes up when 5h is already at **80%**. You run a bit of Code (tank rises 80→85). Then mobile usage pushes it 85→92 with no Code activity.

| interval     | Δ   | Code activity in interval | credited to     |
| ------------ | --- | ------------------------- | --------------- |
| _(baseline)_ | —   | —                         | `unknown` += 80 |
| 80 → 85      | +5  | sam (1000 tok)            | `sam` += 5      |
| 85 → 92      | +7  | _(none — mobile)_         | `unknown` += 7  |

Result: **sam 5%, unknown 87%**, summing to the 92% tank. Exactly what you'd expect, and what the old algorithm got wrong (it would have shown sam 92%).

### Why this is multi-machine correct

Each machine writes its own samples (all see the same global tank → last-write-wins is fine) and its own messages with timestamps. At view time, attribution reads **everyone's** messages from the shared DB, so a rise is credited to whichever participant — on any machine — was active in that interval. Activity from a machine whose daemon was down simply isn't in the DB, so that interval's rise falls to `unknown`.

### Activity markers — reclaiming lagged / uncaptured local rises

One case the pure delta-vs-message correlation gets wrong: **real Code usage whose token cost lands on the tank without a matching transcript line in that interval.** The usage endpoint can report a heavy session's cost a tick or two _after_ its last transcript line (an endpoint-lagged tail), and a **resume / compaction re-prime** rebuilds a cold prompt cache — billed to the account, but under-reported (or absent) in the transcript at the moment the tank moves. Both leave a genuine local rise in an interval with no measured message, so the base algorithm dumps it on `unknown`.

The only observer that can tell this apart from real mobile/web/chat usage is the **local daemon**: it alone knows _this machine's_ user was driving Code seconds ago. So each tick, if a cap rose but **no message was ingested that tick** _and_ this machine produced Code activity within the last few minutes (`MARKER_ACTIVITY_WINDOW_MS`, 3 min), the daemon records a **`UsageMarker`** — `{ user, at, model, weight }` — for its current user, stamped at the instant it _observed_ the rise (so the marker lands in the same sample interval, side-stepping the transcript's lag).

Attribution treats markers as a strict **fallback**: an interval with any real message splits by measured weight as before; only a genuinely message-less rise consults its markers (§2c). So a marker can never dilute measured attribution, and a rise more than a few minutes after the machine went quiet still falls to `unknown` — the conservative bias, so an idle machine never claims someone else's mobile usage. On a shared account this stays honest: another machine's own daemon marks (or measures) its own activity, and two machines contesting the same empty interval split it by marker weight.

It remains an **estimate**: the inter-user weight is the reliable signal (`cache_read + cache_creation + output`; `input_tokens` is left out because it undercounts and isn't comparable between users); Code + chat happening in the _same ~60s interval_ can't be perfectly separated (that sliver attaches to the active user); and an **activity marker** is a best-effort call that a message-less local rise was the recently-active user's overhead rather than mobile/web. Every case is bounded by the interval's delta — a world better than the whole tank.

---

## 10. No budgets or quotas

ccpool deliberately has **no budgets, targets, or quotas**. It reports the reality of who used what and leaves it to the group to coordinate how much anyone should use — the tool never prescribes or enforces a share. (The retired `budgets` table was dropped from the schema baseline when v1 was redefined pre-production.)

---

## 11. Names, hand-offs, and `unknown`

- A **name** is the only identity (`^[A-Za-z0-9-]+$`), stored in local config — not bound to a machine. Several people can share a machine and hand off with `config set name <name>`; the running daemon picks up the change next tick. `isValidName` also **reserves `unknown`** (case-insensitive): a person can't register as the bucket below, or their share would silently merge into it.
- **`unknown`** is a normal, always-listed row. It receives: activity ingested with no/invalid name, tank rises during intervals with no measured Code activity _and no local activity marker_ (chat/mobile/web, or daemon down), the pre-daemon baseline, and normalization remainder. This is what keeps measured users from claiming usage they didn't cause.
