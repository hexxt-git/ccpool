import { writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { LocalState, UsageSample } from "../types.js";

export interface SnapshotInput {
  accountId: string | null;
  tokenExpired: boolean;
  samples: UsageSample[];
  pid: number;
  startedAt: string;
  now?: string;
}

/** Build the local `state.json` model. Pure — the daemon writes the result. */
export function buildLocalState(input: SnapshotInput): LocalState {
  return {
    updatedAt: input.now ?? new Date().toISOString(),
    account: { id: input.accountId, tokenExpired: input.tokenExpired },
    samples: input.samples,
    daemon: { pid: input.pid, startedAt: input.startedAt },
  };
}

/**
 * Atomically write JSON: write a temp sibling then rename over the target, so a
 * reader (statusline/TUI) never sees a half-written file.
 */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}
