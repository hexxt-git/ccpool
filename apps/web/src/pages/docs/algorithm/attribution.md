---
layout: ../../../layouts/DocsLayout.astro
title: Attribution
description: The per-person split — delta-based time correlation, activity markers, names and unknown.
---

_Part of the [ccpool algorithm docs](/docs/algorithm)._

## Attribution — the heart of the per-person split

This is the algorithm that says "sam used 5%, unknown 87%". It's the one that was subtly wrong at first; the correct version is **delta-based time correlation**.

### Why the obvious approach is wrong

The tempting approach — split the _current tank_ across users by their token weight — fails badly:

- It can't see chat/mobile/web usage, so that usage gets dumped on whoever ran Code.
- The tank that built up _before_ the daemon started gets attributed to the first person who runs anything.

A single measured message would make you "responsible" for 100% of the tank.

### The right model

Attribute **changes in the tank**, correlated in time with the activity that caused them. Over the window of samples for a cap (`attributeShares` in `packages/core/src/state/shares.ts`):

1. The tank level at the **earliest reading in the window** is `unknown`'s **baseline** (pre-daemon usage is nobody's).
2. Walk consecutive samples, tracking a **monotonic envelope** (the running max so far). For each step, the rise `Δ = newMax − oldMax` is the genuine new-high; look at the Code activity whose timestamp falls in that interval:
   - **activity present** → split `Δ` across those users by token weight;
   - **none, but an activity marker** → credit `Δ` to the marker's user (a lagged/uncaptured local rise — see below);
   - **nothing at all** → the whole `Δ` is `unknown` (mobile / web / chat, or daemon was down).

   A reading that **dips** below the running max (clock-skew reorder across machines, or float wobble) is a new-high of zero — it neither inflates the active user nor discards their interval. For the opus cap, only opus-model messages count toward the weight.

3. The window is bounded to the **current reset cycle** by the most recent **recorded reset event** ([reset detection](/docs/algorithm/observation#reset-detection--by-pct-drop-never-by-clock)) — never by re-detecting drops here. A multi-machine series sorted by `capturedAt` can reorder under clock skew (a genuine rise landing as 46% before 45%), and a view-time drop check would read that dip as a phantom reset and dump the split into `unknown`. Reset events are recorded on a single machine's clock between two of its own readings, so they don't suffer that.
4. **Normalize** to the latest tank: if measured (non-`unknown`) users collectively exceed the target, scale them down (they can't exceed the tank) and zero `unknown`; otherwise `unknown` absorbs the remainder, so the column always totals the current tank.

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

Attribution treats markers as a strict **fallback**: an interval with any real message splits by measured weight as before; only a genuinely message-less rise consults its markers ([activity markers](#activity-markers--reclaiming-lagged--uncaptured-local-rises)). So a marker can never dilute measured attribution, and a rise more than a few minutes after the machine went quiet still falls to `unknown` — the conservative bias, so an idle machine never claims someone else's mobile usage. On a shared account this stays honest: another machine's own daemon marks (or measures) its own activity, and two machines contesting the same empty interval split it by marker weight.

It remains an **estimate**: the inter-user weight is the reliable signal (`cache_read + cache_creation + output`; `input_tokens` is left out because it undercounts and isn't comparable between users); Code + chat happening in the _same ~60s interval_ can't be perfectly separated (that sliver attaches to the active user); and an **activity marker** is a best-effort call that a message-less local rise was the recently-active user's overhead rather than mobile/web. Every case is bounded by the interval's delta — a world better than the whole tank.

## No budgets or quotas

ccpool deliberately has **no budgets, targets, or quotas**. It reports the reality of who used what and leaves it to the group to coordinate how much anyone should use — the tool never prescribes or enforces a share. (The retired `budgets` table was dropped from the schema baseline when v1 was redefined pre-production.)

## Names, hand-offs, and `unknown`

- A **name** is the only identity (`^[A-Za-z0-9-]+$`), stored in local config — not bound to a machine. Several people can share a machine and hand off with `config set name <name>`; the running daemon picks up the change next tick. `isValidName` also **reserves `unknown`** (case-insensitive): a person can't register as the bucket below, or their share would silently merge into it.
- **`unknown`** is a normal, always-listed row. It receives: activity ingested with no/invalid name, tank rises during intervals with no measured Code activity _and no local activity marker_ (chat/mobile/web, or daemon down), the pre-daemon baseline, and normalization remainder. This is what keeps measured users from claiming usage they didn't cause.
