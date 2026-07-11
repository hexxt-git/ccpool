import { requireInit } from "../lib/guard.js";
import { gatherView } from "../lib/view.js";
import { toDesignModel } from "../lib/design-model.js";
import { renderStatusLines } from "../lib/status-render.js";

/**
 * One-shot snapshot of the shared account tank. Renders the `status` design as
 * plain string lines: colored when stdout is a terminal, plaintext when piped or
 * redirected (so `status | grep` and `status > file` stay clean). Sized to the
 * terminal width, degrading on narrow widths (the "view model" section).
 */
export async function runStatus(): Promise<void> {
  const ctx = await requireInit();
  if (!ctx) return;
  const { cfg, viewSource } = ctx;
  try {
    const vm = await gatherView(cfg, viewSource);
    const model = toDesignModel(vm, cfg.name);
    const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
    const width = process.stdout.columns ?? 70;
    for (const line of renderStatusLines(model, { width, color })) console.log(line);
  } finally {
    await viewSource.close();
  }
}
