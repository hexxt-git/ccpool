import {
  isTokenExpired,
  pollUsage,
  readCredentials,
  resolveAccount,
  resolveConfigDir,
} from "@ccshare/core";
import { renderTank } from "../lib/render.js";

/**
 * One-shot snapshot of the shared account tank. Phase 1 reads straight from the
 * live endpoint; Phase 4 will prefer the daemon's `state.json` and add the
 * per-user breakdown from the shared DB.
 */
export async function runStatus(): Promise<void> {
  const configDir = resolveConfigDir();
  const account = await resolveAccount(configDir);
  const creds = await readCredentials(configDir);

  if (!creds) {
    console.error("No Claude credentials found. Sign in with Claude Code first, then retry.");
    process.exitCode = 1;
    return;
  }

  const who = account?.email ?? account?.displayName ?? account?.id ?? "unknown account";
  const plan = creds.subscriptionType ? ` (${creds.subscriptionType})` : "";
  console.log(`ccshare · account ${who}${plan}\n`);

  if (isTokenExpired(creds)) {
    console.log("Access token expired — waiting for Claude Code to refresh auth.");
    return;
  }

  let samples;
  try {
    samples = await pollUsage(creds.accessToken);
  } catch (err) {
    console.error(`Failed to read usage: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  for (const line of renderTank(samples)) console.log(line);
}
