import { CAP_KINDS, CAP_LABEL, isValidName, type CapKind } from "@ccshare/core";
import { requireInit } from "../lib/guard.js";

function parseCap(raw: string): CapKind | null {
  if ((CAP_KINDS as readonly string[]).includes(raw)) return raw as CapKind;
  // accept friendly aliases
  if (raw === "5h") return "five_hour";
  if (raw === "weekly" || raw === "wk" || raw === "7d") return "seven_day";
  if (raw === "opus" || raw === "weekly-opus") return "seven_day_opus";
  return null;
}

/** Set a fair-share target: `ccshare budget set <name> <cap> <pct>`. */
export async function runBudgetSet(name: string, capRaw: string, pctRaw: string): Promise<void> {
  if (!isValidName(name)) {
    console.error(`Invalid name "${name}" — use letters, digits, and hyphens only.`);
    process.exitCode = 1;
    return;
  }
  const cap = parseCap(capRaw);
  if (!cap) {
    console.error(
      `Unknown cap "${capRaw}". Use one of: five_hour (5h), seven_day (weekly), seven_day_opus.`
    );
    process.exitCode = 1;
    return;
  }
  const pct = Number(pctRaw);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    console.error("Share must be a number between 0 and 100.");
    process.exitCode = 1;
    return;
  }

  const ctx = await requireInit();
  if (!ctx) return;
  const { storage } = ctx;
  try {
    await storage.upsertUser(name);
    await storage.setBudget(name, cap, pct);
    console.log(`Set budget: ${name} ${CAP_LABEL[cap]} ${pct}%`);
  } finally {
    await storage.close();
  }
}

/** List configured budgets. */
export async function runBudgetList(): Promise<void> {
  const ctx = await requireInit();
  if (!ctx) return;
  const { storage } = ctx;
  try {
    const budgets = await storage.getBudgets();
    if (budgets.length === 0) {
      console.log("No budgets set. Try `ccshare budget set <name> <cap> <pct>`.");
      return;
    }
    for (const b of budgets) {
      console.log(`${b.name.padEnd(12)} ${CAP_LABEL[b.cap].padEnd(12)} ${b.sharePct}%`);
    }
  } finally {
    await storage.close();
  }
}
