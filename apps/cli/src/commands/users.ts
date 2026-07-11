import { ApiRequestError } from "@ccpool/core";
import { requireInit } from "../lib/guard.js";

/** List participants (names) registered in the shared ledger. */
export async function runUsers(): Promise<void> {
  const ctx = await requireInit();
  if (!ctx) return;
  const { cfg, viewSource } = ctx;
  try {
    const { users } = await viewSource.fetchView();
    if (users.length === 0) {
      console.log("No participants yet.");
      return;
    }
    for (const u of users) {
      const you = u.name === cfg.name ? "  (you)" : "";
      console.log(`${u.name}${you}`);
    }
  } catch (err) {
    // A 401 is logged-out (token unknown/revoked), not a network problem.
    if (err instanceof ApiRequestError && err.status === 401) {
      console.error(
        "You're logged out — the server rejected your token. Run `ccpool init` to sign back in."
      );
    } else {
      console.error(`Could not reach the shared ledger: ${(err as Error).message}`);
    }
    process.exitCode = 1;
  } finally {
    await viewSource.close();
  }
}
