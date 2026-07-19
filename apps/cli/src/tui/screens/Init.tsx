import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import { isValidName, type Config } from "@ccpool/core";
import { applySharedJoin, probeSharedGroup, type SharedProbe } from "../../lib/setup.js";
import { clearAuthRejected, spawnDaemon, stopDaemonProcess } from "../../commands/daemon.js";
import { Clawd } from "../designs/parts.js";
import { P } from "../designs/palette.js";
import { useTermSize } from "../use-term-size.js";

type StepKey =
  | "name"
  | "groupPassword"
  | "groupPasswordConfirm"
  | "memberPassword"
  | "memberPasswordConfirm"
  | "done";

const ORDER: StepKey[] = [
  "name",
  "groupPassword",
  "groupPasswordConfirm",
  "memberPassword",
  "memberPasswordConfirm",
  "done",
];

const STEP_LABEL: Record<StepKey, string> = {
  name: "Name",
  groupPassword: "Group password",
  groupPasswordConfirm: "Confirm group password",
  memberPassword: "Member password",
  memberPasswordConfirm: "Confirm member password",
  done: "Done",
};

interface Answers {
  name?: string;
  groupPassword?: string;
  groupPasswordConfirm?: string;
  memberPassword?: string;
  memberPasswordConfirm?: string;
}

const stepVisible = (k: StepKey, probe: SharedProbe | "checking" | null): boolean => {
  const groupExists = probe && typeof probe === "object" && probe.ok && probe.groupExists;
  const memberExists = probe && typeof probe === "object" && probe.ok && probe.memberExists;
  switch (k) {
    case "groupPasswordConfirm":
      return !groupExists; // only when setting up a new group
    case "memberPasswordConfirm":
      return !groupExists || !memberExists; // only when signing up a new group or member
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

  const [answers, setAnswers] = useState<Answers>(() =>
    initialConfig ? { name: initialConfig.name } : {}
  );
  const [step, setStep] = useState<StepKey>("name");
  const [buf, setBuf] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const [commit, setCommit] = useState<Commit>("idle");
  const [commitErr, setCommitErr] = useState<string | null>(null);
  const [probe, setProbe] = useState<SharedProbe | "checking" | null>(null);

  const visible = ORDER.filter((k) => stepVisible(k, probe));
  const stepNo = visible.indexOf(step) + 1;

  const enter = (key: StepKey): void => {
    setStep(key);
    setErr(null);
    setBuf(
      key === "name"
        ? (answers.name ?? "")
        : key === "groupPassword"
          ? (answers.groupPassword ?? "")
          : key === "groupPasswordConfirm"
            ? (answers.groupPasswordConfirm ?? "")
            : key === "memberPassword"
              ? (answers.memberPassword ?? "")
              : key === "memberPasswordConfirm"
                ? (answers.memberPasswordConfirm ?? "")
                : ""
    );
    if (key === "done") {
      setCommit("idle");
      setCommitErr(null);
    }
  };

  const advance = (patch: Answers): void => {
    const next = { ...answers, ...patch };
    setAnswers(next);
    const vis = ORDER.filter((k) => stepVisible(k, probe));
    const nk = vis[vis.indexOf(step) + 1];
    if (nk) enter(nk);
  };

  const back = (): void => {
    const idx = visible.indexOf(step);
    if (idx <= 0) {
      if (onCancel) onCancel();
      else onQuit();
      return;
    }
    enter(visible[idx - 1]!);
  };

  // Probe the server once a name is entered, so the account line and the
  // create/join wording are ready by the group-password step.
  useEffect(() => {
    if (!answers.name) {
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
  }, [answers.name]);

  const finish = async (): Promise<void> => {
    setCommit("saving");
    setCommitErr(null);

    // Stop an existing daemon if re-initializing.
    if (initialConfig) {
      try {
        stopDaemonProcess();
      } catch {
        // ignore errors stopping existing daemon
      }
    }

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
    // We just minted a fresh token, so any prior `authRejected` latch (the "server" section) is stale.
    // Clear it before the status screen reads it, or gatherView loops us back here.
    clearAuthRejected(res.config);
    spawnDaemon();
    onDone(res.config);
  };

  const getHeading = (): string => {
    const groupExists = probe && typeof probe === "object" && probe.ok && probe.groupExists;
    const memberExists = probe && typeof probe === "object" && probe.ok && probe.memberExists;
    switch (step) {
      case "name":
        return `${stepNo}. What is your name?`;
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
      case "groupPassword":
        return "at least 8 characters";
      case "groupPasswordConfirm":
        return "re-type group password to confirm";
      case "memberPassword":
        return "at least 8 characters";
      case "memberPasswordConfirm":
        return "re-type member password to confirm";
      default:
        return "";
    }
  };

  const isMasked = step !== "name";
  const probeBlocked =
    step === "groupPassword" &&
    (probe === "checking" || (probe && typeof probe === "object" && !probe.ok));

  useInput(
    (input, key) => {
      if (step !== "done") {
        if (key.return) {
          if (step === "name") {
            const v = buf.trim();
            if (!isValidName(v)) return setErr("letters, digits, and hyphens only");
            advance({ name: v });
          } else if (step === "groupPassword") {
            if (probe === "checking") return;
            if (probe && typeof probe === "object" && !probe.ok) {
              setProbe("checking");
              void probeSharedGroup(answers.name).then((r) => setProbe(r));
              return;
            }
            if (buf.length < 8) return setErr("at least 8 characters");
            advance({ groupPassword: buf });
          } else if (step === "groupPasswordConfirm") {
            if (buf !== answers.groupPassword) return setErr("passwords do not match");
            advance({ groupPasswordConfirm: buf });
          } else if (step === "memberPassword") {
            if (buf.length < 8) return setErr("at least 8 characters");
            advance({ memberPassword: buf });
          } else if (step === "memberPasswordConfirm") {
            if (buf !== answers.memberPassword) return setErr("passwords do not match");
            advance({ memberPasswordConfirm: buf });
          }
        } else if (key.escape) back();
        else if (key.backspace || key.delete) {
          if (probeBlocked) return;
          setBuf((b) => b.slice(0, -1));
        } else if (input && !key.ctrl && !key.meta) {
          if (probeBlocked) return;
          setBuf((b) => b + input);
        }
        return;
      }
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
  const value = (k: StepKey): string => {
    if (k === "name") return answers.name ?? "";
    if (k === "done") return "";
    return "•".repeat(Math.min(8, (answers[k] ?? "").length));
  };

  const heading = getHeading();
  const placeholder = getPlaceholder();
  const hint =
    step === "groupPassword" && probe === "checking"
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
              {initialConfig ? "ccpool re-initialization" : "ccpool setup"}
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

        {probe && typeof probe === "object" && probe.ok ? (
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

        {probeBlocked ? (
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
              <Text color={P.amber}>joining the group and starting the daemon…</Text>
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
