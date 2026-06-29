#!/usr/bin/env node
import { Command } from "commander";
import { runStatus } from "./commands/status.js";

const program = new Command();

program
  .name("ccshare")
  .description("a shared, live picture of one Claude account's usage and who's using it")
  .version("0.0.1");

program
  .command("status")
  .description("one-shot snapshot of the shared account tank")
  .action(async () => {
    await runStatus();
  });

program.parseAsync(process.argv);
