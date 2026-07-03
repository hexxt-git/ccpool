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
    console.error(`Could not reach the shared ledger: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await viewSource.close();
  }
}
