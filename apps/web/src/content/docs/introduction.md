---
title: Introduction
description: What ccshare is and why it exists.
---

## What is ccshare?

ccshare is a command-line tool for people sharing a single Claude subscription across a team or household.

Claude enforces usage limits on two windows:

- **5-hour rolling window** — a short burst limit reset every 5 hours
- **Weekly window** — a broader cap that resets each week

Without coordination, one person can exhaust the 5-hour window for everyone else. ccshare makes that visible and manageable.

## How it works

ccshare maintains a shared usage ledger (local or synced) and exposes a simple CLI to:

- Check how much quota remains in the current window
- See each member's share of recent usage
- Get notified when it's safe to use Claude again

## Design philosophy

No servers required by default. No accounts. Just a file, a CLI, and a shared folder (or a git repo).
