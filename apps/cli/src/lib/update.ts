/**
 * Background auto-update for the published `ccpool` CLI.
 *
 * Detects how this binary was installed (npm / pnpm / yarn / bun global), checks
 * the npm registry for a newer version, and applies the matching upgrade command
 * without blocking the process. Failures are published to module state so the
 * TUI can put them on its error line; successes land on disk for the next run
 * (the current process keeps its already-loaded code).
 *
 * Skips: dev/source runs, npx caches, CI, `CCPOOL_NO_UPDATE=1`, and non-global
 * layouts we can't safely rewrite. Throttled via `~/.ccpool/update-check.json`
 * so hot paths (statusline) and short commands don't hammer the registry.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ccpoolDir } from "./config.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type UpdateState =
  | { status: "idle" }
  | { status: "skipped"; reason: string }
  | { status: "checking" }
  | { status: "up-to-date"; current: string; latest: string }
  | { status: "updating"; current: string; latest: string; manager: PackageManager }
  | { status: "updated"; current: string; latest: string; manager: PackageManager }
  | { status: "failed"; message: string };

const PACKAGE_NAME = "ccpool";
const REGISTRY_LATEST = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
/** Don't re-check the registry more often than this (ms). */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
/** Cap how long an install is allowed to run. */
const UPDATE_TIMEOUT_MS = 120_000;

const UPDATE_ARGS: Record<PackageManager, readonly [string, readonly string[]]> = {
  npm: ["npm", ["install", "-g", `${PACKAGE_NAME}@latest`]],
  pnpm: ["pnpm", ["add", "-g", `${PACKAGE_NAME}@latest`]],
  yarn: ["yarn", ["global", "add", `${PACKAGE_NAME}@latest`]],
  bun: ["bun", ["add", "-g", `${PACKAGE_NAME}@latest`]],
};

// ── module state (TUI subscribes) ───────────────────────────────────────────

let state: UpdateState = { status: "idle" };
let started = false;
const listeners = new Set<(s: UpdateState) => void>();

function setState(next: UpdateState): void {
  state = next;
  for (const fn of listeners) {
    try {
      fn(next);
    } catch {
      // subscriber bugs must not break the update loop
    }
  }
}

export function getUpdateState(): UpdateState {
  return state;
}

/** Subscribe to state changes; called immediately with the current state. */
export function subscribeUpdate(fn: (s: UpdateState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => {
    listeners.delete(fn);
  };
}

/** Test seam — reset the singleton so suites don't leak across files. */
export function _resetUpdateForTests(): void {
  state = { status: "idle" };
  started = false;
  listeners.clear();
}

// ── version compare ─────────────────────────────────────────────────────────

/** True when `latest` is a strictly newer semver than `current` (prerelease ignored). */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/i, "")
      .split("-")[0]!
      .split(".")
      .map((p) => {
        const n = parseInt(p, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const a = parse(latest);
  const b = parse(current);
  const len = Math.max(a.length, b.length, 3);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

// ── install-source detection ────────────────────────────────────────────────

/**
 * Infer the package manager that owns this install from the resolved path of
 * the running entry script (`process.argv[1]`). Returns null when we shouldn't
 * (or can't) auto-update — source checkouts, npx caches, unknown layouts.
 */
export function detectPackageManager(
  entryPath: string | undefined = process.argv[1]
): PackageManager | null {
  if (!entryPath) return null;

  let real: string;
  try {
    real = realpathSync(entryPath);
  } catch {
    // unresolved symlink / vanished path — not a managed install we can rewrite
    return null;
  }

  // Normalize for case-insensitive FS and Windows separators.
  const p = real.replace(/\\/g, "/").toLowerCase();

  // Dev / monorepo: running source or a local build, not a published global.
  if (p.includes("/apps/cli/src/") || p.endsWith(".tsx")) return null;
  if (p.includes("/apps/cli/dist/") && !p.includes("/node_modules/")) return null;

  // One-shot npx / bunx caches — upgrading those would write elsewhere or nowhere useful.
  if (p.includes("/_npx/") || p.includes("/.npm/_npx/")) return null;
  if (p.includes("/.bun/install/cache/")) return null;

  // Path markers (most specific first).
  if (p.includes("/.bun/") || p.includes("/bun/install/global/")) return "bun";
  if (p.includes("/.pnpm/") || p.includes("/pnpm/global/") || p.includes("/pnpm-global/"))
    return "pnpm";
  if (p.includes("/.yarn/") || p.includes("/yarn/global/")) return "yarn";

  // Classic global install under node_modules/ccpool (npm, and some yarn layouts).
  if (/\/node_modules\/ccpool(\/|$)/.test(p)) {
    // Prefer yarn when the tree clearly lives under a yarn global prefix.
    if (p.includes("/yarn/")) return "yarn";
    return "npm";
  }

  return null;
}

/** The install command a user (or we) would run for this manager. */
export function updateCommand(manager: PackageManager): string {
  const [cmd, args] = UPDATE_ARGS[manager];
  return [cmd, ...args].join(" ");
}

// ── throttle file ───────────────────────────────────────────────────────────

interface CheckRecord {
  lastCheckAt: number;
  lastLatest?: string;
  lastResult?: "up-to-date" | "updated" | "failed" | "skipped";
}

function checkPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(ccpoolDir(env), "update-check.json");
}

async function readCheckRecord(env: NodeJS.ProcessEnv): Promise<CheckRecord | null> {
  try {
    const raw = await readFile(checkPath(env), "utf8");
    const j = JSON.parse(raw) as CheckRecord;
    if (typeof j.lastCheckAt !== "number") return null;
    return j;
  } catch {
    return null;
  }
}

async function writeCheckRecord(rec: CheckRecord, env: NodeJS.ProcessEnv): Promise<void> {
  const p = checkPath(env);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(rec, null, 2) + "\n", "utf8");
}

// ── registry + install ──────────────────────────────────────────────────────

export interface UpdateDeps {
  fetchLatest: () => Promise<string>;
  runInstall: (manager: PackageManager) => Promise<void>;
  now: () => number;
  env: NodeJS.ProcessEnv;
  entryPath?: string;
}

async function defaultFetchLatest(): Promise<string> {
  const res = await fetch(REGISTRY_LATEST, {
    headers: { accept: "application/json", "user-agent": "ccpool-cli" },
    // Don't hang a long-lived TUI on a wedged registry.
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`registry returned HTTP ${res.status}`);
  const body = (await res.json()) as { version?: string };
  if (typeof body.version !== "string" || !body.version) {
    throw new Error("registry response missing version");
  }
  return body.version;
}

function defaultRunInstall(manager: PackageManager): Promise<void> {
  const [cmd, args] = UPDATE_ARGS[manager];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      // windowsHide keeps a console window from flashing on Win32
      windowsHide: true,
    });
    let stderr = "";
    let stdout = "";
    child.stderr?.on("data", (d: Buffer | string) => {
      stderr += String(d);
    });
    child.stdout?.on("data", (d: Buffer | string) => {
      stdout += String(d);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`update timed out after ${UPDATE_TIMEOUT_MS / 1000}s`));
    }, UPDATE_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          err.message.includes("ENOENT")
            ? `${cmd} not found on PATH — install it or reinstall ccpool with your package manager`
            : err.message
        )
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = (stderr || stdout).trim().split("\n").filter(Boolean).slice(-3).join(" · ");
      reject(new Error(detail || `${cmd} exited with code ${code ?? "?"}`));
    });
  });
}

function defaultDeps(): UpdateDeps {
  return {
    fetchLatest: defaultFetchLatest,
    runInstall: defaultRunInstall,
    now: () => Date.now(),
    env: process.env,
    entryPath: process.argv[1],
  };
}

export interface StartAutoUpdateOptions {
  /** Current CLI version (injected at build as `__CLI_VERSION__`). */
  currentVersion: string;
  /** Force a check even if the throttle file says we checked recently. */
  force?: boolean;
  /** Override I/O for tests. */
  deps?: Partial<UpdateDeps>;
}

/**
 * Kick off a background check + optional install. Idempotent per process: the
 * first call wins, later calls no-op. Safe to call from the CLI entry before the
 * TUI mounts — state is module-level and the TUI can subscribe later.
 */
export function startAutoUpdate(opts: StartAutoUpdateOptions): void {
  if (started) return;
  started = true;
  void runAutoUpdate(opts).catch((err) => {
    // Last-resort: never let an unhandled rejection take down the CLI.
    const message = err instanceof Error ? err.message : String(err);
    setState({ status: "failed", message: `update failed: ${message}` });
  });
}

/** Awaitable core — exported for tests. Prefer `startAutoUpdate` in production. */
export async function runAutoUpdate(opts: StartAutoUpdateOptions): Promise<UpdateState> {
  const deps: UpdateDeps = { ...defaultDeps(), ...opts.deps };
  const current = opts.currentVersion;

  if (!current || current === "0.0.0-dev" || current.endsWith("-dev")) {
    const s: UpdateState = { status: "skipped", reason: "dev build" };
    setState(s);
    return s;
  }
  if (deps.env.CCPOOL_NO_UPDATE === "1" || deps.env.CCPOOL_NO_UPDATE === "true") {
    const s: UpdateState = { status: "skipped", reason: "CCPOOL_NO_UPDATE" };
    setState(s);
    return s;
  }
  if (deps.env.CI === "true" || deps.env.CI === "1") {
    const s: UpdateState = { status: "skipped", reason: "CI" };
    setState(s);
    return s;
  }

  const manager = detectPackageManager(deps.entryPath);
  if (!manager) {
    const s: UpdateState = { status: "skipped", reason: "unmanaged install" };
    setState(s);
    return s;
  }

  if (!opts.force) {
    const prev = await readCheckRecord(deps.env);
    if (prev && deps.now() - prev.lastCheckAt < CHECK_INTERVAL_MS) {
      const s: UpdateState = { status: "skipped", reason: "checked recently" };
      setState(s);
      return s;
    }
  }

  setState({ status: "checking" });

  let latest: string;
  try {
    latest = await deps.fetchLatest();
  } catch (err) {
    const message = `update check failed: ${(err as Error).message}`;
    setState({ status: "failed", message });
    await writeCheckRecord({ lastCheckAt: deps.now(), lastResult: "failed" }, deps.env).catch(
      () => undefined
    );
    return getUpdateState();
  }

  if (!isNewerVersion(latest, current)) {
    const s: UpdateState = { status: "up-to-date", current, latest };
    setState(s);
    await writeCheckRecord(
      { lastCheckAt: deps.now(), lastLatest: latest, lastResult: "up-to-date" },
      deps.env
    ).catch(() => undefined);
    return s;
  }

  setState({ status: "updating", current, latest, manager });

  try {
    await deps.runInstall(manager);
  } catch (err) {
    const detail = (err as Error).message;
    const message = `update to ${latest} failed (${updateCommand(manager)}): ${detail}`;
    setState({ status: "failed", message });
    await writeCheckRecord(
      { lastCheckAt: deps.now(), lastLatest: latest, lastResult: "failed" },
      deps.env
    ).catch(() => undefined);
    return getUpdateState();
  }

  const s: UpdateState = { status: "updated", current, latest, manager };
  setState(s);
  await writeCheckRecord(
    { lastCheckAt: deps.now(), lastLatest: latest, lastResult: "updated" },
    deps.env
  ).catch(() => undefined);
  return s;
}

/** Human-readable error line text, or null when there's nothing to show. */
export function updateErrorMessage(s: UpdateState = state): string | null {
  return s.status === "failed" ? s.message : null;
}
