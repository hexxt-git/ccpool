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
machine, everyone joins **one shared ledger** — hosted for you (just two
passwords) or a database you run yourself — and the tool shows:

- **how full each shared window is right now** (5-hour, weekly, weekly-Opus) with
  live reset countdowns — the account-wide truth from Anthropic's endpoint;
- the **per-person split** of who drove that usage, built from Claude Code activity
  seen while the daemon runs, credited to the active name on each machine — with
  each person's token total and whether they're active right now (anything untied to
  a known name shows as `unknown`).

> It does **not** increase anyone's limit, multiplex the subscription, or enforce
> anything. It makes shared usage _legible_ so a group can govern itself — deciding
> who backs off and when is left to the people, not the tool.

## 👾 How it works

- **Shared tank level** (the % bars) is one account-wide number every participant
  reads from Anthropic's usage endpoint.
- **Per-person split** is built locally: a background daemon tails the Claude Code
  transcripts on each machine and credits new activity to the active name, writing
  it to the shared DB. Summed across everyone, that's the breakdown.
- **No IPC.** The daemon writes an atomic local `state.json` and one batched
  ledger write per tick; the TUI and statusline just read. Nothing talks to
  another process directly.
- **Cheap to watch.** The live view refreshes every 2 seconds, but the heavy work
  only reruns when the ledger actually changed (a change-token / ETag check) — a
  steady-state refresh costs one single-row read or a bodyless HTTP 304.
- **Only new activity counts.** On startup the daemon baselines each transcript at
  its current end-of-file and ingests only lines appended after — old history is
  never backfilled.
- **Two ways to share.** _Shared hosting_ (default): everyone authenticates to the
  ccshare server with a group password plus a personal member password — nobody
  manages a database, and nobody can write usage as somebody else. _Self-host_:
  point everyone at your own libSQL/Turso or Postgres database.
- **Runs on Node (≥20) and Bun.**

---

## 🚀 Quick Start

### 1. Prerequisites

- [Node.js](https://nodejs.org) ≥ 20 (or [Bun](https://bun.sh)) and
  [pnpm](https://pnpm.io)
- Claude Code installed and signed in on each machine (ccshare reads the token it
  already stored — it never logs you in)
- A place for the shared ledger. Pick one at init:
  - **shared hosting** (default, zero setup): the ccshare server hosts your
    group's ledger; you only choose two passwords
  - **self-host**: your own database — a local file (`file:./ccshare.db`), a free
    hosted [Turso](https://turso.tech) / libSQL database (`libsql://…` plus an
    auth token), or a Postgres URL

### 2. Build the CLI

```bash
pnpm install
pnpm build
```

This produces the `ccshare` binary at `apps/cli/dist/cli.js`. Run it with
`node apps/cli/dist/cli.js <command>`, or link it for a global `ccshare`:

```bash
pnpm link:cli   # then just `ccshare <command>`
```

The examples below use `ccshare` for brevity.

### 3. Initialise (required first run)

```bash
ccshare        # unconfigured → a guided onboarding wizard; configured → the live view
```

Bare `ccshare` opens a TUI. On a fresh machine it walks you through onboarding one
step at a time: choose a **name** (letters, digits, hyphens), then how the group's
data is hosted.

**Shared hosting** (the default) asks for two passwords and nothing else:

- the **group password** — everyone in the group uses the same one; knowing it is
  what lets a machine join the group at all;
- your **member password** — yours alone; it protects your name, so nobody else
  can join or report usage as you.

The group itself is tied to the Claude account you're signed into (resolved
automatically — never typed). The first person to init creates the group (after a
confirmation); everyone after joins it with the group password.

**Self-host** keeps the classic flow: everyone points at the **same** database
URL — that URL is the join key. The wizard tests the connection and inspects the
database; on an empty database it asks before creating tables, and if the database
already contains another project it refuses rather than mixing in — ccshare needs
its own clean, dedicated database.

Once configured, `ccshare` opens straight to the live view (press **c** there to
reconfigure). The config screen's **backend** row switches between shared hosting
and self-host either way — pick a mode, then enter the two passwords (shared) or a
database URL (self-host); ccshare restarts the daemon onto the new backend. The
same flow is scriptable through the `ccshare init` flag command — every prompt has
a flag, so it runs non-interactively:

```bash
# shared hosting (prefer the env vars in CI — flags leak into shell history)
CCSHARE_GROUP_PASSWORD=… CCSHARE_MEMBER_PASSWORD=… \
  ccshare init --mode shared --name sam --yes

# self-host
ccshare init --mode selfhost --driver libsql --url "file:./ccshare.db" --name sam --yes
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
ccshare            # opens the TUI: onboarding if unconfigured, else the live view
                   #   press c to configure (name, backend, daemon)
ccshare tui        # jump straight to the live shared view (alias: ccshare live)
                   #   Tab switch view (⇧Tab reverses) · ↑↓ scroll · r refresh · q quit
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
(**overview · split · mono**, cycle with `Tab`, `⇧Tab` reverses), per-person token
totals, and scrolling for large groups. The views fill the terminal and reflow on
resize; when the database is unreachable but the tank is still cached, the member
table shows greyed `xxxx` placeholder rows and a "can't reach the database" line
until it's back.

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
ccshare users                       # list participants in the shared ledger
ccshare config set name alex        # hand off the machine to another person
ccshare config get                  # show current config
```

Names are just labels, not machines (letters, digits, and hyphens, up to 32
chars) — several people can share a machine and hand off by changing the name.
Whoever's name is set when activity is ingested gets credited. In self-host the
running daemon picks up the new name on its next tick; in shared hosting a hand-off
asks for the target member's password (names are protected) and mints a fresh
token, so ccshare restarts the daemon for you to pick it up. Adding a brand-new
member goes through `ccshare init`.

ccshare deliberately has **no budgets or quotas** — it reports the reality of who
used what and leaves it to the group to coordinate how much anyone should use.

---

## 🖥️ Running your own server (optional)

The shared-hosting server is open too. It's multi-tenant (many groups on one
server, each group's ledger isolated in its own Postgres schema) and needs only a
Postgres URL:

```bash
DATABASE_URL=postgres://user:pass@host/db PORT=8787 node apps/server/dist/index.js
```

Point CLIs at it with `CCSHARE_SERVER_URL=https://your-host` when running
`ccshare init`. Run it behind TLS — the CLI refuses plain `http://` for anything
but localhost, because the bearer token rides on every request. Passwords are
stored as salted scrypt hashes and tokens as sha256 hashes; the server never keeps
a usable credential.

## 🗂️ Project layout

```
packages/
  core/               # runtime-agnostic domain logic: Storage + IngestSink/ViewSource
  storage-libsql/     # self-host adapter (file: and libsql://)
  storage-postgres/   # adapter for self-hosters and the server (schema per group)
  daemon/             # the background observer (poll + jsonl + state.json)
apps/
  cli/                # Commander + Ink CLI
  server/             # multi-tenant shared-hosting server (Hono + Postgres)
  web/                # marketing site (Astro)
```

Config lives in `~/.ccshare/` (`config.json`, the per-account `state.json`, logs,
and a `0600` token file holding the DB token or the server bearer). Override the
location with `CCSHARE_DIR`.

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

The Postgres-gated suites (the storage-postgres contract and the server
integration tests) only run when `CCSHARE_TEST_PG_URL` is set. The `Makefile`
spins a throwaway Docker Postgres for them on port 5433 (isolated from any local
Postgres on 5432):

```bash
make db-up        # start the dev Postgres (waits until ready)
make test-pg      # db-up, then run the PG-gated suites against it
make db-reset     # wipe it clean
make db-down      # stop and remove it
make db-psql      # psql shell · make db-url prints the connection URL
```

---

## 🤝 Contributing

Contributions welcome — bugs, features, or docs. See the
[GitHub repository](https://github.com/hexxt-git/ccshare) to get started.

## 📜 License

Open-sourced under the MIT License.
