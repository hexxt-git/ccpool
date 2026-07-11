# ccpool 👾

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-black?style=flat-square&logo=node.js)](https://nodejs.org)
[![Bun](https://img.shields.io/badge/bun-supported-black?style=flat-square&logo=bun)](https://bun.sh)
[![claude-code](https://img.shields.io/badge/claude--code-black?style=flat-square)](https://claude.ai/code)

**Anthropic tells you the account is at 60%. ccpool tells you who got it there.**

When a group shares one Claude subscription (Pro or Max), everyone collides on the same limits: someone burns the 5-hour window by noon, someone quietly eats the weekly cap, and nobody finds out until it's gone. ccpool gives the group a live, shared view of the account's usage broken down by person, so fair use becomes something you can see and negotiate instead of guess at.

<img width="1072" height="549" alt="2026-07-11_23-20-31" src="https://github.com/user-attachments/assets/aa9f9e96-e577-4793-a79e-9da916bcc459" />

Available as a terminal dashboard (`ccpool tui`), a one-shot snapshot (`ccpool status`), and a Claude Code statusline (`ccpool statusline`).

---

## What you get

- Live usage bars for all three limits (the 5-hour window, the weekly cap, and the weekly Opus cap) with a countdown to each reset. These are pulled from Anthropic's own usage endpoint, so they match what the account enforces.
- A per-person breakdown: each member's share of each limit, their token count, and whether they're coding right now.
- A statusline for Claude Code, so you can watch the shared limits without leaving your editor.

> Usage that ccpool can't tie to a person (someone using claude.ai in the browser, for example) shows up as `unknown`. And to be clear about what ccpool is: it observes and reports. It can't raise your limits or block anyone, and it deliberately has no budgets or quotas. It makes the sharing visible and leaves fair use to the group.

---

## How it works

Everyone in the group runs ccpool on their own machine and joins one shared ledger. A small background daemon on each machine checks Anthropic's usage endpoint for the account-wide limits, watches your local Claude Code activity to figure out which part of that usage is yours, and writes both to the ledger under your name. Put everyone's entries together and you get one set of account-wide bars, split by person.

ccpool is read-only: it never proxies your requests or touches your login. It reads the token Claude Code already saved and the transcripts on your disk, and it only counts activity from the moment you start the daemon, not your history.

The ledger lives on a ccpool server. By default that's the hosted one, so there's nothing to deploy, but the server is open source and a group can [run its own](#%EF%B8%8F-self-hosting-the-server).

---

## Requirements

- [Node.js](https://nodejs.org) ≥ 20 (or [Bun](https://bun.sh))
- Claude Code installed and signed in on each machine

---

## Quick Start

```bash
npm install -g ccpool   # or run it once with: npx ccpool@latest
ccpool                  # onboarding, then the live view
```

The first run walks you through onboarding: pick a name, a **group password** everyone in the group shares (it's what lets a machine join), and a **member password** that's yours alone (it stops anyone else from reporting usage under your name). ccpool detects which Claude account you're on and starts the daemon for you. From then on `ccpool` opens straight to the live view.

The first person to run it creates the group; everyone after joins with the group password. Onboarding is also scriptable: every prompt has a flag (`ccpool init --name sam --yes`, with `CCPOOL_GROUP_PASSWORD` / `CCPOOL_MEMBER_PASSWORD` for CI).

<img width="1498" height="855" alt="image" src="https://github.com/user-attachments/assets/e9a96c82-5313-43e3-be2f-3703da8e28e0" />
> there are multiple views

---

## Usage

```bash
# the live shared view (opens onboarding if not set up yet)
ccpool

# print a one-shot snapshot and exit
ccpool status

# compact one-liner for Claude Code's status bar
ccpool statusline

# list everyone in the group
ccpool users

# hand this machine off to another person
ccpool config set name alex
```

`ccpool` and `ccpool status` show the same thing: the overall account tank on top and each person's slice below it.

```
 ▐▛███▜▌   ccpool · status  ·  you are sam
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

Usage is credited to whatever name the machine is set to, so switching the name switches who gets credited. The switch asks for that person's member password.

---

## 🖥️ Self-hosting the server

The server is multi-tenant (many groups on one server, each ledger isolated by a `group_id` in one shared database) and runs on **libSQL**. One `DATABASE_URL` covers both a local SQLite file and a remote `libsql://` (Turso):

```bash
# local file
DATABASE_URL=file:/var/lib/ccpool/server.db PORT=8787 node apps/server/dist/index.js

# remote libSQL / Turso
DATABASE_URL=libsql://your-db.turso.io CCPOOL_DB_AUTH_TOKEN=… PORT=8787 node apps/server/dist/index.js
```

Point CLIs at your server with `CCPOOL_SERVER_URL=https://your-host` when running `ccpool init`. Run it behind TLS: the bearer token rides on every request, so the CLI refuses plain `http://` for anything but localhost. Passwords are stored as salted scrypt hashes and tokens as sha256 hashes; the server never keeps a usable credential.

## 🗂️ Project layout

```
packages/
  core/               # runtime-agnostic domain logic: Storage + IngestSink/ViewSource
  storage-libsql/     # the libSQL backend — server-side, the only DB code (file: and libsql://)
  daemon/             # the background observer (poll + jsonl + state.json)
apps/
  cli/                # Commander + Ink CLI (HTTP client only — never opens a DB)
  server/             # multi-tenant server (Hono; libSQL)
  web/                # marketing site (Astro)
```

Config lives in `~/.ccpool/` (`config.json`, the per-account `state.json`, logs, and a `0600` token file holding the server bearer). Override the location with `CCPOOL_DIR`.

## 🧪 Development

```bash
pnpm build        # build every package
pnpm type-check   # type-check the workspace
pnpm lint
pnpm test         # run the suite on Node
pnpm test:bun     # run the same suite on Bun
```

CI runs the full suite on both Node and Bun. The storage and registry contract suites and the server integration tests use a libSQL `:memory:` database, so nothing needs to be provisioned or spun up.

---

## 🤝 Contributing

Contributions welcome, whether bugs, features, or docs. See the [GitHub repository](https://github.com/hexxt-git/ccpool) to get started.

## 📜 License

Open-sourced under the MIT License.
