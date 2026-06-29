import { existsSync, readFileSync } from "node:fs";
import { CAP_LABEL, pctLabel, type LocalState } from "@ccshare/core";
import { daemonPaths, isAlive, readPid } from "@ccshare/daemon";
import { ccshareDir, loadConfig } from "../lib/config.js";

/**
 * Compact one-liner for Claude Code's status bar. Reads `state.json` only — cheap,
 * never blocks, no network (§5). Example:
 *   `◐ 5h 42% · wk 68% · you sam · ● db`
 */
export async function runStatusline(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) {
    process.stdout.write("ccshare: run `ccshare init`\n");
    return;
  }
  const configDir = cfg.configDirs[0] ?? process.cwd();
  const { stateFile, pidFile } = daemonPaths(ccshareDir(), configDir);

  if (!existsSync(stateFile)) {
    process.stdout.write(`ccshare · you ${cfg.name} · ○ no data\n`);
    return;
  }

  let state: LocalState;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8")) as LocalState;
  } catch {
    process.stdout.write("ccshare · state unreadable\n");
    return;
  }

  const parts: string[] = [];
  for (const s of state.samples) {
    const short = s.cap === "seven_day" ? "wk" : s.cap === "five_hour" ? "5h" : CAP_LABEL[s.cap];
    parts.push(`${short} ${pctLabel(s.pct)}`);
  }

  const pid = readPid(pidFile);
  const dbDot = pid !== null && isAlive(pid) ? "●" : "○";
  const tank = parts.length > 0 ? parts.join(" · ") : "no caps";
  const auth = state.account.tokenExpired ? " · ⚠ auth" : "";

  process.stdout.write(`◐ ${tank} · you ${cfg.name}${auth} · ${dbDot} db\n`);
}
