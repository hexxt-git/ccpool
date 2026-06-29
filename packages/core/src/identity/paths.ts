import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The Claude Code config dir for this account. `CLAUDE_CONFIG_DIR` overrides the
 * default `~/.claude`. This identifies the *account's* storage, never a person.
 */
export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  return override && override.length > 0 ? override : join(homedir(), ".claude");
}

/** Where Claude Code keeps transcripts: `<configDir>/projects/**\/*.jsonl`. */
export function projectsDir(configDir: string): string {
  return join(configDir, "projects");
}

/**
 * The global JSON that holds `oauthAccount`. When `CLAUDE_CONFIG_DIR` is set it
 * lives inside that dir; otherwise it's `~/.claude.json` (sibling of `~/.claude`).
 */
export function globalConfigPath(configDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  if (override && override.length > 0) return join(configDir, ".claude.json");
  return join(homedir(), ".claude.json");
}
