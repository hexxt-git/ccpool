#!/usr/bin/env node
import { Command } from "commander";
import { runApp } from "./commands/app.js";
import { runStatus } from "./commands/status.js";
import { runHistory } from "./commands/history.js";
import { runTui } from "./commands/tui.js";
import { runInit } from "./commands/init.js";
import { runDoctor } from "./commands/doctor.js";
import { runConfigGet, runConfigSet } from "./commands/config.js";
import { runStatusline } from "./commands/statusline.js";
import { runUsers } from "./commands/users.js";
import {
  runDaemonForeground,
  runDaemonRestart,
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
} from "./commands/daemon.js";

const program = new Command();

// Injected at build time by tsup from package.json (see tsup.config.ts); the
// `typeof` guard keeps `tsx` dev runs (where it isn't defined) working.
declare const __CLI_VERSION__: string;

program
  .name("ccpool")
  .description("a shared, live picture of one Claude account's usage and who's using it")
  .version(typeof __CLI_VERSION__ !== "undefined" ? __CLI_VERSION__ : "0.0.0-dev");

// Bare `ccpool` opens the TUI: onboarding when unconfigured, the live view
// otherwise (press `c` there to configure). The subcommands below remain as a
// scriptable fallback for everything the TUI does interactively.
program.action(async () => {
  await runApp();
});

program
  .command("init")
  .description("required first run: join the shared ledger with two passwords")
  .option("--reconfigure", "re-run the setup against the same identity")
  .option("--name <name>", "your name (letters, digits, hyphens); skips the prompt")
  .option(
    "--group-password <password>",
    "the group's password (prefer env CCPOOL_GROUP_PASSWORD in CI)"
  )
  .option(
    "--member-password <password>",
    "your member password (prefer env CCPOOL_MEMBER_PASSWORD in CI)"
  )
  .option("-y, --yes", "auto-confirm the write step (create the group)")
  .option("--no-daemon", "don't auto-start the background observer after setup")
  .action(async (opts) => {
    await runInit(opts);
  });

program
  .command("doctor")
  .description("re-run inspection + identity checks; change nothing")
  .action(async () => {
    await runDoctor();
  });

const daemon = program.command("daemon").description("the background observer process");
daemon
  .command("start")
  .description("start the daemon detached")
  .action(async () => {
    await runDaemonStart();
  });
daemon
  .command("stop")
  .description("stop the running daemon")
  .action(async () => {
    await runDaemonStop();
  });
daemon
  .command("status")
  .description("show whether the daemon is running and how fresh its state is")
  .action(async () => {
    await runDaemonStatus();
  });
daemon
  .command("restart")
  .description("stop then start the daemon")
  .action(async () => {
    await runDaemonRestart();
  });
daemon
  .command("run", { hidden: true })
  .description("run the daemon loop in the foreground (used internally by start)")
  .action(async () => {
    await runDaemonForeground();
  });

program
  .command("tui")
  .aliases(["live"])
  .description("live shared view of the account tank")
  .action(async () => {
    await runTui();
  });

program
  .command("status")
  .description("one-shot snapshot of the shared account tank")
  .action(async () => {
    await runStatus();
  });

program
  .command("history")
  .description("table of previous windows and who used each")
  .option("--cap <cap>", "which cap: 5h | weekly | opus", "5h")
  .option("--limit <n>", "how many recent windows to show", "20")
  .action(async (opts) => {
    await runHistory(opts);
  });

program
  .command("statusline")
  .description("compact one-line status for Claude Code's status bar (reads state.json)")
  .action(async () => {
    await runStatusline();
  });

program
  .command("users")
  .description("list participants (names) in the shared database")
  .action(async () => {
    await runUsers();
  });

const config = program.command("config").description("read or change local config");
config
  .command("get [key]")
  .description("print a config value (or all)")
  .action(async (key?: string) => {
    await runConfigGet(key);
  });
config
  .command("set <key> <value>")
  .description("change a config value, e.g. `ccpool config set name alex`")
  .action(async (key: string, value: string) => {
    await runConfigSet(key, value);
  });

program.parseAsync(process.argv);
