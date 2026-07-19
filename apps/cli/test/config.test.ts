import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeAccountId,
  configPath,
  listProfileIds,
  loadConfig,
  loadProfile,
  newConfig,
  saveConfig,
} from "../src/lib/config.js";

let ccpool: string;
let claude: string;

/** Point the observed Claude config dir at an account (hydrated) or nobody. */
function setLiveAccount(accountUuid: string | null): void {
  writeFileSync(
    join(claude, ".claude.json"),
    JSON.stringify(accountUuid ? { oauthAccount: { accountUuid } } : { userID: 7 })
  );
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "ccpool-cfg-"));
  ccpool = join(root, ".ccpool");
  claude = join(root, ".claude");
  mkdirSync(ccpool, { recursive: true });
  mkdirSync(claude, { recursive: true });
  process.env.CCPOOL_DIR = ccpool;
  process.env.CLAUDE_CONFIG_DIR = claude;
});

afterEach(() => {
  delete process.env.CCPOOL_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
});

describe("per-account profiles", () => {
  it("resolves the active profile by the live Claude account", async () => {
    setLiveAccount("acc-1");
    expect(await activeAccountId()).toBe("acc-1");
    await saveConfig(
      newConfig({
        serverUrl: "https://x",
        token: "t1",
        name: "sam",
        accountId: "acc-1",
        configDirs: [claude],
      })
    );

    const cfg = await loadConfig();
    expect(cfg?.accountId).toBe("acc-1");
    expect(cfg?.name).toBe("sam");
    expect(cfg?.server.token).toBe("t1"); // the 0600 token is rejoined on load
  });

  it("keeps two accounts side by side and switches with the live account", async () => {
    setLiveAccount("acc-1");
    await saveConfig(
      newConfig({
        serverUrl: "https://x",
        token: "t1",
        name: "sam",
        accountId: "acc-1",
        configDirs: [claude],
      })
    );
    setLiveAccount("acc-2");
    await saveConfig(
      newConfig({
        serverUrl: "https://x",
        token: "t2",
        name: "bob",
        accountId: "acc-2",
        configDirs: [claude],
      })
    );

    expect((await listProfileIds()).sort()).toEqual(["acc-1", "acc-2"]);
    expect((await loadConfig())?.name).toBe("bob"); // acc-2 is live

    setLiveAccount("acc-1"); // switch back
    expect((await loadConfig())?.name).toBe("sam");
  });

  it("returns null when the live account has no profile (personal-Pro case)", async () => {
    setLiveAccount("acc-1");
    await saveConfig(
      newConfig({
        serverUrl: "https://x",
        token: "t1",
        name: "sam",
        accountId: "acc-1",
        configDirs: [claude],
      })
    );
    setLiveAccount("acc-personal"); // a different account, never joined
    expect(await loadConfig()).toBeNull();
  });

  it("returns null when no Claude account is onboarded", async () => {
    setLiveAccount(null); // only a pre-login userID
    expect(await activeAccountId()).toBeNull();
    expect(await loadConfig()).toBeNull();
  });

  it("migrates a legacy single-profile ~/.ccpool into the live account's dir", async () => {
    setLiveAccount("acc-1");
    // Pre-multi-account layout: config.json + token at the ccpool root.
    writeFileSync(
      join(ccpool, "config.json"),
      JSON.stringify({
        server: { url: "https://x" },
        name: "legacy",
        pollIntervalMs: 60_000,
        configDirs: [claude],
        logLevel: "info",
      })
    );
    writeFileSync(join(ccpool, "token"), "legacy-token");

    const cfg = await loadConfig();
    expect(cfg?.name).toBe("legacy");
    expect(cfg?.accountId).toBe("acc-1");
    expect(cfg?.server.token).toBe("legacy-token"); // token migrated too

    // Filed under the live account; the legacy files are gone.
    expect(existsSync(configPath("acc-1"))).toBe(true);
    expect(existsSync(join(ccpool, "config.json"))).toBe(false);
    expect(existsSync(join(ccpool, "token"))).toBe(false);
    expect(await loadProfile("acc-1")).not.toBeNull();
  });

  it("does not migrate when no account is live yet (retries later)", async () => {
    setLiveAccount(null);
    writeFileSync(
      join(ccpool, "config.json"),
      JSON.stringify({
        server: { url: "https://x" },
        name: "legacy",
        pollIntervalMs: 60_000,
        configDirs: [claude],
        logLevel: "info",
      })
    );
    expect(await loadConfig()).toBeNull();
    // legacy file untouched, ready to migrate once an account is onboarded
    expect(existsSync(join(ccpool, "config.json"))).toBe(true);

    setLiveAccount("acc-1");
    expect((await loadConfig())?.name).toBe("legacy"); // now it migrates
    expect(existsSync(join(ccpool, "config.json"))).toBe(false);
  });
});
