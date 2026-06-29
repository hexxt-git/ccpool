import { mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

/** True under Bun, false under Node. The one runtime branch we keep. */
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export interface SpawnDetachedOptions {
  /** Append child stdout+stderr here, so a detached daemon still logs. */
  logFile: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Start a fully detached background process and return its pid. Wraps the one
 * runtime difference: `Bun.spawn` vs Node's `spawn(..., { detached: true })`.
 */
export function spawnDetached(command: string, args: string[], opts: SpawnDetachedOptions): number {
  mkdirSync(dirname(opts.logFile), { recursive: true });
  const fd = openSync(opts.logFile, "a");
  const env = opts.env ?? process.env;

  if (isBun) {
    // @ts-expect-error Bun global is present only under Bun
    const child = Bun.spawn([command, ...args], {
      stdout: fd,
      stderr: fd,
      stdin: "ignore",
      env,
    });
    child.unref();
    return child.pid;
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", fd, fd],
    env,
  });
  child.unref();
  return child.pid ?? -1;
}
