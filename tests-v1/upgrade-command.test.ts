// @vitest-environment node
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testStateDir = join(tmpdir(), `ak-test-upgrade-${process.pid}`);

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
  getVersion: () => "1.0.0",
}));

// Module-level mock with controllable spy
const mockFetchLatestVersion = vi.fn<[], Promise<string | null>>();
const mockIsNpx = vi.fn(() => false);
vi.mock("../packages/cli/src/updateCheck.js", () => ({
  fetchLatestVersion: mockFetchLatestVersion,
  isNpx: mockIsNpx,
  isWorkerAgent: () => false,
  checkForUpdate: vi.fn(() => Promise.resolve(null)),
}));

const mockExecSync = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
  execFileSync: vi.fn(),
}));

function buildProgram(captureAction: (fn: () => Promise<void>) => void): any {
  return {
    command: () => ({
      description: () => ({
        action: (fn: () => Promise<void>) => {
          captureAction(fn);
        },
      }),
    }),
  };
}

async function runUpgradeAction(): Promise<void> {
  const { registerUpgradeCommand } = await import("../packages/cli/src/commands/upgrade.js");
  let action!: () => Promise<void>;
  registerUpgradeCommand(buildProgram((fn) => (action = fn)));
  await action();
}

describe("registerUpgradeCommand", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let savedArgv1: string;

  beforeEach(() => {
    mkdirSync(testStateDir, { recursive: true });
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Make process.exit throw so code stops after calling it (like the real exit)
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
    savedArgv1 = process.argv[1];
    process.argv[1] = "/usr/local/bin/ak";
    vi.unstubAllEnvs();
    // Reset mock implementations
    mockFetchLatestVersion.mockReset();
    mockIsNpx.mockReturnValue(false);
    mockExecSync.mockReset();
  });

  afterEach(() => {
    process.argv[1] = savedArgv1;
    vi.restoreAllMocks();
    if (existsSync(testStateDir)) {
      rmSync(testStateDir, { recursive: true, force: true });
    }
  });

  it("logs npx message and returns early when running via npx", async () => {
    mockIsNpx.mockReturnValue(true);
    await runUpgradeAction();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("npx"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("1.0.0"));
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockFetchLatestVersion).not.toHaveBeenCalled();
  });

  it("exits with code 1 when fetch fails (network unavailable)", async () => {
    mockFetchLatestVersion.mockResolvedValue(null);
    await expect(runUpgradeAction()).rejects.toThrow("process.exit(1)");

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("npm registry"));
  });

  it("logs already-up-to-date when current version equals latest", async () => {
    // current = 1.0.0, latest = 1.0.0 → not below min
    mockFetchLatestVersion.mockResolvedValue("1.0.0");
    await runUpgradeAction();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("latest version"));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("logs already-up-to-date when current version is newer than latest", async () => {
    // current = 1.0.0, latest = 0.9.0 → not below min
    mockFetchLatestVersion.mockResolvedValue("0.9.0");
    await runUpgradeAction();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("latest version"));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("runs npm install -g when update available and method is global", async () => {
    mockFetchLatestVersion.mockResolvedValue("2.0.0");
    await runUpgradeAction();

    expect(mockExecSync).toHaveBeenCalledWith("npm install -g agent-kanban", { stdio: "inherit" });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("runs volta install when argv[1] contains .volta/ and update is available", async () => {
    process.argv[1] = "/home/user/.volta/bin/ak";
    mockFetchLatestVersion.mockResolvedValue("2.0.0");
    await runUpgradeAction();

    expect(mockExecSync).toHaveBeenCalledWith("volta install agent-kanban", { stdio: "inherit" });
  });

  it("logs upgraded version after successful install", async () => {
    mockFetchLatestVersion.mockResolvedValue("3.0.0");
    await runUpgradeAction();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("3.0.0"));
  });

  it("logs error and exits with code 1 when upgrade command throws an Error", async () => {
    mockFetchLatestVersion.mockResolvedValue("2.0.0");
    mockExecSync.mockImplementation(() => {
      throw new Error("command not found");
    });
    await expect(runUpgradeAction()).rejects.toThrow("process.exit(1)");

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Upgrade failed"));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("command not found"));
  });

  it("logs error and exits with code 1 when upgrade command throws a non-Error", async () => {
    mockFetchLatestVersion.mockResolvedValue("2.0.0");
    mockExecSync.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "string error";
    });
    await expect(runUpgradeAction()).rejects.toThrow("process.exit(1)");

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Upgrade failed"));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("string error"));
  });
});
