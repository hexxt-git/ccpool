import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import {
  isValidName,
  resolveAccount,
  resolveConfigDir,
  CcshareClient,
  type Config,
} from "@ccshare/core";
import { saveConfig, newSharedConfig } from "../../lib/config.js";
import { makeStorage } from "../../lib/storage.js";
import { resolveServerUrl, makeViewSource } from "../../lib/backend.js";
import { applySharedJoin } from "../../lib/setup.js";
import {
  isDaemonRunning,
  spawnDaemon,
  stopDaemonProcess,
  tailDaemonLog,
} from "../../commands/daemon.js";
import { Clawd, Cell, Rule } from "../designs/parts.js";
import { P } from "../designs/palette.js";
import { useTermSize } from "../use-term-size.js";
import { LEVELS, POLL_OPTIONS, cycle, FieldRow, type LogLevel } from "../parts-extra.js";
import { BackendScreen } from "./Backend.js";

/**
 * Tabbed configuration reached with `c` from the live view. Tab cycles tabs
 * forward, shift+tab back (same as the design switcher). Every change is written
 * to disk and reflected up so the live view updates; storage and cadence changes
 * restart the running daemon so it picks them up.
 */
const TABS = ["general", "daemon"] as const;

/** Restart a running daemon so it re-reads config (storage / cadence / level).
 * Returns whether a restart was actually issued. */
function restartIfRunning(cfg: Config): boolean {
  if (!isDaemonRunning(cfg)) return false;
  stopDaemonProcess(cfg);
  setTimeout(() => spawnDaemon(cfg), 600);
  return true;
}

export function ConfigScreen({
  config,
  onChange,
  onBack,
}: {
  config: Config;
  onChange: (cfg: Config) => void;
  onBack: () => void;
}): React.ReactElement {
  const { isRawModeSupported } = useStdin();
  const { cols, rows } = useTermSize();

  const [tab, setTab] = useState(0);
  const [backendOpen, setBackendOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = TABS[tab]!;
  const w = cols - 2; // fill the width (the outer box adds paddingX)
  const innerW = Math.max(10, w - 6); // inside the card's border + paddingX
  const [footer, setFooter] = useState("⇥ tab · ↑↓ move · esc back");

  // Transient confirmation shown under the card so changes aren't silent.
  const notify = (msg: string): void => {
    setFlash(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 2500);
  };
  useEffect(() => () => void (flashTimer.current && clearTimeout(flashTimer.current)), []);

  // tab forward, shift+tab back
  const cycleTab = (dir: 1 | -1): void => setTab((t) => (t + dir + TABS.length) % TABS.length);

  // reset footer if active tab changes or backend closes
  useEffect(() => {
    if (active === "daemon" || !backendOpen) {
      setFooter("⇥ tab · ↑↓ move · esc back");
    }
  }, [active, backendOpen]);

  return (
    <Box flexDirection="column" width={cols} height={Math.max(1, rows - 1)} paddingX={1}>
      <Box height={1} />
      <Box>
        <Clawd color={P.blue} />
        <Box flexDirection="column" marginLeft={3}>
          <Text color={P.blue} bold>
            configure
          </Text>
          <Box>
            {TABS.map((t, i) => (
              <Box key={t} marginRight={1}>
                <Text
                  color={i === tab ? P.cream : P.faint}
                  bold={i === tab}
                  backgroundColor={i === tab ? P.ghost : undefined}
                >
                  {" "}
                  {t}{" "}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      </Box>
      <Box height={1} />
      <Box
        width={w}
        flexDirection="column"
        borderStyle="round"
        borderColor={P.blue}
        paddingX={2}
        paddingY={1}
        flexShrink={0}
      >
        {active === "general" ? (
          backendOpen ? (
            <BackendScreen
              config={config}
              onApplied={(cfg, note) => {
                const restarted = restartIfRunning(cfg);
                onChange(cfg);
                notify(restarted ? `${note} · restarting daemon` : note);
                setBackendOpen(false);
              }}
              onCancel={() => setBackendOpen(false)}
              setFooter={setFooter}
            />
          ) : (
            <GeneralTab
              config={config}
              onChange={onChange}
              notify={notify}
              isActive={!!isRawModeSupported}
              onBack={onBack}
              onCycleTab={cycleTab}
              onOpenBackend={() => setBackendOpen(true)}
              setFooter={setFooter}
            />
          )
        ) : (
          <DaemonTab
            config={config}
            onChange={onChange}
            notify={notify}
            width={innerW}
            isActive={!!isRawModeSupported}
            onBack={onBack}
            onCycleTab={cycleTab}
          />
        )}
      </Box>
      <Box marginTop={1} paddingX={1}>
        {flash ? (
          <Text color={flash.startsWith("✗") ? P.red : P.green}>{flash}</Text>
        ) : (
          <Text color={P.ghost}> </Text>
        )}
      </Box>
      <Box flexGrow={1} />
      <Box justifyContent="flex-end">
        <Text color={P.dim}>{footer}</Text>
      </Box>
    </Box>
  );
}

type NameState = "idle" | "checking" | "login" | "signup";

function GeneralTab({
  config,
  onChange,
  notify,
  isActive,
  onBack,
  onCycleTab,
  onOpenBackend,
  setFooter,
}: {
  config: Config;
  onChange: (cfg: Config) => void;
  notify: (msg: string) => void;
  isActive: boolean;
  onBack: () => void;
  onCycleTab: (dir: 1 | -1) => void;
  onOpenBackend: () => void;
  setFooter: (txt: string) => void;
}): React.ReactElement {
  const [row, setRow] = useState(0);
  const [editing, setEditing] = useState(false);
  const [buf, setBuf] = useState("");

  // name change flow state
  const [nameState, setNameState] = useState<NameState>("idle");
  const [pendingName, setPendingName] = useState("");
  const [memberPassword, setMemberPassword] = useState("");
  const [groupPassword, setGroupPassword] = useState("");

  const commitNameSelfhost = (name: string): void => {
    if (name === config.name) return;
    const next: Config = { ...config, name };
    void (async () => {
      await saveConfig(next);
      const storage = makeStorage(next);
      try {
        if ((await storage.inspect()).kind === "ccshare") await storage.upsertUser(name);
      } catch {
        // Ignore inspection and upsert errors on name commit in self-host mode
      } finally {
        await storage.close();
      }
    })();
    onChange(next);
    notify(`✓ name saved · ${name}`);
  };

  const setLevel = (level: LogLevel): void => {
    const next: Config = { ...config, logLevel: level };
    void saveConfig(next);
    const restarted = restartIfRunning(next);
    onChange(next);
    notify(restarted ? `✓ log level ${level} · restarting daemon` : `✓ log level ${level}`);
  };

  const getRows = (): string[] => {
    if (config.mode === "selfhost") return ["name", "backend", "logLevel"];
    switch (nameState) {
      case "checking":
        return ["name", "checking"];
      case "login":
        return ["name", "password", "submit"];
      case "signup":
        return ["name", "password", "group", "submit"];
      case "idle":
      default:
        return ["name", "backend", "logLevel"];
    }
  };

  const activeRows = getRows();
  const cur = activeRows[row]!;

  useEffect(() => {
    if (nameState !== "idle") {
      if (editing) {
        setFooter("⏎ set · esc cancel");
      } else if (cur === "submit") {
        setFooter(
          nameState === "login"
            ? "⏎ log in · ↑↓ move · esc cancel"
            : "⏎ sign up · ↑↓ move · esc cancel"
        );
      } else {
        setFooter("⏎ edit / check · ↑↓ move · esc cancel");
      }
    } else {
      setFooter("⇥ tab · ↑↓ move · esc back");
    }
  }, [nameState, editing, cur, setFooter]);

  useInput(
    (input, key) => {
      if (nameState === "checking") return;

      if (editing) {
        if (key.return) {
          if (cur === "name") {
            const clean = buf.replace(/[^A-Za-z0-9-]/g, "");
            if (!isValidName(clean)) {
              notify("✗ invalid name — letters, digits, hyphens");
              setEditing(false);
              return;
            }
            if (clean === config.name) {
              setEditing(false);
              return;
            }
            if (config.mode === "selfhost") {
              commitNameSelfhost(clean);
              setEditing(false);
            } else {
              setPendingName(clean);
              setEditing(false);
              setNameState("checking");
              setRow(1);
              void (async () => {
                let viewSource;
                try {
                  viewSource = makeViewSource(config);
                  const view = await viewSource.fetchView();
                  const exists = view.users.some(
                    (u) => u.name.toLowerCase() === clean.toLowerCase()
                  );
                  if (exists) {
                    setNameState("login");
                  } else {
                    setNameState("signup");
                  }
                  setRow(1);
                  setBuf("");
                } catch (err) {
                  notify(`✗ check failed: ${(err as Error).message}`);
                  setNameState("idle");
                  setRow(0);
                  setPendingName("");
                } finally {
                  if (viewSource) await viewSource.close();
                }
              })();
            }
          } else if (cur === "password") {
            setMemberPassword(buf);
            setEditing(false);
            const nextIdx =
              activeRows.indexOf("group") !== -1
                ? activeRows.indexOf("group")
                : activeRows.indexOf("submit");
            setRow(nextIdx);
          } else if (cur === "group") {
            setGroupPassword(buf);
            setEditing(false);
            setRow(activeRows.indexOf("submit"));
          }
        } else if (key.escape) {
          setEditing(false);
        } else if (key.backspace || key.delete) {
          setBuf((b) => b.slice(0, -1));
        } else if (input && !key.ctrl && !key.meta) {
          setBuf((b) => b + input);
        }
        return;
      }

      if (key.tab) return onCycleTab(key.shift ? -1 : 1);
      if (key.escape) {
        if (nameState !== "idle") {
          setNameState("idle");
          setRow(0);
          setPendingName("");
          setMemberPassword("");
          setGroupPassword("");
          setBuf("");
          return;
        }
        return onBack();
      }

      if (key.upArrow || input === "k") {
        setRow((r) => (r + activeRows.length - 1) % activeRows.length);
      } else if (key.downArrow || input === "j") {
        setRow((r) => (r + 1) % activeRows.length);
      } else if (cur === "logLevel" && (key.leftArrow || key.rightArrow)) {
        setLevel(cycle([...LEVELS], config.logLevel as LogLevel, key.leftArrow ? -1 : 1));
      } else if (key.return) {
        if (cur === "name") {
          if (nameState !== "idle") {
            setNameState("idle");
            setRow(0);
            setPendingName("");
            setMemberPassword("");
            setGroupPassword("");
          }
          setBuf(config.name);
          setEditing(true);
        } else if (cur === "password") {
          setBuf(memberPassword);
          setEditing(true);
        } else if (cur === "group") {
          setBuf(groupPassword);
          setEditing(true);
        } else if (cur === "backend") {
          onOpenBackend();
        } else if (cur === "submit") {
          notify("submitting...");
          void (async () => {
            if (nameState === "login") {
              try {
                const configDir = resolveConfigDir();
                const acct = await resolveAccount(configDir);
                if (!acct?.hydrated) throw new Error("no Claude account found");
                const url = resolveServerUrl(config);
                const client = new CcshareClient(url);
                const auth = await client.login({
                  accountId: acct.id,
                  memberName: pendingName,
                  memberPassword: memberPassword,
                });
                const next = newSharedConfig({
                  serverUrl: url,
                  token: auth.token,
                  name: auth.memberName,
                  configDirs: [configDir],
                });
                await saveConfig(next);
                restartIfRunning(next);
                onChange(next);
                notify(`✓ switched name to ${auth.memberName}`);
                setNameState("idle");
                setRow(0);
                setPendingName("");
                setMemberPassword("");
                setGroupPassword("");
              } catch (err) {
                notify(`✗ error: ${(err as Error).message}`);
              }
            } else if (nameState === "signup") {
              try {
                const res = await applySharedJoin({
                  name: pendingName,
                  groupPassword: groupPassword,
                  memberPassword: memberPassword,
                  allowCreate: false,
                  config,
                });
                if (!res.ok) throw new Error(res.error);
                restartIfRunning(res.config);
                onChange(res.config);
                notify(`✓ registered user ${res.config.name}`);
                setNameState("idle");
                setRow(0);
                setPendingName("");
                setMemberPassword("");
                setGroupPassword("");
              } catch (err) {
                notify(`✗ error: ${(err as Error).message}`);
              }
            }
          })();
        }
      }
    },
    { isActive }
  );

  return (
    <Box flexDirection="column">
      <FieldRow
        label="your name"
        focused={row === activeRows.indexOf("name")}
        editing={editing && cur === "name"}
      >
        {editing && cur === "name" ? (
          buf
        ) : nameState !== "idle" ? (
          <Text color={P.orange}>{pendingName}</Text>
        ) : (
          config.name
        )}
      </FieldRow>

      {nameState !== "idle" && <Box height={1} />}

      {nameState === "checking" && (
        <Box marginLeft={2}>
          <Text color={P.dim}>checking user name...</Text>
        </Box>
      )}

      {nameState === "login" && (
        <Box marginLeft={2}>
          <Text color={P.dim}>member exists, enter password</Text>
        </Box>
      )}

      {nameState === "signup" && (
        <Box marginLeft={2}>
          <Text color={P.dim}>signing up new member</Text>
        </Box>
      )}

      {activeRows.includes("password") && (
        <FieldRow
          label="your password"
          focused={row === activeRows.indexOf("password")}
          editing={editing && cur === "password"}
        >
          {editing && cur === "password" ? (
            "•".repeat(buf.length)
          ) : memberPassword ? (
            "•".repeat(memberPassword.length)
          ) : (
            <Text color={P.faint}>enter password</Text>
          )}
        </FieldRow>
      )}

      {activeRows.includes("group") && (
        <FieldRow
          label="group password"
          focused={row === activeRows.indexOf("group")}
          editing={editing && cur === "group"}
        >
          {editing && cur === "group" ? (
            "•".repeat(buf.length)
          ) : groupPassword ? (
            "•".repeat(groupPassword.length)
          ) : (
            <Text color={P.faint}>enter group password</Text>
          )}
        </FieldRow>
      )}

      {activeRows.includes("submit") && (
        <Box flexDirection="column">
          <Box height={1} />
          <Box>
            <Cell w={18}>
              <Text color={cur === "submit" ? P.orange : P.dim} bold={cur === "submit"}>
                {cur === "submit" ? "▸ " : "  "}
                action
              </Text>
            </Cell>
            <Text color={cur === "submit" ? P.cream : P.dim}>
              {nameState === "login" ? "⏎ log in" : "⏎ sign up"}
            </Text>
          </Box>
        </Box>
      )}

      {nameState === "idle" && (
        <FieldRow label="backend" focused={row === activeRows.indexOf("backend")}>
          <Text>
            <Text color={P.cream}>
              {config.mode === "shared"
                ? "shared hosting"
                : (config.storage?.driver ?? "self-host")}
            </Text>
            <Text color={P.dim}>
              {" · "}
              {config.mode === "shared" ? resolveServerUrl(config) : (config.storage?.url ?? "")}
            </Text>
            {row === activeRows.indexOf("backend") ? (
              <Text color={P.faint}>{"   ⏎ change"}</Text>
            ) : null}
          </Text>
        </FieldRow>
      )}

      {nameState === "idle" && (
        <FieldRow label="log level" focused={row === activeRows.indexOf("logLevel")}>
          {LEVELS.map((l) => (
            <Text
              key={l}
              color={l === config.logLevel ? P.cream : P.faint}
              bold={l === config.logLevel}
            >
              {l === config.logLevel ? `[${l}]` : ` ${l} `}{" "}
            </Text>
          ))}
        </FieldRow>
      )}
    </Box>
  );
}

// ── daemon: start/stop · poll cadence · live log tail ─────────────────────────────
function DaemonTab({
  config,
  onChange,
  notify,
  width,
  isActive,
  onBack,
  onCycleTab,
}: {
  config: Config;
  onChange: (cfg: Config) => void;
  notify: (msg: string) => void;
  width: number;
  isActive: boolean;
  onBack: () => void;
  onCycleTab: (dir: 1 | -1) => void;
}): React.ReactElement {
  const [row, setRow] = useState(0); // 0 daemon · 1 poll
  const [running, setRunning] = useState(() => isDaemonRunning(config));
  const [logs, setLogs] = useState<string[]>(() => tailDaemonLog(config));
  const pollSeconds = Math.round(config.pollIntervalMs / 1000);

  // reflect real daemon status + tail the log while the tab is open
  useEffect(() => {
    const id = setInterval(() => {
      setRunning(isDaemonRunning(config));
      setLogs(tailDaemonLog(config));
    }, 1500);
    return () => clearInterval(id);
  }, [config]);

  const toggle = (): void => {
    if (running) {
      stopDaemonProcess(config);
      setRunning(false);
      notify("daemon stopped · usage is no longer recorded");
    } else {
      spawnDaemon(config);
      setRunning(true);
      notify("✓ daemon started");
    }
  };

  const setPoll = (dir: 1 | -1): void => {
    const seconds = cycle(POLL_OPTIONS, pollSeconds, dir);
    const next: Config = { ...config, pollIntervalMs: seconds * 1000 };
    void saveConfig(next);
    const restarted = restartIfRunning(next);
    onChange(next);
    notify(restarted ? `✓ poll ${seconds}s · restarting daemon` : `✓ poll ${seconds}s`);
  };

  useInput(
    (input, key) => {
      if (key.tab) return onCycleTab(key.shift ? -1 : 1);
      if (key.escape) return onBack();
      if (key.upArrow || input === "k") setRow(0);
      else if (key.downArrow || input === "j") setRow(1);
      else if (row === 0) {
        if (input === " " || key.return || key.leftArrow || key.rightArrow) toggle();
      } else {
        if (key.leftArrow) setPoll(-1);
        else if (key.rightArrow || key.return || input === " ") setPoll(1);
      }
    },
    { isActive }
  );

  return (
    <Box flexDirection="column">
      <Box>
        <Cell w={10}>
          <Text color={row === 0 ? P.orange : P.dim} bold={row === 0}>
            {row === 0 ? "▸ " : "  "}daemon
          </Text>
        </Cell>
        <Text color={running ? P.green : P.red} bold>
          {running ? "● running" : "○ stopped"}
        </Text>
        <Text color={row === 0 ? P.cream : P.faint}>
          {"    "}
          {running ? "⏎ stop" : "⏎ start"}
        </Text>
      </Box>
      <Box>
        <Cell w={10}>
          <Text color={row === 1 ? P.orange : P.dim} bold={row === 1}>
            {row === 1 ? "▸ " : "  "}poll
          </Text>
        </Cell>
        {POLL_OPTIONS.map((s) => (
          <Text key={s} color={s === pollSeconds ? P.cream : P.faint} bold={s === pollSeconds}>
            {s === pollSeconds ? `[${s}s]` : ` ${s}s `}
            {"  "}
          </Text>
        ))}
      </Box>
      <Text color={running ? P.faint : P.amber}>
        {running
          ? "stop the daemon and usage stops being recorded."
          : "usage is not recorded while the daemon is stopped."}
      </Text>
      <Box height={1} />
      <Box justifyContent="space-between">
        <Text color={P.dim} bold>
          recent activity
        </Text>
        <Text color={running ? P.green : P.faint}>{running ? "● live" : "○ paused"}</Text>
      </Box>
      <Rule w={width} color={P.ghost} />
      {logs.length === 0 ? (
        <Text color={P.faint}>{"  — no log output yet —"}</Text>
      ) : (
        logs.map((l, i) => (
          <Text key={i} color={/\bWARN\b|\bERROR\b/.test(l) ? P.amber : P.dim} wrap="truncate-end">
            {l}
          </Text>
        ))
      )}
    </Box>
  );
}
