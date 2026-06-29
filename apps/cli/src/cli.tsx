#!/usr/bin/env node
import { Command } from "commander";
import { runStatus } from "./commands/status.js";
import { runInit } from "./commands/init.js";
import { runDoctor } from "./commands/doctor.js";
import { runConfigGet, runConfigSet } from "./commands/config.js";

const program = new Command();

program
  .name("ccshare")
  .description("a shared, live picture of one Claude account's usage and who's using it")
  .version("0.0.1");

program
  .command("init")
  .description("required first run: pick storage, enter URL, inspect, set up or join")
  .option("--reconfigure", "re-run storage selection against the same identity")
  .option("--driver <driver>", "storage driver (libsql|postgres|sqlite); skips the prompt")
  .option("--url <url>", "database URL; skips the prompt")
  .option("--token <token>", "auth token for a remote database")
  .option("--name <name>", "your name (letters, digits, hyphens); skips the prompt")
  .option("-y, --yes", "auto-confirm setting up an empty database")
  .action(async (opts) => {
    await runInit(opts);
  });

program
  .command("doctor")
  .description("re-run inspection + identity checks; change nothing")
  .action(async () => {
    await runDoctor();
  });

program
  .command("status")
  .description("one-shot snapshot of the shared account tank")
  .action(async () => {
    await runStatus();
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
  .description("change a config value, e.g. `ccshare config set name alex`")
  .action(async (key: string, value: string) => {
    await runConfigSet(key, value);
  });

program.parseAsync(process.argv);
