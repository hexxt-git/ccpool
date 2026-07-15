import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetUpdateForTests,
  CHECK_INTERVAL_MS,
  detectPackageManager,
  getUpdateState,
  isNewerVersion,
  runAutoUpdate,
  startAutoUpdate,
  subscribeUpdate,
  updateCommand,
  updateErrorMessage,
  type PackageManager,
} from "../src/lib/update.js";

let ccpoolDir: string;

beforeEach(() => {
  _resetUpdateForTests();
  ccpoolDir = mkdtempSync(join(tmpdir(), "ccpool-update-"));
  process.env.CCPOOL_DIR = ccpoolDir;
  delete process.env.CCPOOL_NO_UPDATE;
  delete process.env.CI;
});

afterEach(() => {
  _resetUpdateForTests();
  delete process.env.CCPOOL_DIR;
  delete process.env.CCPOOL_NO_UPDATE;
  delete process.env.CI;
});

/** Create a fake entry file and return its path (optionally under a themed layout). */
function fakeEntry(segments: string[]): string {
  const file = join(ccpoolDir, ...segments);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "#!/usr/bin/env node\n", "utf8");
  return file;
}

describe("isNewerVersion", () => {
  it("compares dotted semver numerically", () => {
    expect(isNewerVersion("0.0.4", "0.0.3")).toBe(true);
    expect(isNewerVersion("0.0.3", "0.0.3")).toBe(false);
    expect(isNewerVersion("0.0.2", "0.0.3")).toBe(false);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true);
  });

  it("strips a leading v and ignores prerelease suffixes for the core compare", () => {
    expect(isNewerVersion("v1.2.3", "1.2.2")).toBe(true);
    expect(isNewerVersion("1.2.3-beta", "1.2.2")).toBe(true);
  });
});

describe("detectPackageManager", () => {
  it("returns null for empty / unreadable paths", () => {
    // empty string is an explicit miss; `undefined` would fall through to the
    // default (`process.argv[1]`) which is how production calls this.
    expect(detectPackageManager("")).toBeNull();
    expect(detectPackageManager(join(ccpoolDir, "nope", "cli.js"))).toBeNull();
  });

  it("skips monorepo source and local dist builds", () => {
    expect(detectPackageManager(fakeEntry(["apps", "cli", "src", "cli.tsx"]))).toBeNull();
    expect(detectPackageManager(fakeEntry(["apps", "cli", "dist", "cli.js"]))).toBeNull();
  });

  it("skips npx caches", () => {
    expect(
      detectPackageManager(
        fakeEntry([".npm", "_npx", "abc", "node_modules", "ccpool", "dist", "cli.js"])
      )
    ).toBeNull();
  });

  it("detects bun, pnpm, yarn, and npm global layouts", () => {
    expect(
      detectPackageManager(
        fakeEntry([".bun", "install", "global", "node_modules", "ccpool", "dist", "cli.js"])
      )
    ).toBe("bun");
    expect(
      detectPackageManager(
        fakeEntry([
          ".local",
          "share",
          "pnpm",
          "global",
          "5",
          ".pnpm",
          "ccpool@1.0.0",
          "node_modules",
          "ccpool",
          "dist",
          "cli.js",
        ])
      )
    ).toBe("pnpm");
    expect(
      detectPackageManager(
        fakeEntry([".config", "yarn", "global", "node_modules", "ccpool", "dist", "cli.js"])
      )
    ).toBe("yarn");
    expect(
      detectPackageManager(
        fakeEntry([
          ".nvm",
          "versions",
          "node",
          "v22.0.0",
          "lib",
          "node_modules",
          "ccpool",
          "dist",
          "cli.js",
        ])
      )
    ).toBe("npm");
  });

  it("skips local (non-global) dependency layouts we must not `-g` upgrade", () => {
    // A plain <project>/node_modules/ccpool is a local dep, not a global install.
    expect(
      detectPackageManager(fakeEntry(["myapp", "node_modules", "ccpool", "dist", "cli.js"]))
    ).toBeNull();
    // A project's local pnpm virtual store must not read as a global pnpm install.
    expect(
      detectPackageManager(
        fakeEntry([
          "myapp",
          "node_modules",
          ".pnpm",
          "ccpool@1.0.0",
          "node_modules",
          "ccpool",
          "dist",
          "cli.js",
        ])
      )
    ).toBeNull();
    // Yarn Berry keeps a project-local .yarn/ dir — not a global install either.
    expect(
      detectPackageManager(fakeEntry(["myapp", ".yarn", "unplugged", "ccpool", "dist", "cli.js"]))
    ).toBeNull();
  });

  it("follows symlinks to the real package tree", () => {
    const real = fakeEntry([
      ".local",
      "share",
      "pnpm",
      "global",
      "5",
      ".pnpm",
      "ccpool@0.0.3",
      "node_modules",
      "ccpool",
      "dist",
      "cli.js",
    ]);
    const link = join(ccpoolDir, "bin", "ccpool");
    mkdirSync(join(ccpoolDir, "bin"), { recursive: true });
    symlinkSync(real, link);
    expect(detectPackageManager(link)).toBe("pnpm");
  });
});

describe("updateCommand", () => {
  it("returns the right global upgrade for each manager", () => {
    const expected: Record<PackageManager, string> = {
      npm: "npm install -g ccpool@latest",
      pnpm: "pnpm add -g ccpool@latest",
      yarn: "yarn global add ccpool@latest",
      bun: "bun add -g ccpool@latest",
    };
    for (const [pm, cmd] of Object.entries(expected)) {
      expect(updateCommand(pm as PackageManager)).toBe(cmd);
    }
  });
});

describe("runAutoUpdate", () => {
  const npmEntry = () => fakeEntry(["lib", "node_modules", "ccpool", "dist", "cli.js"]);

  it("skips dev builds, CI, and CCPOOL_NO_UPDATE", async () => {
    await expect(
      runAutoUpdate({ currentVersion: "0.0.0-dev", deps: { entryPath: npmEntry() } })
    ).resolves.toMatchObject({ status: "skipped", reason: "dev build" });

    process.env.CI = "true";
    await expect(
      runAutoUpdate({ currentVersion: "0.0.3", deps: { entryPath: npmEntry() } })
    ).resolves.toMatchObject({ status: "skipped", reason: "CI" });
    delete process.env.CI;

    process.env.CCPOOL_NO_UPDATE = "1";
    await expect(
      runAutoUpdate({ currentVersion: "0.0.3", deps: { entryPath: npmEntry() } })
    ).resolves.toMatchObject({ status: "skipped", reason: "CCPOOL_NO_UPDATE" });
  });

  it("skips unmanaged installs", async () => {
    const s = await runAutoUpdate({
      currentVersion: "0.0.3",
      deps: { entryPath: fakeEntry(["apps", "cli", "dist", "cli.js"]) },
    });
    expect(s).toMatchObject({ status: "skipped", reason: "unmanaged install" });
  });

  it("reports up-to-date without installing", async () => {
    const runInstall = vi.fn();
    const s = await runAutoUpdate({
      currentVersion: "0.0.3",
      force: true,
      deps: {
        entryPath: npmEntry(),
        fetchLatest: async () => "0.0.3",
        runInstall,
      },
    });
    expect(s).toEqual({ status: "up-to-date", current: "0.0.3", latest: "0.0.3" });
    expect(runInstall).not.toHaveBeenCalled();
  });

  it("installs when the registry is ahead", async () => {
    const runInstall = vi.fn(async () => undefined);
    const s = await runAutoUpdate({
      currentVersion: "0.0.3",
      force: true,
      deps: {
        entryPath: npmEntry(),
        fetchLatest: async () => "0.0.4",
        runInstall,
      },
    });
    expect(s).toEqual({
      status: "updated",
      current: "0.0.3",
      latest: "0.0.4",
      manager: "npm",
    });
    expect(runInstall).toHaveBeenCalledWith("npm");
  });

  it("surfaces install failures on the error-line helper", async () => {
    const s = await runAutoUpdate({
      currentVersion: "0.0.3",
      force: true,
      deps: {
        entryPath: npmEntry(),
        fetchLatest: async () => "0.0.4",
        runInstall: async () => {
          throw new Error("EACCES: permission denied");
        },
      },
    });
    expect(s.status).toBe("failed");
    expect(updateErrorMessage(s)).toContain("update to 0.0.4 failed");
    expect(updateErrorMessage(s)).toContain("npm install -g ccpool@latest");
    expect(updateErrorMessage(s)).toContain("EACCES");
    expect(updateErrorMessage()).toBe(updateErrorMessage(s));
  });

  it("surfaces registry failures", async () => {
    const s = await runAutoUpdate({
      currentVersion: "0.0.3",
      force: true,
      deps: {
        entryPath: npmEntry(),
        fetchLatest: async () => {
          throw new Error("network down");
        },
      },
    });
    expect(s).toEqual({ status: "failed", message: "update check failed: network down" });
  });

  it("throttles repeat checks within the interval", async () => {
    const fetchLatest = vi.fn(async () => "0.0.3");
    const now = vi.fn(() => 1_000_000);
    await runAutoUpdate({
      currentVersion: "0.0.3",
      deps: { entryPath: npmEntry(), fetchLatest, now },
    });
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    // Second call without force, same clock → skipped.
    const s = await runAutoUpdate({
      currentVersion: "0.0.3",
      deps: { entryPath: npmEntry(), fetchLatest, now },
    });
    expect(s).toMatchObject({ status: "skipped", reason: "checked recently" });
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    // Past the throttle window → checks again.
    now.mockReturnValue(1_000_000 + CHECK_INTERVAL_MS + 1);
    await runAutoUpdate({
      currentVersion: "0.0.3",
      deps: { entryPath: npmEntry(), fetchLatest, now },
    });
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it("uses pnpm's install command when the entry lives under .pnpm", async () => {
    const runInstall = vi.fn(async () => undefined);
    const entry = fakeEntry([
      "pnpm",
      "global",
      "5",
      ".pnpm",
      "ccpool@0.0.3",
      "node_modules",
      "ccpool",
      "dist",
      "cli.js",
    ]);
    const s = await runAutoUpdate({
      currentVersion: "0.0.3",
      force: true,
      deps: {
        entryPath: entry,
        fetchLatest: async () => "1.0.0",
        runInstall,
      },
    });
    expect(s).toMatchObject({ status: "updated", manager: "pnpm" });
    expect(runInstall).toHaveBeenCalledWith("pnpm");
  });
});

describe("startAutoUpdate + subscribeUpdate", () => {
  it("is idempotent and notifies subscribers of the final state", async () => {
    const entry = fakeEntry(["lib", "node_modules", "ccpool", "dist", "cli.js"]);
    const seen: string[] = [];
    const unsub = subscribeUpdate((s) => seen.push(s.status));

    startAutoUpdate({
      currentVersion: "0.0.3",
      force: true,
      deps: {
        entryPath: entry,
        fetchLatest: async () => "0.0.3",
        runInstall: async () => undefined,
      },
    });
    // Second call must no-op (idempotent).
    startAutoUpdate({
      currentVersion: "0.0.3",
      force: true,
      deps: {
        entryPath: entry,
        fetchLatest: async () => {
          throw new Error("should not run");
        },
      },
    });

    // Wait for the background task.
    await vi.waitFor(() => {
      expect(getUpdateState().status).toBe("up-to-date");
    });

    unsub();
    expect(seen).toContain("checking");
    expect(seen).toContain("up-to-date");
    expect(updateErrorMessage()).toBeNull();
  });
});
