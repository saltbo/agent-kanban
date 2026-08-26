// @vitest-environment node
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Use a temp dir for STATE_DIR so tests don't pollute real state
const testStateDir = join(tmpdir(), `ak-test-updatecheck-${process.pid}`);

vi.mock("../packages/cli/src/paths.js", () => ({
  STATE_DIR: testStateDir,
  CONFIG_DIR: testStateDir,
  DATA_DIR: testStateDir,
  LOGS_DIR: join(testStateDir, "logs"),
  CONFIG_FILE: join(testStateDir, "config.json"),
  PID_FILE: join(testStateDir, "daemon.pid"),
  DAEMON_STATE_FILE: join(testStateDir, "daemon-state.json"),
  REPOS_DIR: join(testStateDir, "repos"),
  WORKTREES_DIR: join(testStateDir, "worktrees"),
  SESSIONS_DIR: join(testStateDir, "sessions"),
  TRACKED_TASKS_FILE: join(testStateDir, "tracked-tasks.json"),
  IDENTITIES_DIR: join(testStateDir, "identities"),
  LEGACY_SAVED_SESSIONS_FILE: join(testStateDir, "saved-sessions.json"),
  LEGACY_SESSION_PIDS_FILE: join(testStateDir, "session-pids.json"),
}));

vi.mock("../packages/cli/src/version.js", () => ({
  getVersion: () => "1.2.3",
}));

const CACHE_FILE = join(testStateDir, "update-check.json");

describe("compareVersions (via checkForUpdate behavior)", () => {
  beforeEach(() => {
    mkdirSync(testStateDir, { recursive: true });
    // Reset module cache so path mock takes effect
    vi.resetModules();
  });

  afterEach(() => {
    if (existsSync(testStateDir)) {
      rmSync(testStateDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns null when cache says current version equals latest", async () => {
    // Write cache with same version as current (1.2.3)
    mkdirSync(testStateDir, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ latest: "1.2.3", checkedAt: Date.now() }));
    const { checkForUpdate } = await import("../packages/cli/src/updateCheck.js");
    const result = await checkForUpdate();
    expect(result).toBeNull();
  });

  it("returns update info when cache has a newer version", async () => {
    mkdirSync(testStateDir, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ latest: "2.0.0", checkedAt: Date.now() }));
    const { checkForUpdate } = await import("../packages/cli/src/updateCheck.js");
    const result = await checkForUpdate();
    expect(result).not.toBeNull();
    expect(result?.current).toBe("1.2.3");
    expect(result?.latest).toBe("2.0.0");
  });

  it("returns null when cache has an older version than current", async () => {
    mkdirSync(testStateDir, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ latest: "1.0.0", checkedAt: Date.now() }));
    const { checkForUpdate } = await import("../packages/cli/src/updateCheck.js");
    const result = await checkForUpdate();
    expect(result).toBeNull();
  });

  it("returns update when patch version is higher", async () => {
    mkdirSync(testStateDir, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ latest: "1.2.4", checkedAt: Date.now() }));
    const { checkForUpdate } = await import("../packages/cli/src/updateCheck.js");
    const result = await checkForUpdate();
    expect(result?.latest).toBe("1.2.4");
  });

  it("returns null when cache is expired and fetch fails", async () => {
    mkdirSync(testStateDir, { recursive: true });
    const staleCheckedAt = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
    writeFileSync(CACHE_FILE, JSON.stringify({ latest: "9.9.9", checkedAt: staleCheckedAt }));
    // Mock fetch to simulate network failure
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
    const { checkForUpdate } = await import("../packages/cli/src/updateCheck.js");
    const result = await checkForUpdate();
    globalThis.fetch = originalFetch;
    // fetchLatestVersion returns null on network error → checkForUpdate returns null
    expect(result).toBeNull();
  });

  it("returns null when no cache and fetch fails", async () => {
    // Mock fetch to simulate network failure
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
    const { checkForUpdate } = await import("../packages/cli/src/updateCheck.js");
    const result = await checkForUpdate();
    globalThis.fetch = originalFetch;
    expect(result).toBeNull();
  });

  it("returns update info when no cache and fetch returns a newer version", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "99.0.0" }),
    } as Response);
    const { checkForUpdate } = await import("../packages/cli/src/updateCheck.js");
    const result = await checkForUpdate();
    globalThis.fetch = originalFetch;
    expect(result).not.toBeNull();
    expect(result?.latest).toBe("99.0.0");
    expect(result?.current).toBe("1.2.3");
  });

  it("returns null when fetch returns non-ok response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    } as Response);
    const { checkForUpdate } = await import("../packages/cli/src/updateCheck.js");
    const result = await checkForUpdate();
    globalThis.fetch = originalFetch;
    expect(result).toBeNull();
  });
});

describe("isNpx", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("returns true when npm_command is exec", async () => {
    vi.stubEnv("npm_command", "exec");
    const { isNpx } = await import("../packages/cli/src/updateCheck.js");
    expect(isNpx()).toBe(true);
  });

  it("returns true when argv[1] contains _npx/", async () => {
    const original = process.argv[1];
    process.argv[1] = "/home/user/.npm/_npx/abc123/node_modules/.bin/ak";
    vi.unstubAllEnvs();
    // Re-import to get fresh binding
    vi.resetModules();
    const { isNpx } = await import("../packages/cli/src/updateCheck.js");
    const result = isNpx();
    process.argv[1] = original;
    expect(result).toBe(true);
  });

  it("returns false when not using npx", async () => {
    vi.stubEnv("npm_command", "");
    const original = process.argv[1];
    process.argv[1] = "/usr/local/bin/ak";
    vi.resetModules();
    const { isNpx } = await import("../packages/cli/src/updateCheck.js");
    const result = isNpx();
    process.argv[1] = original;
    expect(result).toBe(false);
  });
});

describe("isWorkerAgent", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("returns true when AK_WORKER is 1", async () => {
    vi.stubEnv("AK_WORKER", "1");
    const { isWorkerAgent } = await import("../packages/cli/src/updateCheck.js");
    expect(isWorkerAgent()).toBe(true);
  });

  it("returns false when AK_WORKER is not set", async () => {
    vi.stubEnv("AK_WORKER", "");
    const { isWorkerAgent } = await import("../packages/cli/src/updateCheck.js");
    expect(isWorkerAgent()).toBe(false);
  });

  it("returns false when AK_WORKER is 0", async () => {
    vi.stubEnv("AK_WORKER", "0");
    const { isWorkerAgent } = await import("../packages/cli/src/updateCheck.js");
    expect(isWorkerAgent()).toBe(false);
  });
});
