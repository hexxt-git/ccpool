import { requireInit } from "../lib/guard.js";

/** List participants (names) registered in the shared DB. */
export async function runUsers(): Promise<void> {
  const ctx = await requireInit();
  if (!ctx) return;
  const { cfg, storage } = ctx;
  try {
    const users = await storage.getUsers();
    if (users.length === 0) {
      console.log("No participants yet.");
      return;
    }
    for (const u of users) {
      const you = u.name === cfg.name ? "  (you)" : "";
      console.log(`${u.name}${you}`);
    }
  } finally {
    await storage.close();
  }
}
