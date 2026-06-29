import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/** Minimal interactive prompts over readline (works on Node and Bun). */
export async function withPrompts<T>(fn: (p: Prompts) => Promise<T>): Promise<T> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await fn({
      ask: async (q, def) => {
        const suffix = def ? ` (${def})` : "";
        const a = (await rl.question(`${q}${suffix}: `)).trim();
        return a.length > 0 ? a : (def ?? "");
      },
      confirm: async (q, def = false) => {
        const hint = def ? "[Y/n]" : "[y/N]";
        const a = (await rl.question(`${q} ${hint} `)).trim().toLowerCase();
        if (a.length === 0) return def;
        return a === "y" || a === "yes";
      },
      select: async (q, options) => {
        stdout.write(`${q}\n`);
        options.forEach((o, i) => stdout.write(`  ${i + 1}) ${o.label}\n`));
        for (;;) {
          const a = (await rl.question("choose [1]: ")).trim() || "1";
          const idx = Number(a) - 1;
          if (Number.isInteger(idx) && idx >= 0 && idx < options.length) {
            return options[idx]!.value;
          }
          stdout.write("  please enter a valid number\n");
        }
      },
    });
  } finally {
    rl.close();
  }
}

export interface Prompts {
  ask(question: string, def?: string): Promise<string>;
  confirm(question: string, def?: boolean): Promise<boolean>;
  select<V>(question: string, options: { label: string; value: V }[]): Promise<V>;
}
