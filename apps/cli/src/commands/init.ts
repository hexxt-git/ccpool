import { isValidName, type Config } from "@ccpool/core";
import { loadConfig } from "../lib/config.js";
import { resolveServerUrl } from "../lib/backend.js";
import { applySharedJoin, probeSharedGroup } from "../lib/setup.js";
import { withPrompts, type Prompts } from "../lib/prompt.js";
import { clearAuthRejected, runDaemonRestart, runDaemonStart } from "./daemon.js";

interface InitOptions {
  reconfigure?: boolean;
  /** Non-interactive overrides (for scripting/CI). Missing pieces are prompted. */
  name?: string;
  /** Flags leak into shell history — prefer the env fallbacks
   * CCPOOL_GROUP_PASSWORD / CCPOOL_MEMBER_PASSWORD in CI. */
  groupPassword?: string;
  memberPassword?: string;
  /** Auto-confirm the write step (create the group). */
  yes?: boolean;
  /** Skip auto-starting the background observer (commander's `--no-daemon`). */
  daemon?: boolean;
}

/**
 * Required first run. One machine joins the shared ledger through the hosted
 * ccpool server: a member enters the group password + their own member password
 * and never touches a database.
 *
 * Fully interactive by default; any field supplied as a flag skips its prompt,
 * so the whole flow can run non-interactively.
 */
export async function runInit(opts: InitOptions = {}): Promise<void> {
  const existing = await loadConfig();
  if (existing && !opts.reconfigure) {
    console.log(
      `Already initialized (server: ${resolveServerUrl(existing)}, name: ${existing.name}).`
    );
    // Make sure the observer is running — this is idempotent (a no-op if it already
    // is), so re-running `ccpool init` after an update just brings it back up.
    if (opts.daemon !== false) await runDaemonStart();
    console.log("Re-run with `ccpool init --reconfigure` to change the setup.");
    return;
  }

  await withPrompts(async (p) => {
    const done = await sharedInit(p, opts, existing);
    if (!done) return;

    if (opts.daemon === false) {
      console.log("Start the shared observer when you're ready: `ccpool daemon start`.");
      return;
    }
    // Nothing left to do by hand — bring the observer up now. On a reconfigure we
    // restart so the running process picks up the new backend, not the old one.
    if (opts.reconfigure || existing) {
      // The just-replaced token may have left a stale `authRejected` latch in
      // state.json; clear it so the TUI doesn't route straight to re-init (the "server" section).
      const fresh = await loadConfig();
      if (fresh) clearAuthRejected(fresh);
      await runDaemonRestart();
    } else await runDaemonStart();
    console.log(
      "The observer runs in the background — stop it any time with `ccpool daemon stop`."
    );
  });
}

/**
 * Show the Claude account and the server URL, then look up whether a group
 * already exists for this account so it can say "create" vs "join" and word the
 * group-password prompt — all before asking for anything. Order matches the
 * mental model: see who/where you are → group password → your name → your own
 * password.
 */
async function sharedInit(
  p: Prompts,
  opts: InitOptions,
  existing: Config | null
): Promise<boolean> {
  const probe = await probeSharedGroup(null, existing);
  if (!probe.ok) {
    console.error(probe.error);
    process.exitCode = 1;
    return false;
  }

  console.log(`You're signed into Claude as ${probe.account.email ?? probe.account.id}.`);
  console.log(`ccpool server: ${probe.serverUrl}`);
  console.log(
    probe.groupExists
      ? "A group already exists for this account — you'll join it with the team's group password."
      : "No ccpool group exists for this account yet — you'll create one and set its group password."
  );

  const groupPassword =
    opts.groupPassword ??
    process.env.CCPOOL_GROUP_PASSWORD ??
    (await p.ask(
      probe.groupExists
        ? "Group password (the one your team set)"
        : "New group password (everyone will use this to join)"
    ));

  const name =
    opts.name ?? (await p.ask("Choose your name (letters, digits, hyphens)", existing?.name));
  if (!isValidName(name)) {
    console.error(`Invalid name "${name}" — use letters, digits, and hyphens only.`);
    process.exitCode = 1;
    return false;
  }

  const memberPassword =
    opts.memberPassword ??
    process.env.CCPOOL_MEMBER_PASSWORD ??
    (await p.ask(`Your own password for "${name}" (protects your name from impersonation)`));

  // With the probe we already know create vs join, so allowCreate follows it —
  // but keep the confirm for the create case (a first member is a real decision),
  // and still fall back to the create prompt if the group vanished in between.
  let res = await applySharedJoin({
    name,
    groupPassword,
    memberPassword,
    allowCreate: false,
    config: existing,
  });
  if (!res.ok && res.canCreate) {
    const ok =
      opts.yes || (await p.confirm(`No group exists for this account yet — create it now?`, true));
    if (!ok) {
      console.log("Aborted — nothing was created.");
      return false;
    }
    res = await applySharedJoin({
      name,
      groupPassword,
      memberPassword,
      allowCreate: true,
      config: existing,
    });
  }
  if (!res.ok) {
    console.error(res.error);
    process.exitCode = 1;
    return false;
  }
  console.log(
    `${probe.groupExists ? "Joined" : "Created and joined"} the group as "${res.config.name}" ` +
      `(server: ${resolveServerUrl(res.config)}). Wrote config.`
  );
  return true;
}
