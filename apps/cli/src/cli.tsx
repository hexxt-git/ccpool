#!/usr/bin/env node
import React from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { Command } from "commander";

// ── components ────────────────────────────────────────────────────────────────

const members = [
  { name: "alice", used5h: 62, used7d: 34, isYou: false },
  { name: "bob", used5h: 18, used7d: 41, isYou: true },
  { name: "carol", used5h: 20, used7d: 25, isYou: false },
];

function Bar({ pct, width = 20 }: { pct: number; width?: number }) {
  const filled = Math.round((pct / 100) * width);
  return (
    <Text>
      <Text color="white">{"█".repeat(filled)}</Text>
      <Text color="gray">{"░".repeat(width - filled)}</Text>
      <Text color="gray"> {String(pct).padStart(3)}%</Text>
    </Text>
  );
}

function Section({ label, keyField }: { label: string; keyField: "used5h" | "used7d" }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="gray" dimColor>
        {label.toUpperCase()}
      </Text>
      {members.map((m) => (
        <Box key={m.name} gap={2}>
          <Text color={m.isYou ? "white" : "gray"}>
            {m.isYou ? "▸" : " "} {m.name.padEnd(8)}
          </Text>
          <Bar pct={m[keyField]} />
        </Box>
      ))}
    </Box>
  );
}

function Dashboard() {
  const { exit } = useApp();

  useInput((input) => {
    if (input === "q") exit();
  });

  return (
    <Box flexDirection="column" padding={1} borderStyle="single" borderColor="gray">
      <Box marginBottom={1}>
        <Text color="gray" dimColor>
          ccshare v0.0.1 · logged in as{" "}
        </Text>
        <Text color="white">bob</Text>
      </Box>

      <Section label="5-hour window" keyField="used5h" />
      <Section label="weekly window" keyField="used7d" />

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          next 5h reset{" "}
        </Text>
        <Text color="white">2h 14m </Text>
        <Text color="gray" dimColor>
          · weekly reset{" "}
        </Text>
        <Text color="white">4d 07h</Text>
      </Box>

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          press <Text color="white">q</Text> to quit
        </Text>
      </Box>
    </Box>
  );
}

// ── cli ───────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("ccshare")
  .description("claude subscription sharing with fair usage limits for teams")
  .version("0.0.1");

program
  .option("-w, --watch", "live usage dashboard — stays active until you press q")
  .action((opts: { watch?: boolean }) => {
    if (opts.watch) {
      console.clear();
      render(<Dashboard />);
    } else {
      console.log("  No command given. Try:\n");
      console.log("    ccshare --watch    live usage dashboard");
      console.log("    ccshare --help     show all options\n");
      process.exit(0);
    }
  });

program.parse();
