import { writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { LocalState, UsageSample } from "../types.js";

export interface SnapshotInput {
  accountId: string | null;
  tokenExpired: boolean;
  /** This machine's Claude account differs from the DB's bound account (the "Account binding" section). */
  accountConflict?: boolean;
  /** The server rejected this daemon's bearer (revoked/rotated) — logged out (the "server" section). */
  authRejected?: boolean;
  /** ISO 8601 of the last fully-clean sync (fresh poll + landed ingest), or null. */
  lastSyncAt?: string | null;
  /** The last poll failure (e.g. 429), or null when the last poll was clean. */
  pollError?: LocalState["pollError"];
  samples: UsageSample[];
  pid: number;
  startedAt: string;
  now?: string;
}

/** Build the local `state.json` model. Pure — the daemon writes the result. */
export function buildLocalState(input: SnapshotInput): LocalState {
  return {
    updatedAt: input.now ?? new Date().toISOString(),
    lastSyncAt: input.lastSyncAt ?? null,
    account: {
      id: input.accountId,
      tokenExpired: input.tokenExpired,
      conflict: input.accountConflict ?? false,
      authRejected: input.authRejected ?? false,
    },
    samples: input.samples,
    daemon: { pid: input.pid, startedAt: input.startedAt },
    pollError: input.pollError ?? null,
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
