#!/usr/bin/env node
import React from "react";
import { render, Box, Text } from "ink";

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

function Section({ label, key5h }: { label: string; key5h: boolean }) {
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
          <Bar pct={key5h ? m.used5h : m.used7d} />
        </Box>
      ))}
    </Box>
  );
}

function App() {
  return (
    <Box flexDirection="column" padding={1} borderStyle="single" borderColor="gray">
      <Box marginBottom={1}>
        <Text color="gray" dimColor>
          ccshare v0.1 &nbsp;·&nbsp; logged in as{" "}
        </Text>
        <Text color="white">bob</Text>
      </Box>

      <Section label="5-hour window" key5h={true} />
      <Section label="weekly window" key5h={false} />

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          next 5h reset{" "}
        </Text>
        <Text color="white">2h 14m &nbsp;</Text>
        <Text color="gray" dimColor>
          weekly reset{" "}
        </Text>
        <Text color="white">4d 07h</Text>
      </Box>

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          press{" "}
        </Text>
        <Text color="white">q</Text>
        <Text color="gray" dimColor>
          {" "}
          to quit
        </Text>
      </Box>
    </Box>
  );
}

render(<App />);
