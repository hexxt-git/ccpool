import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import type { Config, StorageDriver } from "@ccshare/core";
import { inspectFor, type Classification } from "../../lib/setup.js";
import { Cell } from "../designs/parts.js";
import { P } from "../designs/palette.js";
import { DRIVERS, cycle, driverUrl, needsToken, FieldRow } from "../parts-extra.js";

type Phase = "edit" | "testing" | { done: Classification };

export function StorageScreen({
  config,
  onSave,
  onCancel,
  setFooter,
}: {
  config: Config;
  onSave: (driver: StorageDriver, url: string, token: string | undefined) => void;
  onCancel: () => void;
  setFooter: (txt: string) => void;
}): React.ReactElement {
  const { isRawModeSupported } = useStdin();

  const [driver, setDriver] = useState<StorageDriver>(config.storage?.driver ?? "libsql");
  const [url, setUrl] = useState(config.storage?.url ?? "");
  const [token, setToken] = useState(config.storage?.token ?? "");
  const [row, setRow] = useState(0);
  const [editing, setEditing] = useState(false);
  const [buf, setBuf] = useState("");
  const [phase, setPhase] = useState<Phase>("edit");

  const tokenNeeded = needsToken(driver, url);
  const rowsList: ("driver" | "url" | "token" | "action")[] = [
    "driver",
    "url",
    ...(tokenNeeded ? (["token"] as const) : []),
    "action",
  ];
  const cur = rowsList[Math.min(row, rowsList.length - 1)]!;
  const dirty = (): void => setPhase("edit");
  const testedOk =
    typeof phase === "object" && (phase.done.kind === "empty" || phase.done.kind === "ccshare");

  useEffect(() => {
    if (phase !== "testing") return;
    let cancelled = false;
    void inspectFor({ driver, url, token: token || undefined }).then((c) => {
      if (!cancelled) setPhase({ done: c });
    });
    return () => {
      cancelled = true;
    };
  }, [phase, driver, url, token]);

  useEffect(() => {
    if (cur === "driver") {
      setFooter("←→ pick driver · ↑↓ move · esc cancel");
    } else if (cur === "action") {
      setFooter("⏎ test / save · ↑↓ move · esc cancel");
    } else {
      setFooter("⏎ edit · ↑↓ move · esc cancel");
    }
  }, [cur, setFooter]);

  useInput(
    (input, key) => {
      if (editing) {
        if (key.return) {
          if (cur === "url") setUrl(buf.trim());
          if (cur === "token") setToken(buf.trim());
          dirty();
          setEditing(false);
        } else if (key.escape) setEditing(false);
        else if (key.backspace || key.delete) setBuf((b) => b.slice(0, -1));
        else if (input && !key.ctrl && !key.meta) setBuf((b) => b + input);
        return;
      }
      if (key.escape) return onCancel();
      if (key.upArrow || input === "k") setRow((r) => (r + rowsList.length - 1) % rowsList.length);
      else if (key.downArrow || input === "j") setRow((r) => (r + 1) % rowsList.length);
      else if (cur === "driver" && (key.leftArrow || key.rightArrow)) {
        setDriver((d) => cycle(DRIVERS, d, key.leftArrow ? -1 : 1));
        dirty();
      } else if (key.return) {
        if (cur === "url") {
          setBuf(url);
          setEditing(true);
        } else if (cur === "token") {
          setBuf(token);
          setEditing(true);
        } else if (cur === "action") {
          if (testedOk) onSave(driver, url.trim(), token.trim() || undefined);
          else setPhase("testing");
        }
      }
    },
    { isActive: !!isRawModeSupported }
  );

  const rowFocused = (k: string): boolean => cur === k;

  return (
    <Box flexDirection="column">
      <Text color={P.orange} bold>
        self-host storage settings
      </Text>
      <Text color={P.dim}>connection settings — tested before saving.</Text>
      <Box height={1} />

      <FieldRow label="driver" focused={rowFocused("driver")}>
        {DRIVERS.map((d) => (
          <Text key={d} color={d === driver ? P.cream : P.faint} bold={d === driver}>
            {d === driver ? `[${d}]` : ` ${d} `}
            {"  "}
          </Text>
        ))}
      </FieldRow>
      <FieldRow label="url" focused={rowFocused("url")} editing={editing && cur === "url"}>
        {editing && cur === "url" ? buf : url || <Text color={P.faint}>{driverUrl(driver)}</Text>}
      </FieldRow>
      {tokenNeeded ? (
        <FieldRow
          label="auth token"
          focused={rowFocused("token")}
          editing={editing && cur === "token"}
        >
          {editing && cur === "token" ? (
            "•".repeat(buf.length)
          ) : token ? (
            "•".repeat(token.length)
          ) : (
            <Text color={P.faint}>required for remote libsql</Text>
          )}
        </FieldRow>
      ) : null}

      <Box height={1} />
      <Box>
        <Cell w={18}>
          <Text color={rowFocused("action") ? P.orange : P.dim} bold={rowFocused("action")}>
            {rowFocused("action") ? "▸ " : "  "}connection
          </Text>
        </Cell>
        <ActionText phase={phase} />
      </Box>
    </Box>
  );
}

function ActionText({ phase }: { phase: Phase }): React.ReactElement {
  if (phase === "edit") return <Text color={P.cream}>▸ test connection</Text>;
  if (phase === "testing") return <Text color={P.amber}>checking connection…</Text>;
  const c = phase.done;
  switch (c.kind) {
    case "empty":
      return (
        <Text color={P.green} bold>
          ✓ empty database — ⏎ to initialize and save
        </Text>
      );
    case "ccshare":
      return (
        <Text color={P.green} bold>
          ✓ ccshare database — ⏎ to join and save
        </Text>
      );
    case "error":
      return <Text color={P.red}>✗ {c.message} — ⏎ to retry</Text>;
    case "foreign":
      return <Text color={P.red}>✗ database is not empty — pick another</Text>;
    case "ccshare-newer":
      return <Text color={P.red}>✗ newer ccshare schema — update ccshare</Text>;
    case "ccshare-foreign-account":
      return <Text color={P.red}>✗ bound to a different Claude account</Text>;
  }
}
