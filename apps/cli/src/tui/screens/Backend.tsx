import React, { useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import type { Config, Mode } from "@ccshare/core";
import { applySetup, applySharedJoin } from "../../lib/setup.js";
import { resolveServerUrl } from "../../lib/backend.js";
import { FieldRow } from "../parts-extra.js";
import { Cell } from "../designs/parts.js";
import { P } from "../designs/palette.js";
import { useTermSize } from "../use-term-size.js";
import { StorageScreen } from "./Storage.js";

/**
 * The backend chooser reached from the config "backend" row. It first asks how
 * the group's data is hosted, then branches:
 *  - shared hosting → the two-password join form (reuses {@link applySharedJoin},
 *    including the create-a-new-group confirmation);
 *  - self-host → the existing connect-and-test {@link StorageScreen}.
 *
 * Either branch persists the config itself (via setup.ts) and hands the saved
 * config up through {@link onApplied}; the parent restarts the daemon so it picks
 * up the new backend (in shared mode the bearer changed, so a restart is required
 * — see the daemon note in commands/config.ts).
 */

const MODES: { value: Mode; label: string; desc: string }[] = [
  { value: "shared", label: "shared hosting", desc: "the ccshare server — just two passwords" },
  { value: "selfhost", label: "self-host", desc: "your own database (libsql/sqlite/postgres)" },
];

type Commit = "idle" | "saving" | "error" | "confirm-create";
type Phase = "pick" | "shared" | "selfhost";
type Row = "group" | "member" | "action";

export function BackendScreen({
  config,
  onApplied,
  onCancel,
}: {
  config: Config;
  onApplied: (cfg: Config, note: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const { isRawModeSupported } = useStdin();
  const { cols, rows } = useTermSize();

  const [phase, setPhase] = useState<Phase>("pick");
  const [sel, setSel] = useState(() =>
    Math.max(
      0,
      MODES.findIndex((m) => m.value === config.mode)
    )
  );

  // shared-form state
  const [group, setGroup] = useState("");
  const [member, setMember] = useState("");
  const [row, setRow] = useState<Row>("group");
  const [editing, setEditing] = useState(false);
  const [buf, setBuf] = useState("");
  const [commit, setCommit] = useState<Commit>("idle");
  const [msg, setMsg] = useState<string | null>(null);

  const commitShared = (allowCreate: boolean): void => {
    setCommit("saving");
    setMsg(null);
    void (async () => {
      const res = await applySharedJoin({
        name: config.name,
        groupPassword: group,
        memberPassword: member,
        allowCreate,
      });
      if (res.ok) {
        onApplied(res.config, "✓ switched to shared hosting");
        return;
      }
      if (res.canCreate) {
        setMsg(res.error);
        setCommit("confirm-create");
      } else {
        setMsg(res.error);
        setCommit("error");
      }
    })();
  };

  useInput(
    (input, key) => {
      if (phase === "pick") {
        if (key.upArrow || input === "k") setSel((c) => (c + MODES.length - 1) % MODES.length);
        else if (key.downArrow || input === "j") setSel((c) => (c + 1) % MODES.length);
        else if (key.escape) onCancel();
        else if (key.return) setPhase(MODES[sel]!.value === "shared" ? "shared" : "selfhost");
        return;
      }
      if (phase !== "shared") return; // selfhost delegates to StorageScreen's own input

      if (editing) {
        if (key.return) {
          if (row === "group") setGroup(buf);
          else if (row === "member") setMember(buf);
          setEditing(false);
        } else if (key.escape) setEditing(false);
        else if (key.backspace || key.delete) setBuf((b) => b.slice(0, -1));
        else if (input && !key.ctrl && !key.meta) setBuf((b) => b + input);
        return;
      }
      if (commit === "saving") return;
      if (commit === "confirm-create") {
        if (input === "y" || input === "Y" || key.return) commitShared(true);
        else if (input === "n" || input === "N" || key.escape) setCommit("idle");
        return;
      }
      const order: Row[] = ["group", "member", "action"];
      if (key.escape) return setPhase("pick");
      if (key.upArrow || input === "k")
        setRow(order[(order.indexOf(row) + order.length - 1) % order.length]!);
      else if (key.downArrow || input === "j")
        setRow(order[(order.indexOf(row) + 1) % order.length]!);
      else if (key.return) {
        if (row === "group") {
          setBuf(group);
          setEditing(true);
        } else if (row === "member") {
          setBuf(member);
          setEditing(true);
        } else {
          if (commit === "error") setCommit("idle");
          commitShared(false);
        }
      }
    },
    { isActive: !!isRawModeSupported && phase !== "selfhost" }
  );

  if (phase === "selfhost") {
    return (
      <StorageScreen
        config={config}
        onSave={(driver, url, token) => {
          void (async () => {
            const next: Config = {
              ...config,
              mode: "selfhost",
              storage: { driver, url, token },
              server: undefined,
            };
            const res = await applySetup(next);
            if (res.ok) onApplied(res.config, res.note ?? "✓ switched to self-host");
            else {
              // Bounce back to the picker; the parent surfaces nothing, so show it here.
              setMsg(`✗ ${res.error}`);
              setPhase("pick");
            }
          })();
        }}
        onCancel={() => setPhase("pick")}
      />
    );
  }

  const w = Math.min(74, cols - 4);
  const serverUrl = resolveServerUrl(config);

  return (
    <Box flexDirection="column" width={cols} height={Math.max(1, rows - 1)} paddingX={1}>
      <Box flexGrow={1} />
      <Box
        alignSelf="center"
        flexDirection="column"
        width={w}
        borderStyle="round"
        borderColor={P.blue}
        paddingX={2}
        paddingY={1}
      >
        <Text color={P.blue} bold>
          backend
        </Text>

        {phase === "pick" ? (
          <>
            <Text color={P.dim}>how is the group&apos;s data hosted?</Text>
            <Box height={1} />
            {MODES.map((m, i) => (
              <Box key={m.value}>
                <Text color={i === sel ? P.orange : P.faint}>{i === sel ? "▸ " : "  "}</Text>
                <Cell w={16}>
                  <Text color={i === sel ? P.cream : P.dim} bold={i === sel}>
                    {m.label}
                    {m.value === config.mode ? " ·" : ""}
                  </Text>
                </Cell>
                <Text color={i === sel ? P.dim : P.faint}>{m.desc}</Text>
              </Box>
            ))}
            {msg ? (
              <Box marginTop={1}>
                <Text color={P.red}>{msg}</Text>
              </Box>
            ) : null}
          </>
        ) : (
          <>
            <Text color={P.dim}>
              join as <Text color={P.cream}>{config.name}</Text> · {serverUrl}
            </Text>
            <Box height={1} />
            <FieldRow
              label="group password"
              focused={row === "group"}
              editing={editing && row === "group"}
            >
              {editing && row === "group" ? (
                "•".repeat(buf.length)
              ) : group ? (
                "•".repeat(group.length)
              ) : (
                <Text color={P.faint}>everyone in the group shares this</Text>
              )}
            </FieldRow>
            <FieldRow
              label="your password"
              focused={row === "member"}
              editing={editing && row === "member"}
            >
              {editing && row === "member" ? (
                "•".repeat(buf.length)
              ) : member ? (
                "•".repeat(member.length)
              ) : (
                <Text color={P.faint}>protects your name from impersonation</Text>
              )}
            </FieldRow>
            <Box height={1} />
            <Box>
              <Cell w={18}>
                <Text color={row === "action" ? P.orange : P.dim} bold={row === "action"}>
                  {row === "action" ? "▸ " : "  "}connect
                </Text>
              </Cell>
              <ActionText commit={commit} msg={msg} />
            </Box>
          </>
        )}
      </Box>
      <Box flexGrow={1} />
      <Box justifyContent="center">
        <Text color={P.faint}>
          {phase === "pick"
            ? "↑↓ select · ⏎ next · esc cancel"
            : editing
              ? "⏎ set · esc cancel"
              : commit === "confirm-create"
                ? "y create · n back"
                : row === "action"
                  ? "⏎ join / save · ↑↓ move · esc back"
                  : "⏎ edit · ↑↓ move · esc back"}
        </Text>
      </Box>
    </Box>
  );
}

function ActionText({ commit, msg }: { commit: Commit; msg: string | null }): React.ReactElement {
  if (commit === "saving") return <Text color={P.amber}>joining…</Text>;
  if (commit === "error") return <Text color={P.red}>✗ {msg} — ⏎ retry</Text>;
  if (commit === "confirm-create") return <Text color={P.amber}>{msg} — create it? [y/n]</Text>;
  return <Text color={P.cream}>▸ join / save</Text>;
}
