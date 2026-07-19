import { existsSync, readFileSync } from "node:fs";
import { CAP_LABEL, pctLabel, type LocalState } from "@ccpool/core";
import { isAlive, readPid } from "@ccpool/daemon";
import { daemonControlPaths, loadConfig, stateFilePath } from "../lib/config.js";

/**
 * Compact one-liner for Claude Code's status bar. Reads `state.json` only — cheap,
 * never blocks, no network (the "state.json" section). Example:
 *   `◐ 5h 42% · wk 68% · you sam · ● db`
 */
export async function runStatusline(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) {
    process.stdout.write("ccpool: run `ccpool init`\n");
    return;
  }
  const { pidFile } = daemonControlPaths();
  const stateFile = cfg.accountId ? stateFilePath(cfg.accountId) : null;

  if (!stateFile || !existsSync(stateFile)) {
    process.stdout.write(`ccpool · you ${cfg.name} · ○ no data\n`);
    return;
  }

  let state: LocalState;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8")) as LocalState;
  } catch {
    process.stdout.write("ccpool · state unreadable\n");
    return;
  }

  const parts: string[] = [];
  for (const s of state.samples) {
    const short = s.cap === "seven_day" ? "wk" : s.cap === "five_hour" ? "5h" : CAP_LABEL[s.cap];
    parts.push(`${short} ${pctLabel(s.pct)}`);
  }

  // A revoked/rotated bearer can't be retried — surface it loudest so the status
  // bar tells the user to re-init rather than silently showing a stale tank (the "server" section).
  if (state.account.authRejected) {
    process.stdout.write(`⚠ ccpool logged out · run \`ccpool init\` · you ${cfg.name}\n`);
    return;
  }

  const pid = readPid(pidFile);
  const dbDot = pid !== null && isAlive(pid) ? "●" : "○";
  const tank = parts.length > 0 ? parts.join(" · ") : "no caps";
  const auth = state.account.tokenExpired ? " · ⚠ auth" : "";

  process.stdout.write(`◐ ${tank} · you ${cfg.name}${auth} · ${dbDot} db\n`);
}
