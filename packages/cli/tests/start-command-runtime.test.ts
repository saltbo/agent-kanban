// @vitest-environment node

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  directory: `/tmp/ak-start-runtime-${process.pid}`,
  registerMachine: vi.fn(),
  getMachine: vi.fn(),
  getCredentials: vi.fn(),
  setCurrent: vi.fn(),
  isPidAlive: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: state.spawn, spawnSync: state.spawnSync }));
vi.mock("../src/config.js", () => ({ getCredentials: state.getCredentials, setCurrent: state.setCurrent }));
vi.mock("../src/client/machine.js", () => ({
  MachineClient: vi.fn().mockImplementation(() => ({ registerMachine: state.registerMachine, getMachine: state.getMachine })),
}));
vi.mock("../src/session/store.js", () => ({ isPidAlive: state.isPidAlive }));
vi.mock("../src/paths.js", () => ({
  CONFIG_DIR: state.directory,
  CONFIG_FILE: `${state.directory}/config.json`,
  SESSIONS_DIR: `${state.directory}/sessions`,
  PID_FILE: `${state.directory}/daemon.pid`,
  DAEMON_STATE_FILE: `${state.directory}/daemon-state.json`,
  LOGS_DIR: `${state.directory}/logs`,
  STATE_DIR: state.directory,
}));
vi.mock("../src/amaRunner.js", () => ({
  resolveAmaRunnerBinary: vi.fn(async () => ({
    path: `${state.directory}/ama-runner`,
    version: { name: "ama-runner", version: "1.2.3", commit: "test", buildDate: "test" },
  })),
}));
vi.mock("../src/providers/registry.js", () => ({ getAvailableProviders: () => [{ name: "codex" }] }));
vi.mock("../src/device.js", () => ({ generateDeviceId: () => "device-test" }));
vi.mock("../src/machineName.js", () => ({ resolveMachineName: () => "test-machine" }));
vi.mock("../src/version.js", () => ({ getVersion: () => "9.9.9" }));

const { registerLogsCommand, registerRestartCommand, registerStartCommand, registerStatusCommand, registerStopCommand } = await import(
  "../src/commands/start.js"
);

beforeEach(() => {
  rmSync(state.directory, { recursive: true, force: true });
  mkdirSync(`${state.directory}/logs`, { recursive: true });
  vi.clearAllMocks();
  state.getCredentials.mockReturnValue({ apiUrl: "https://ak.example.test" });
  state.registerMachine.mockResolvedValue({
    id: "machine-1",
    name: "test-machine",
    runner: {
      origin: "https://ama.example.test",
      projectId: "project-1",
      environmentId: "environment-1",
    },
  });
  state.getMachine.mockResolvedValue({
    id: "machine-1",
    status: "online",
    last_heartbeat_at: new Date().toISOString(),
    runtimes: [{ name: "codex", status: "ready" }],
  });
  state.isPidAlive.mockReturnValue(false);
  state.spawn.mockReturnValue({ pid: 12345, unref: vi.fn() });
  state.spawnSync.mockReturnValue({ status: 0 });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
  rmSync(state.directory, { recursive: true, force: true });
});

describe("ak start Machine runner lifecycle", () => {
  it("registers through the Realmroot MachineClient and applies AMA runner onboarding", async () => {
    const program = command(registerStartCommand);
    await program.parseAsync(["start", "--max-concurrent", "3"], { from: "user" });

    expect(state.registerMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "test-machine",
        device_id: "device-test",
        runtimes: [{ name: "codex", status: "ready", checked_at: expect.any(String) }],
      }),
    );
    expect(state.spawnSync).toHaveBeenCalledWith(
      `${state.directory}/ama-runner`,
      ["auth", "login", "--api-server", "https://ama.example.test"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(state.spawn).toHaveBeenCalledWith(
      `${state.directory}/ama-runner`,
      [
        "--api-server",
        "https://ama.example.test",
        "--project-id",
        "project-1",
        "--environment-id",
        "environment-1",
        "--max-concurrent",
        "3",
        "--allow-unsafe-process",
      ],
      expect.objectContaining({ detached: true, windowsHide: true }),
    );
    expect(JSON.parse(readFileSync(`${state.directory}/daemon-state.json`, "utf8"))).toMatchObject({
      apiUrl: "https://ak.example.test",
      machineId: "machine-1",
      maxConcurrent: 3,
      runtime: "ama-runner",
    });
  });

  it("logs out and re-runs runner login when refresh fails", async () => {
    writeFileSync(
      `${state.directory}/ama-runner-credentials.json`,
      JSON.stringify({
        active: "https://ama.example.test#account-1",
        profiles: [
          {
            accountId: "account-1",
            apiServer: "https://ama.example.test",
            accessToken: "expired",
            refreshToken: "stale-refresh",
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
          },
        ],
      }),
    );
    state.spawnSync.mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 0 });

    await command(registerStartCommand).parseAsync(["start"], { from: "user" });

    expect(state.spawnSync.mock.calls.map((call) => call[1])).toEqual([
      ["auth", "refresh"],
      ["auth", "logout", "https://ama.example.test"],
      ["auth", "login", "--api-server", "https://ama.example.test"],
    ]);
    expect(console.error).toHaveBeenCalledWith("Saved ama-runner login could not be refreshed; re-authenticating.");
  });

  it("stops a running Machine runner with SIGTERM", async () => {
    writeRuntimeState(777, 4);
    state.isPidAlive.mockReturnValueOnce(true).mockReturnValue(false);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    await command(registerStopCommand).parseAsync(["stop"], { from: "user" });

    expect(kill).toHaveBeenCalledWith(777, "SIGTERM");
    expect(console.log).toHaveBeenCalledWith("● Machine runner stopped (PID 777)");
  });

  it("reports local process and server heartbeat status", async () => {
    writeRuntimeState(778, 4);
    state.isPidAlive.mockReturnValue(true);

    await command(registerStatusCommand).parseAsync(["status"], { from: "user" });

    expect(state.getMachine).toHaveBeenCalledWith("machine-1");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Machine runner running (PID 778"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("● online"));
    expect(console.log).toHaveBeenCalledWith("  Runtimes:    codex");
  });

  it("restarts with the previous concurrency after stopping the old process", async () => {
    writeRuntimeState(779, 7);
    state.isPidAlive.mockReturnValueOnce(true).mockReturnValue(false);
    vi.spyOn(process, "kill").mockImplementation(() => true);

    await command(registerRestartCommand).parseAsync(["restart"], { from: "user" });

    expect(state.spawn).toHaveBeenCalledWith(
      `${state.directory}/ama-runner`,
      expect.arrayContaining(["--max-concurrent", "7"]),
      expect.objectContaining({ detached: true }),
    );
  });

  it("prints only the requested tail of the runner log", async () => {
    writeFileSync(`${state.directory}/logs/daemon.log`, "one\ntwo\nthree\n");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await command(registerLogsCommand).parseAsync(["logs", "--lines", "2"], { from: "user" });

    expect(write).toHaveBeenCalledWith("two\nthree\n");
  });
});

function command(register: (program: Command) => void): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

function writeRuntimeState(pid: number, maxConcurrent: number): void {
  writeFileSync(`${state.directory}/daemon.pid`, String(pid));
  writeFileSync(
    `${state.directory}/daemon-state.json`,
    JSON.stringify({
      providers: ["codex"],
      maxConcurrent,
      apiUrl: "https://ak.example.test",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      runtime: "ama-runner",
      machineId: "machine-1",
    }),
  );
}
