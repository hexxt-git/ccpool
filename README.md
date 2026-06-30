<div>
  <h1 align="center">ccshare 👾</h1>
  <p align="center">
    <img src="https://img.shields.io/badge/Node-%E2%89%A520-black?style=for-the-badge&logo=node.js&logoColor=white" alt="Node >= 20" />
    <img src="https://img.shields.io/badge/Bun-supported-black?style=for-the-badge&logo=bun&logoColor=white" alt="Bun supported" />
    <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License" />
  </p>
  <img width="1000" height="500" alt="ccshare-extra-large(1)" src="https://github.com/user-attachments/assets/cb493208-5ef8-4bc6-8d5b-41a740a4a41d" />
  <p>
    > a cli to fairly share one claude subscription across a group
  </p>
</div>

<hr/>

## 💡 What is it?

A group sharing **one Claude subscription** constantly collides on the limits:
someone burns the 5-hour window in the morning and everyone else is locked out by
noon; someone quietly eats most of the weekly cap and nobody knew until it was
gone. Anthropic only reports one account-wide number, so there's no built-in way
to see _who_ used _how much_.

`ccshare` gives that group a **shared, live picture** of the account's usage and
who's driving it, so they can split it fairly and self-regulate.

It is a **read-only observer plus a shared ledger**. It never sits in the request
path, never proxies, never blocks requests, and never touches auth beyond reading
the token Claude Code already stored. Each participant runs ccshare on their own
machine, everyone points at **one shared database**, and the tool shows:

- **how full each shared window is right now** (5-hour, weekly, weekly-Opus) with
  live reset countdowns — the account-wide truth from Anthropic's endpoint;
- the **per-person split** of who drove that usage, built from Claude Code activity
  seen while the daemon runs, credited to the active name on each machine — with
  each person's token total and whether they're active right now (anything untied to
  a known name shows as `unknown`);
- optional **per-person budgets** — fair-share targets you can set and list.

> It does **not** increase anyone's limit, multiplex the subscription, or enforce
> anything. It makes shared usage _legible_ so a group can govern itself.

## 👾 How it works

- **Shared tank level** (the % bars) is one account-wide number every participant
  reads from Anthropic's usage endpoint.
- **Per-person split** is built locally: a background daemon tails the Claude Code
  transcripts on each machine and credits new activity to the active name, writing
  it to the shared DB. Summed across everyone, that's the breakdown.
- **No IPC.** The daemon writes an atomic local `state.json` and the shared
  database; the TUI and statusline just read those. Nothing talks to another
  process directly.
- **Only new activity counts.** On startup the daemon baselines each transcript at
  its current end-of-file and ingests only lines appended after — old history is
  never backfilled.
- **Runs on Node (≥20) and Bun.** Storage is swappable: libSQL/Turso by default,
  Postgres also supported.

---

## 🚀 Quick Start

### 1. Prerequisites

- [Node.js](https://nodejs.org) ≥ 20 (or [Bun](https://bun.sh)) and
  [pnpm](https://pnpm.io)
- Claude Code installed and signed in on each machine (ccshare reads the token it
  already stored — it never logs you in)
- **One shared database** for the group. Either works:
  - a local file (great for a single machine or a shared/synced path):
    `file:./ccshare.db`
  - a free hosted [Turso](https://turso.tech) / libSQL database: `libsql://…`
    (plus an auth token), or a Postgres URL

### 2. Build the CLI

```bash
pnpm install
pnpm build
```

This produces the `ccshare` binary at `apps/cli/dist/cli.js`. Run it with
`node apps/cli/dist/cli.js <command>`, or link it for a global `ccshare`:

```bash
cd apps/cli && pnpm link --global   # then just `ccshare <command>`
```

The examples below use `ccshare` for brevity.

### 3. Initialise (required first run)

Everyone in the group runs `init` pointing at the **same** database URL — that URL
is the join key. The first person sets up the schema; everyone after joins it.

```bash
ccshare init
```

You'll be asked to pick storage, enter the database URL (+ token if remote), and
choose a **name** (letters, digits, hyphens). On an empty database it asks before
creating tables; if the database already contains another project it refuses
rather than mixing in — ccshare needs its own clean, dedicated database.

Prefer non-interactive? Every prompt has a flag:

```bash
ccshare init --driver libsql --url "file:./ccshare.db" --name sam --yes
```

Check what ccshare sees at any time (changes nothing):

```bash
ccshare doctor
```

### 4. Start the daemon

```bash
ccshare daemon start          # runs detached in the background
ccshare daemon status         # is it running? how fresh is state.json?
ccshare daemon stop
ccshare daemon restart
```

From now on your live usage flows into the shared DB under your current name.

### 5. Watch usage

```bash
ccshare tui        # live shared view (alias: ccshare live)
                   #   ⇧⇥ switch view · ↑↓ scroll · r refresh · q quit
ccshare status     # one-shot snapshot to stdout
```

`status` prints a single frame — coloured when stdout is a terminal, clean plain
text when piped or redirected (so `status | grep` and `status > file` stay tidy).
It targets a 70-column terminal and sheds columns gracefully on narrower ones:

```
 ▐▛███▜▌   ccshare · status  ·  you are sam
▝▜█████▛▘  account sam@example.com  ·  3 members (2 active)
  ▘▘ ▝▝    shared db · synced 12s ago · daemon running

overall
  5h      ██████████████████░░░░░░░░░░░░   60%  · resets 4h 02m
  weekly  █████████░░░░░░░░░░░░░░░░░░░░░   30%  · resets 6d 4h

members
   # member    usage                          5h   wk  state
   1 sam ◂     ███████████████░░░░░░░░░░░░░  45%  23%  active
   2 alex      █████░░░░░░░░░░░░░░░░░░░░░░░  15%   8%  active
   3 unknown   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░   0%   0%  idle
```

The header is the overall account tank; the member rows are each person's slice of
it (summing to the header per window), plus whether they're **active** — holding any
of the 5-hour window right now. `unknown` is always listed and absorbs usage the
Code split can't see (e.g. claude.ai chat).

`ccshare tui` shows the same data live and adds three interchangeable layouts
(**overview · split · mono**, cycle with `⇧⇥`), per-person token totals, and
scrolling for large groups.

### 6. Statusline (optional)

A compact one-liner for Claude Code's status bar (reads `state.json` only — no
network):

```bash
ccshare statusline
# ◐ 5h 60% · wk 30% · you sam · ● db
```

---

## 🧑‍🤝‍🧑 Sharing & day-to-day

```bash
ccshare users                       # list participants in the shared DB
ccshare config set name alex        # hand off the machine to another person
ccshare config get                  # show current config
```

Names are just labels, not machines — several people can share a machine and hand
off by changing the name. Whoever's name is set when activity is ingested gets
credited; the running daemon picks up the change without a restart.

### Budgets (optional fair-share targets)

```bash
ccshare budget set sam weekly 33    # sam's target share of the weekly window
ccshare budget set sam 5h 33
ccshare budget list
```

Targets are stored per `(name, cap)` and shown by `budget list`. (The inline
over/under marker isn't surfaced in the redesigned `status`/`tui` views yet — see
`docs/ALGORITHM.md` §10.)

---

## 🗂️ Project layout

```
packages/
  core/               # runtime-agnostic domain logic + Storage interface
  storage-libsql/     # default adapter (file: and libsql://)
  storage-postgres/   # second adapter, proves swappability
  daemon/             # the background observer (poll + jsonl + state.json)
apps/
  cli/                # Commander + Ink CLI
  web/                # marketing site (Astro)
```

Config lives in `~/.ccshare/` (`config.json`, the per-account `state.json`, logs,
and a `0600` token file). Override the location with `CCSHARE_DIR`.

## 🧪 Development

```bash
pnpm build        # build every package
pnpm type-check   # type-check the workspace
pnpm lint
pnpm test         # run the suite on Node
pnpm test:bun     # run the same suite on Bun
```

The full suite runs on both Node and Bun in CI, and the storage contract suite
runs against the memory, libSQL, and Postgres adapters.

---

## 🤝 Contributing

Contributions welcome — bugs, features, or docs. See the
[GitHub repository](https://github.com/hexxt-git/ccshare) to get started.

## 📜 License

Open-sourced under the MIT License.
