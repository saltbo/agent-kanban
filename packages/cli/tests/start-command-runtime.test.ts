// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const runnerCredentialsFile = `${state.directory}/ama-runner-credentials.json`;
const defaultAmaOrigin = "https://ama.example.test";
const contextLoginMarker = runnerContextLoginMarker(defaultAmaOrigin);

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

  it("clears a pre-Context credential before login and writes a private migration marker", async () => {
    writeRunnerCredentials({ accessToken: "old-access", expiresAt: futureExpiry() });
    state.spawnSync.mockImplementation((_command, args) => {
      if (args[1] === "logout") {
        rmSync(runnerCredentialsFile);
        return { status: 0 };
      }
      if (args[1] === "login") {
        writeRunnerCredentials({ accessToken: "context-access", expiresAt: futureExpiry() });
        return { status: 0 };
      }
      return { status: 1 };
    });

    await command(registerStartCommand).parseAsync(["start"], { from: "user" });

    expect(state.spawnSync.mock.calls.map((call) => call[1])).toEqual([
      ["auth", "logout", "https://ama.example.test"],
      ["auth", "login", "--api-server", "https://ama.example.test"],
    ]);
    expect(readFileSync(contextLoginMarker, "utf8")).toBe("authorization-code-pkce\n");
    expect(statSync(contextLoginMarker).mode & 0o777).toBe(0o600);
  });

  it("migrates Context login independently for canonicalized origins in one credential store", async () => {
    const originA = "https://ama-a.example.test";
    const originB = "https://ama-b.example.test";
    writeRunnerCredentialStore({
      active: `${originB}/#legacy-b`,
      profiles: [
        { accountId: "legacy-a", apiServer: `${originA}/`, accessToken: "old-a", expiresAt: futureExpiry() },
        { accountId: "legacy-b", apiServer: `${originB}/`, accessToken: "old-b", expiresAt: futureExpiry() },
      ],
    });
    state.registerMachine
      .mockResolvedValueOnce(registeredMachine(`${originA}/`))
      .mockResolvedValueOnce(registeredMachine(`${originB}/`))
      .mockResolvedValueOnce(registeredMachine(`${originA}/`));
    state.spawnSync.mockImplementation((_command, args) => {
      const action = args[1];
      if (action === "logout") {
        const origin = String(args[2]);
        const store = readRunnerCredentialStore();
        const profiles = store.profiles.filter((profile) => canonicalOrigin(profile.apiServer) !== canonicalOrigin(origin));
        writeRunnerCredentialStore({
          active: profiles.length === 1 ? `${profiles[0].apiServer}#${profiles[0].accountId}` : store.active,
          profiles,
        });
        return { status: 0 };
      }
      if (action === "login") {
        const origin = canonicalOrigin(String(args[3]));
        const accountId = origin === originA ? "context-a" : "context-b";
        const store = readRunnerCredentialStore();
        writeRunnerCredentialStore({
          active: `${origin}#${accountId}`,
          profiles: [...store.profiles, { accountId, apiServer: origin, accessToken: `access-${accountId}`, expiresAt: futureExpiry() }],
        });
        return { status: 0 };
      }
      return { status: 1 };
    });

    await command(registerStartCommand).parseAsync(["start"], { from: "user" });
    expect(
      readRunnerCredentialStore()
        .profiles.map((profile) => canonicalOrigin(profile.apiServer))
        .sort(),
    ).toEqual([originA, originB]);
    expect(readRunnerCredentialStore().profiles.find((profile) => canonicalOrigin(profile.apiServer) === originB)?.accessToken).toBe("old-b");

    await command(registerStartCommand).parseAsync(["start"], { from: "user" });
    await command(registerStartCommand).parseAsync(["start"], { from: "user" });

    expect(state.spawnSync.mock.calls.map((call) => call[1])).toEqual([
      ["auth", "logout", originA],
      ["auth", "login", "--api-server", originA],
      ["auth", "logout", originB],
      ["auth", "login", "--api-server", originB],
    ]);
    expect(
      readRunnerCredentialStore()
        .profiles.map((profile) => canonicalOrigin(profile.apiServer))
        .sort(),
    ).toEqual([originA, originB]);
    expect(readRunnerCredentialStore().profiles.find((profile) => canonicalOrigin(profile.apiServer) === originA)?.accessToken).toBe(
      "access-context-a",
    );
    const markers = [runnerContextLoginMarker(`${originA}/`), runnerContextLoginMarker(`${originB}/`)];
    expect(
      readdirSync(state.directory)
        .filter((name) => name.startsWith("ama-runner-context-login-"))
        .sort(),
    ).toEqual(markers.map((marker) => marker.slice(state.directory.length + 1)).sort());
    for (const marker of markers) {
      expect(readFileSync(marker, "utf8")).toBe("authorization-code-pkce\n");
      expect(statSync(marker).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps a valid Context-login credential silent when the marker exists", async () => {
    writeFileSync(contextLoginMarker, "authorization-code-pkce\n", { mode: 0o600 });
    writeRunnerCredentials({ accessToken: "valid-access", expiresAt: futureExpiry() });

    await command(registerStartCommand).parseAsync(["start"], { from: "user" });

    expect(state.spawnSync).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Authenticating ama-runner"));
  });

  it("refreshes an expiring marked credential without starting interactive login", async () => {
    writeFileSync(contextLoginMarker, "authorization-code-pkce\n", { mode: 0o600 });
    writeRunnerCredentials({ accessToken: "expired-access", refreshToken: "refresh-token", expiresAt: new Date(0).toISOString() });

    await command(registerStartCommand).parseAsync(["start"], { from: "user" });

    expect(state.spawnSync.mock.calls.map((call) => call[1])).toEqual([["auth", "refresh"]]);
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Authenticating ama-runner"));
  });

  it.each([
    { name: "non-zero status", result: { status: 19 }, message: "Failed to clear pre-Context ama-runner login (exit status 19)" },
    {
      name: "spawn error",
      result: { status: null, error: new Error("logout unavailable") },
      message: "Failed to clear pre-Context ama-runner login: logout unavailable",
    },
  ])("fails fast when pre-Context logout returns a $name", async ({ result, message }) => {
    writeRunnerCredentials({ accessToken: "old-access", expiresAt: futureExpiry() });
    state.spawnSync.mockReturnValue(result);

    await expect(command(registerStartCommand).parseAsync(["start"], { from: "user" })).rejects.toThrow(message);

    expect(state.spawnSync).toHaveBeenCalledTimes(1);
    expect(state.spawnSync).toHaveBeenCalledWith(
      `${state.directory}/ama-runner`,
      ["auth", "logout", "https://ama.example.test"],
      expect.objectContaining({ stdio: "ignore" }),
    );
    expect(state.spawnSync).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(["login"]), expect.anything());
    expect(() => statSync(contextLoginMarker)).toThrow();
  });

  it("does not write the migration marker when Context login fails", async () => {
    state.spawnSync.mockReturnValue({ status: 7 });

    await expect(command(registerStartCommand).parseAsync(["start"], { from: "user" })).rejects.toThrow(
      "ama-runner login did not complete (exit status 7); cannot start the machine runner",
    );

    expect(state.spawnSync).toHaveBeenCalledWith(
      `${state.directory}/ama-runner`,
      ["auth", "login", "--api-server", "https://ama.example.test"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(() => statSync(contextLoginMarker)).toThrow();
  });

  it("performs Context login once and keeps the next start silent", async () => {
    state.spawnSync.mockImplementation((_command, args) => {
      if (args[1] === "login") {
        writeRunnerCredentials({ accessToken: "context-access", expiresAt: futureExpiry() });
        return { status: 0 };
      }
      return { status: 1 };
    });

    await command(registerStartCommand).parseAsync(["start"], { from: "user" });
    expect(state.spawnSync.mock.calls.map((call) => call[1])).toEqual([["auth", "login", "--api-server", "https://ama.example.test"]]);

    vi.mocked(console.log).mockClear();
    await command(registerStartCommand).parseAsync(["start"], { from: "user" });

    expect(state.spawnSync).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Authenticating ama-runner"));
  });

  it("logs out and re-runs runner login when refresh fails", async () => {
    writeFileSync(contextLoginMarker, "authorization-code-pkce\n", { mode: 0o600 });
    writeFileSync(
      runnerCredentialsFile,
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

function futureExpiry(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function writeRunnerCredentials(profile: { accessToken: string; refreshToken?: string; expiresAt: string }): void {
  writeRunnerCredentialStore({
    active: `${defaultAmaOrigin}#account-1`,
    profiles: [{ accountId: "account-1", apiServer: defaultAmaOrigin, ...profile }],
  });
}

interface TestRunnerCredentialProfile {
  accountId: string;
  apiServer: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
}

interface TestRunnerCredentialStore {
  active: string;
  profiles: TestRunnerCredentialProfile[];
}

function writeRunnerCredentialStore(store: TestRunnerCredentialStore): void {
  writeFileSync(runnerCredentialsFile, JSON.stringify(store), { mode: 0o600 });
}

function readRunnerCredentialStore(): TestRunnerCredentialStore {
  return JSON.parse(readFileSync(runnerCredentialsFile, "utf8"));
}

function canonicalOrigin(origin: string): string {
  return origin.replace(/\/$/, "");
}

function runnerContextLoginMarker(origin: string): string {
  const hash = createHash("sha256").update(canonicalOrigin(origin)).digest("hex").slice(0, 32);
  return `${state.directory}/ama-runner-context-login-${hash}-v1`;
}

function registeredMachine(origin: string) {
  return {
    id: "machine-1",
    name: "test-machine",
    runner: { origin, projectId: "project-1", environmentId: "environment-1" },
  };
}
