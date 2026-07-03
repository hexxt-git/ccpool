import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import {
  isValidName,
  resolveConfigDir,
  type Config,
  type Mode,
  type StorageDriver,
} from "@ccshare/core";
import { newConfig } from "../../lib/config.js";
import {
  applySetup,
  applySharedJoin,
  inspectFor,
  probeSharedGroup,
  type Classification,
  type SharedProbe,
} from "../../lib/setup.js";
import { spawnDaemon, stopDaemonProcess } from "../../commands/daemon.js";
import { Clawd } from "../designs/parts.js";
import { P } from "../designs/palette.js";
import { useTermSize } from "../use-term-size.js";
import { DRIVERS, DRIVER_DESC, driverUrl, needsToken } from "../parts-extra.js";

type StepKey =
  | "name"
  | "mode"
  | "driver"
  | "url"
  | "token"
  | "inspect"
  | "groupPassword"
  | "groupPasswordConfirm"
  | "memberPassword"
  | "memberPasswordConfirm"
  | "done";

const ORDER: StepKey[] = [
  "name",
  "mode",
  "driver",
  "url",
  "token",
  "inspect",
  "groupPassword",
  "groupPasswordConfirm",
  "memberPassword",
  "memberPasswordConfirm",
  "done",
];

const STEP_LABEL: Record<StepKey, string> = {
  name: "Name",
  mode: "Hosting",
  driver: "Storage driver",
  url: "Database URL",
  token: "Auth token",
  inspect: "Database action",
  groupPassword: "Group password",
  groupPasswordConfirm: "Confirm group password",
  memberPassword: "Member password",
  memberPasswordConfirm: "Confirm member password",
  done: "Done",
};

const MODES: { value: Mode; label: string; desc: string }[] = [
  { value: "shared", label: "shared hosting", desc: "the ccshare server — just two passwords" },
  { value: "selfhost", label: "self-host", desc: "your own database (libsql/sqlite/postgres)" },
];

interface Answers {
  name?: string;
  mode?: Mode;
  driver?: StorageDriver;
  url?: string;
  token?: string;
  groupPassword?: string;
  groupPasswordConfirm?: string;
  memberPassword?: string;
  memberPasswordConfirm?: string;
  dbAction?: "initialize" | "join";
}

const stepVisible = (k: StepKey, a: Answers, probe: SharedProbe | "checking" | null): boolean => {
  const shared = a.mode === "shared";
  const groupExists = probe && typeof probe === "object" && probe.ok && probe.groupExists;
  const memberExists = probe && typeof probe === "object" && probe.ok && probe.memberExists;

  switch (k) {
    case "driver":
    case "url":
    case "inspect":
      return !shared;
    case "token":
      return !shared && needsToken(a.driver ?? "libsql", a.url ?? "");
    case "groupPassword":
      return shared;
    case "groupPasswordConfirm":
      return shared && !groupExists; // only if setting up a new group
    case "memberPassword":
      return shared;
    case "memberPasswordConfirm":
      return shared && (!groupExists || !memberExists); // only if signing up a new group or member
    default:
      return true;
  }
};

type Commit = "idle" | "saving" | "error";

export function InitScreen({
  onDone,
  onQuit,
  onCancel,
  initialConfig,
}: {
  onDone: (cfg: Config) => void;
  onQuit: () => void;
  onCancel?: () => void;
  initialConfig?: Config | null;
}): React.ReactElement {
  const { isRawModeSupported } = useStdin();
  const { cols, rows } = useTermSize();

  const [answers, setAnswers] = useState<Answers>(() => {
    if (!initialConfig) return {};
    return {
      name: initialConfig.name,
      mode: initialConfig.mode,
      driver: initialConfig.storage?.driver,
      url: initialConfig.storage?.url,
      token: initialConfig.storage?.token,
    };
  });
  const [step, setStep] = useState<StepKey>("name");
  const [buf, setBuf] = useState("");
  const [sel, setSel] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const [inspect, setInspect] = useState<Classification | "checking">("checking");
  const [commit, setCommit] = useState<Commit>("idle");
  const [commitErr, setCommitErr] = useState<string | null>(null);
  const [probe, setProbe] = useState<SharedProbe | "checking" | null>(null);

  const visible = ORDER.filter((k) => stepVisible(k, answers, probe));
  const stepNo = visible.indexOf(step) + 1;
  const isShared = answers.mode === "shared";

  const enter = (key: StepKey, a: Answers): void => {
    setStep(key);
    setErr(null);
    setBuf(
      key === "url"
        ? (a.url ?? "")
        : key === "token"
          ? (a.token ?? "")
          : key === "name"
            ? (a.name ?? "")
            : key === "groupPassword"
              ? (a.groupPassword ?? "")
              : key === "groupPasswordConfirm"
                ? (a.groupPasswordConfirm ?? "")
                : key === "memberPassword"
                  ? (a.memberPassword ?? "")
                  : key === "memberPasswordConfirm"
                    ? (a.memberPasswordConfirm ?? "")
                    : ""
    );
    setSel(
      key === "mode"
        ? Math.max(
            0,
            MODES.findIndex((m) => m.value === (a.mode ?? "shared"))
          )
        : Math.max(0, DRIVERS.indexOf(a.driver ?? "libsql"))
    );
    if (key === "inspect") setInspect("checking");
    if (key === "done") {
      setCommit("idle");
      setCommitErr(null);
    }
  };

  const advance = (patch: Answers): void => {
    const next = { ...answers, ...patch };
    setAnswers(next);
    const vis = ORDER.filter((k) => stepVisible(k, next, probe));
    const nk = vis[vis.indexOf(step) + 1];
    if (nk) enter(nk, next);
  };

  const back = (): void => {
    const idx = visible.indexOf(step);
    if (idx <= 0) {
      if (onCancel) onCancel();
      else onQuit();
      return;
    }
    enter(visible[idx - 1]!, answers);
  };

  // Probe the server once the group picks shared hosting, so the account line and
  // the create/join wording are ready by the group-password step.
  useEffect(() => {
    if (answers.mode !== "shared" || !answers.name) {
      setProbe(null);
      return;
    }
    let cancelled = false;
    setProbe("checking");
    void probeSharedGroup(answers.name).then((r) => {
      if (!cancelled) setProbe(r);
    });
    return () => {
      cancelled = true;
    };
  }, [answers.mode, answers.name]);

  // connect + inspect when we reach (or retry) the database step (self-host)
  useEffect(() => {
    if (step !== "inspect" || inspect !== "checking") return;
    let cancelled = false;
    void inspectFor({
      driver: answers.driver ?? "libsql",
      url: answers.url ?? "",
      token: answers.token,
    }).then((c) => {
      if (!cancelled) setInspect(c);
    });
    return () => {
      cancelled = true;
    };
  }, [step, inspect, answers.driver, answers.url, answers.token]);

  const finish = async (): Promise<void> => {
    setCommit("saving");
    setCommitErr(null);

    // Stop existing daemon if re-initializing
    if (initialConfig) {
      try {
        stopDaemonProcess(initialConfig);
      } catch {
        // ignore errors stopping existing daemon
      }
    }

    if (isShared) {
      const groupExists = probe && typeof probe === "object" && probe.ok && probe.groupExists;
      const res = await applySharedJoin({
        name: answers.name!,
        groupPassword: answers.groupPassword!,
        memberPassword: answers.memberPassword!,
        allowCreate: !groupExists,
      });
      if (!res.ok) {
        setCommitErr(res.error);
        setCommit("error");
        return;
      }
      spawnDaemon(res.config);
      onDone(res.config);
      return;
    }

    const cfg = newConfig({
      driver: answers.driver!,
      url: answers.url!,
      token: answers.token || undefined,
      name: answers.name!,
      configDirs: [resolveConfigDir()],
    });
    const res = await applySetup(cfg);
    if (!res.ok) {
      setCommitErr(res.error);
      setCommit("error");
      return;
    }
    spawnDaemon(res.config);
    onDone(res.config);
  };

  const getHeading = (): string => {
    const groupExists = probe && typeof probe === "object" && probe.ok && probe.groupExists;
    const memberExists = probe && typeof probe === "object" && probe.ok && probe.memberExists;

    switch (step) {
      case "name":
        return `${stepNo}. What is your name?`;
      case "mode":
        return `${stepNo}. How is the group's data hosted?`;
      case "driver":
        return `${stepNo}. Select database driver:`;
      case "url":
        return `${stepNo}. Enter database URL:`;
      case "token":
        return `${stepNo}. Enter database auth token:`;
      case "inspect":
        return `${stepNo}. Verify connection:`;
      case "groupPassword":
        return `${stepNo}. ${
          groupExists
            ? "Enter the group password (set by your team):"
            : "Set a group password (everyone will use this to join):"
        }`;
      case "groupPasswordConfirm":
        return `${stepNo}. Confirm group password:`;
      case "memberPassword":
        return `${stepNo}. ${
          groupExists && memberExists
            ? "Enter your member password:"
            : `Set a password for "${answers.name}" (protects your name from impersonation):`
        }`;
      case "memberPasswordConfirm":
        return `${stepNo}. Confirm your member password:`;
      case "done":
        return "Ready to finalize configuration";
    }
  };

  const getPlaceholder = (): string => {
    switch (step) {
      case "name":
        return "letters, digits, hyphens";
      case "url":
        return `⏎ for default: ${driverUrl(answers.driver ?? "libsql")}`;
      case "groupPassword":
        return "at least 8 characters";
      case "groupPasswordConfirm":
        return "re-type group password to confirm";
      case "memberPassword":
        return "at least 8 characters";
      case "memberPasswordConfirm":
        return "re-type member password to confirm";
      case "token":
        return "blank if none";
      default:
        return "";
    }
  };

  const inspectKind = typeof inspect === "string" ? inspect : inspect.kind;
  const isMasked =
    step === "token" ||
    step === "groupPassword" ||
    step === "groupPasswordConfirm" ||
    step === "memberPassword" ||
    step === "memberPasswordConfirm";

  useInput(
    (input, key) => {
      if (
        step === "name" ||
        step === "url" ||
        step === "token" ||
        step === "groupPassword" ||
        step === "groupPasswordConfirm" ||
        step === "memberPassword" ||
        step === "memberPasswordConfirm"
      ) {
        if (key.return) {
          if (step === "name") {
            const v = buf.trim();
            if (!isValidName(v)) return setErr("letters, digits, and hyphens only");
            advance({ name: v });
          } else if (step === "url") {
            advance({ url: buf.trim() || driverUrl(answers.driver ?? "libsql") });
          } else if (step === "token") {
            advance({ token: buf.trim() });
          } else if (step === "groupPassword") {
            if (isShared) {
              if (probe === "checking") return;
              if (probe && typeof probe === "object" && !probe.ok) {
                setProbe("checking");
                void probeSharedGroup(answers.name).then((r) => {
                  setProbe(r);
                });
                return;
              }
            }
            const v = buf;
            if (v.length < 8) return setErr("at least 8 characters");
            advance({ groupPassword: v });
          } else if (step === "groupPasswordConfirm") {
            const v = buf;
            if (v !== answers.groupPassword) return setErr("passwords do not match");
            advance({ groupPasswordConfirm: v });
          } else if (step === "memberPassword") {
            const v = buf;
            if (v.length < 8) return setErr("at least 8 characters");
            advance({ memberPassword: v });
          } else if (step === "memberPasswordConfirm") {
            const v = buf;
            if (v !== answers.memberPassword) return setErr("passwords do not match");
            advance({ memberPasswordConfirm: v });
          }
        } else if (key.escape) back();
        else if (key.backspace || key.delete) {
          if (
            isShared &&
            step === "groupPassword" &&
            (probe === "checking" || (probe && typeof probe === "object" && !probe.ok))
          )
            return;
          setBuf((b) => b.slice(0, -1));
        } else if (input && !key.ctrl && !key.meta) {
          if (
            isShared &&
            step === "groupPassword" &&
            (probe === "checking" || (probe && typeof probe === "object" && !probe.ok))
          )
            return;
          setBuf((b) => b + input);
        }
        return;
      }
      if (step === "mode") {
        if (key.upArrow || input === "k") setSel((c) => (c + MODES.length - 1) % MODES.length);
        else if (key.downArrow || input === "j") setSel((c) => (c + 1) % MODES.length);
        else if (/[1-9]/.test(input) && Number(input) <= MODES.length) setSel(Number(input) - 1);
        else if (key.return) advance({ mode: MODES[sel]!.value });
        else if (key.escape) back();
        return;
      }
      if (step === "driver") {
        if (key.upArrow || input === "k") setSel((c) => (c + DRIVERS.length - 1) % DRIVERS.length);
        else if (key.downArrow || input === "j") setSel((c) => (c + 1) % DRIVERS.length);
        else if (/[1-9]/.test(input) && Number(input) <= DRIVERS.length) setSel(Number(input) - 1);
        else if (key.return) advance({ driver: DRIVERS[sel]! });
        else if (key.escape) back();
        return;
      }
      if (step === "inspect") {
        if (inspectKind === "empty") {
          if (input === "y" || input === "Y") advance({ dbAction: "initialize" });
          else if (input === "n" || input === "N" || key.escape) back();
        } else if (inspectKind === "ccshare") {
          if (input === "y" || input === "Y") advance({ dbAction: "join" });
          else if (input === "n" || input === "N" || key.escape) back();
        } else if (inspectKind === "error") {
          if (key.return) setInspect("checking");
          else if (key.escape) back();
        } else if (key.return || key.escape) back();
        return;
      }
      // done
      if (commit === "saving") return;
      if (key.return) void finish();
      else if (key.escape) {
        if (commit === "error") setCommit("idle");
        else back();
      }
    },
    { isActive: !!isRawModeSupported }
  );

  const w = Math.min(88, cols - 4);
  const answered = visible.slice(0, stepNo - 1);
  const value = (k: StepKey): string =>
    k === "name"
      ? answers.name!
      : k === "mode"
        ? (MODES.find((m) => m.value === answers.mode)?.label ?? "")
        : k === "driver"
          ? answers.driver!
          : k === "url"
            ? answers.url!
            : k === "token"
              ? answers.token
                ? "•".repeat(Math.min(8, answers.token.length))
                : "none"
              : k === "groupPassword" ||
                  k === "groupPasswordConfirm" ||
                  k === "memberPassword" ||
                  k === "memberPasswordConfirm"
                ? "•".repeat(Math.min(8, (answers[k] ?? "").length))
                : k === "inspect"
                  ? answers.dbAction === "join"
                    ? "join existing"
                    : "initialize (empty)"
                  : "";

  const heading = getHeading();
  const placeholder = getPlaceholder();
  const hint =
    step === "mode" || step === "driver"
      ? "↑↓ select · ⏎ next · esc back"
      : step === "inspect"
        ? inspectKind === "empty" || inspectKind === "ccshare"
          ? "y / n · esc back"
          : inspectKind === "error"
            ? "⏎ retry · esc back"
            : "esc back"
        : step === "groupPassword" && probe === "checking"
          ? "checking server…"
          : step === "groupPassword" && probe && typeof probe === "object" && !probe.ok
            ? "⏎ retry · esc back"
            : step === "done"
              ? commit === "saving"
                ? "setting up…"
                : "⏎ continue · esc back"
              : "⏎ next · esc back";

  return (
    <Box flexDirection="column" width={cols} height={Math.max(1, rows - 1)} paddingX={1}>
      <Box flexGrow={1} />
      <Box
        alignSelf="center"
        flexDirection="column"
        width={w}
        borderStyle="round"
        borderColor={P.orange}
        paddingX={2}
        paddingY={1}
      >
        <Box alignSelf="center" marginBottom={1}>
          <Clawd color={P.orange} />
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          <Box justifyContent="space-between">
            <Text color={P.orange} bold>
              {initialConfig ? "ccshare re-initialization" : "ccshare setup"}
            </Text>
            <Text color={P.faint}>
              {stepNo}/{visible.length}
            </Text>
          </Box>
          <Text color={P.dim}>
            {initialConfig
              ? "Re-configuring settings on this machine."
              : "Not configured on this machine yet."}
          </Text>
        </Box>

        {isShared && probe && typeof probe === "object" && probe.ok ? (
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor={P.faint}
            paddingX={1}
            marginBottom={1}
            width={w - 6}
          >
            <Text color={P.dim}>
              Signed in: <Text color={P.cream}>{probe.account.email ?? probe.account.id}</Text>
            </Text>
            <Text color={P.dim}>
              Server: <Text color={P.cream}>{probe.serverUrl}</Text>
            </Text>
            <Box height={1} />
            <Text color={P.orange} bold>
              Status:{" "}
              {!probe.groupExists
                ? "Creating a new group (account)"
                : probe.memberExists
                  ? "Logging in (group & member exist)"
                  : "Signing up a new member in the existing group"}
            </Text>
          </Box>
        ) : null}

        {answered.map((k) => (
          <Box key={k}>
            <Text color={P.green}>✓ </Text>
            <Box width={26}>
              <Text color={P.dim}>{STEP_LABEL[k]}:</Text>
            </Box>
            <Text color={P.cream}>{value(k)}</Text>
          </Box>
        ))}

        <Box height={answered.length ? 1 : 0} />

        <Text color={P.orange} bold>
          {heading}
        </Text>
        <Box height={1} />

        {step === "mode" ? (
          <Box flexDirection="column">
            {MODES.map((m, i) => (
              <Box key={m.value}>
                <Text color={i === sel ? P.orange : P.faint}>{i === sel ? "▸ " : "  "}</Text>
                <Box width={16}>
                  <Text color={i === sel ? P.cream : P.dim} bold={i === sel}>
                    {m.label}
                  </Text>
                </Box>
                <Text color={i === sel ? P.dim : P.faint}>{m.desc}</Text>
              </Box>
            ))}
          </Box>
        ) : step === "driver" ? (
          <Box flexDirection="column">
            {DRIVERS.map((d, i) => (
              <Box key={d}>
                <Text color={i === sel ? P.orange : P.faint}>{i === sel ? "▸ " : "  "}</Text>
                <Box width={12}>
                  <Text color={i === sel ? P.cream : P.dim} bold={i === sel}>
                    {d}
                  </Text>
                </Box>
                <Text color={i === sel ? P.dim : P.faint}>{DRIVER_DESC[d]}</Text>
              </Box>
            ))}
          </Box>
        ) : step === "inspect" ? (
          <InspectView inspect={inspect} url={answers.url ?? ""} />
        ) : step === "groupPassword" &&
          (probe === "checking" || (probe && typeof probe === "object" && !probe.ok)) ? (
          <Box flexDirection="column">
            {probe === "checking" ? (
              <Text color={P.amber}>connecting to server…</Text>
            ) : (
              <Text color={P.red}>✗ {probe && typeof probe === "object" ? probe.error : ""}</Text>
            )}
          </Box>
        ) : step === "done" ? (
          <Box flexDirection="column">
            {commit === "error" ? (
              <>
                <Text color={P.red}>✗ {commitErr}</Text>
                <Text color={P.dim}>esc to go back and change the answers.</Text>
              </>
            ) : commit === "saving" ? (
              <Text color={P.amber}>
                {isShared
                  ? "joining the group and starting the daemon…"
                  : "writing config and starting the daemon…"}
              </Text>
            ) : (
              <>
                <Text color={P.green}>✓ everything checks out.</Text>
                <Box marginTop={1}>
                  <Text backgroundColor={P.ghost} color={P.green} bold>
                    {"  continue  "}
                  </Text>
                  <Text color={P.faint}>{"  ⏎ open the dashboard"}</Text>
                </Box>
              </>
            )}
          </Box>
        ) : (
          <Box>
            <Box width={16}>
              <Text color={P.orange} bold>
                {STEP_LABEL[step]}:
              </Text>
            </Box>
            <Box flexDirection="column" flexGrow={1}>
              <Text>
                <Text color={P.faint}>{"› "}</Text>
                {buf.length ? (
                  <>
                    <Text color={P.cream}>{isMasked ? "•".repeat(buf.length) : buf}</Text>
                    <Text color={P.orange}>▏</Text>
                  </>
                ) : (
                  <>
                    <Text color={P.orange}>▏</Text>
                    <Text color={P.faint}>{placeholder}</Text>
                  </>
                )}
              </Text>
              {err ? <Text color={P.red}>{err}</Text> : null}
            </Box>
          </Box>
        )}
      </Box>
      <Box flexGrow={1} />
      <Box justifyContent="center">
        <Text color={P.faint}>{hint}</Text>
      </Box>
    </Box>
  );
}

function InspectView({
  inspect,
  url,
}: {
  inspect: Classification | "checking";
  url: string;
}): React.ReactElement {
  if (inspect === "checking") return <Text color={P.amber}>connecting to {url}…</Text>;
  switch (inspect.kind) {
    case "error":
      return <Text color={P.red}>✗ {inspect.message}</Text>;
    case "foreign":
      return (
        <Box flexDirection="column">
          <Text color={P.red}>✗ this database already contains other tables.</Text>
          <Text color={P.dim}>
            ccshare needs its own empty database — go back and change the url.
          </Text>
        </Box>
      );
    case "ccshare-newer":
      return (
        <Box flexDirection="column">
          <Text color={P.red}>✗ this database uses a newer ccshare schema.</Text>
          <Text color={P.dim}>update ccshare, or point at a different database.</Text>
        </Box>
      );
    case "ccshare-foreign-account":
      return (
        <Box flexDirection="column">
          <Text color={P.red}>✗ bound to a different Claude account.</Text>
          <Text color={P.dim}>
            this ledger tracks {inspect.account ?? "another account"} — use that account or a
            different database.
          </Text>
        </Box>
      );
    default:
      return (
        <Box flexDirection="column">
          <Text color={P.green}>
            ✓ connected ·{" "}
            {inspect.kind === "empty"
              ? "the database is empty"
              : "found an existing ccshare database"}
          </Text>
          <Box marginTop={1}>
            <Text color={P.cream}>{inspect.kind === "empty" ? "initialize it?" : "join it?"}</Text>
            <Text color={P.faint}>{"  "}[y/n]</Text>
          </Box>
        </Box>
      );
  }
}
