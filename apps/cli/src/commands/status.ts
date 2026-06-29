import { requireInit } from "../lib/guard.js";
import { gatherView } from "../lib/view.js";
import { renderView } from "../lib/render.js";

/**
 * One-shot snapshot of the shared account tank, rendered from the same view
 * model `tui` uses. Prefers the shared DB, then local state.json, then a live
 * poll (§10).
 */
export async function runStatus(): Promise<void> {
  const ctx = await requireInit();
  if (!ctx) return;
  const { cfg, storage } = ctx;
  try {
    const vm = await gatherView(cfg, storage);
    for (const line of renderView(vm)) console.log(line);
  } finally {
    await storage.close();
  }
}
