// @vitest-environment node

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsHarness = vi.hoisted(() => ({
  closedFds: [] as number[],
}));
const startupLock = vi.hoisted(() => ({ lock: vi.fn() }));

vi.mock("../node_modules/proper-lockfile/index.js", () => ({
  default: { lock: startupLock.lock },
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    closeSync(fd: number) {
      fsHarness.closedFds.push(fd);
      actual.closeSync(fd);
    },
  };
});

const testSessionsDir = join(tmpdir(), `ak-start-command-test-${randomUUID()}`);
const testRunnerBin = join(testSessionsDir, "runners", "ama-runner");
let localSpawnBehavior: "ready" | "error" | "exit" | "manual" = "ready";
let amaSpawnBehavior: "spawn" | "manual" = "spawn";
let lastSpawnChild:
  | (EventEmitter & {
      pid: number;
      connected: boolean;
      disconnect: ReturnType<typeof vi.fn>;
      kill: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      unref: ReturnType<typeof vi.fn>;
    })
  | undefined;
const spawnedChildren: NonNullable<typeof lastSpawnChild>[] = [];
const spawnMock = vi.fn((command: string, args: string[], options: { env?: Record<string, string>; stdio?: unknown[] }) => {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    connected: boolean;
    disconnect: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  child.pid = 12345;
  child.connected = true;
  child.disconnect = vi.fn(() => {
    child.connected = false;
  });
  child.kill = vi.fn();
  child.send = vi.fn();
  child.unref = vi.fn();
  lastSpawnChild = child;
  spawnedChildren.push(child);
  queueMicrotask(() => {
    if (command === process.execPath && args.includes("__daemon") && options.stdio?.[3] === "ipc") {
      if (localSpawnBehavior === "ready") child.emit("message", { type: "ready", machineId: "machine_local" });
      if (localSpawnBehavior === "error") child.emit("error", new Error("local spawn failed"));
      if (localSpawnBehavior === "exit") child.emit("exit", 1, null);
      return;
    }
    if (amaSpawnBehavior === "spawn") child.emit("spawn");
  });
  return child;
});
const spawnSyncMock = vi.fn(() => ({ status: 0 }));

vi.mock("node:child_process", () => ({ spawn: spawnMock, spawnSync: spawnSyncMock }));
vi.mock("../src/amaRunner.js", () => ({
  resolveAmaRunnerBinary: vi.fn(async () => ({
    path: testRunnerBin,
    version: { name: "ama-runner", version: "0.1.0", commit: "test-commit", buildDate: "test-build" },
  })),
}));
vi.mock("../src/providers/registry.js", () => ({ getAvailableProviders: () => [{ name: "codex" }] }));
vi.mock("../src/device.js", () => ({ generateDeviceId: () => "device-test" }));
vi.mock("../src/machineName.js", () => ({ resolveMachineName: () => "test-machine" }));

function mockMachineRunnerFetch(origin = "https://runner-control.test") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://ak.test/api/machines") {
      return new Response(
        JSON.stringify({
          id: "machine_1",
          name: "test-machine",
          runner: {
            origin,
            projectId: "project_1",
            environmentId: "env_1",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return {
    ...actual,
    CONFIG_DIR: testSessionsDir,
    CONFIG_FILE: join(testSessionsDir, "config.json"),
    SESSIONS_DIR: testSessionsDir,
    LEGACY_SAVED_SESSIONS_FILE: join(testSessionsDir, "saved-sessions.json"),
    LEGACY_SESSION_PIDS_FILE: join(testSessionsDir, "session-pids.json"),
    PID_FILE: join(testSessionsDir, "daemon.pid"),
    DAEMON_STATE_FILE: join(testSessionsDir, "daemon-state.json"),
    LOGS_DIR: join(testSessionsDir, "logs"),
    STATE_DIR: testSessionsDir,
  };
});

const { clearAllSessions } = await import("../src/session/store.js");
const {
  readLastLogLines,
  registerRestartCommand: registerRestartCommandSource,
  registerStartCommand: registerStartCommandSource,
  registerStatusCommand,
  registerStopCommand,
  registerLogsCommand,
} = await import("../src/commands/start.js");
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function _makeSession(overrides: Partial<import("../src/session/store.js").SessionFile> = {}): import("../src/session/store.js").SessionFile {
  return {
    type: "worker",
    agentId: randomUUID(),
    sessionId: randomUUID(),
    runtime: "claude" as any,
    startedAt: Date.now(),
    apiUrl: "https://example.com",
    privateKeyJwk: { kty: "OKP", crv: "Ed25519", x: "abc", d: "def" },
    status: "active",
    taskId: `task-${randomUUID()}`,
    ...overrides,
  };
}

function _setTTY(stdin: boolean, stdout: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true });
}

const credentialsFilePath = join(testSessionsDir, "ama-runner-credentials.json");
const legacyLoginFilePath = join(testSessionsDir, "ama-runner-login.json");

// Most historical tests in this file exercise AMA runner onboarding. Keep that
// coverage explicit now that the product default is the local daemon.
function registerStartCommand(program: Command): void {
  registerStartCommandSource(program);
  program.commands.find((command) => command.name() === "start")?.setOptionValueWithSource("mode", "ama", "default");
}

function registerRestartCommand(program: Command): void {
  registerRestartCommandSource(program);
  program.commands.find((command) => command.name() === "restart")?.setOptionValueWithSource("mode", "ama", "default");
}

function writeCredentialStore(profile: { apiServer: string; accessToken?: string; refreshToken?: string; expiresAt?: string; accountId?: string }) {
  const accountId = profile.accountId ?? "account_1";
  writeFileSync(
    credentialsFilePath,
    JSON.stringify({
      active: `${profile.apiServer.replace(/\/$/, "")}#${accountId}`,
      profiles: [
        {
          accountId,
          apiServer: profile.apiServer,
          accessToken: profile.accessToken ?? "x",
          ...(profile.refreshToken ? { refreshToken: profile.refreshToken } : {}),
          ...(profile.expiresAt ? { expiresAt: profile.expiresAt } : {}),
        },
      ],
    }),
  );
}

beforeEach(() => {
  mkdirSync(testSessionsDir, { recursive: true });
  // Isolate from the host environment: useEnvironmentCredentials() falls back
  // to AK_API_URL/AK_API_KEY, which are set on real AK worker machines and
  // would otherwise leak into the no-credentials error-path tests.
  vi.stubEnv("AK_API_URL", "");
  vi.stubEnv("AK_API_KEY", "");
  localSpawnBehavior = "ready";
  amaSpawnBehavior = "spawn";
  lastSpawnChild = undefined;
  spawnedChildren.length = 0;
  fsHarness.closedFds.length = 0;
  spawnMock.mockClear();
  startupLock.lock.mockReset();
  startupLock.lock.mockImplementation(async () => vi.fn(async () => {}));
  spawnSyncMock.mockClear();
  spawnSyncMock.mockReturnValue({ status: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  clearAllSessions();
  rmSync(testSessionsDir, { recursive: true, force: true });
  if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
  else delete (process.stdin as any).isTTY;
  if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
  else delete (process.stdout as any).isTTY;
});

describe("start runtime command", () => {
  it("defaults to the local daemon, registers the machine, and skips AMA onboarding", async () => {
    const program = new Command();
    registerStartCommandSource(program);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await program.parseAsync(
      ["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key", "--poll-interval", "5000", "--task-timeout", "60000"],
      { from: "user" },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [process.argv[1], "__daemon", "--max-concurrent", "5", "--poll-interval", "5000", "--task-timeout", "60000"],
      expect.objectContaining({ detached: true, stdio: expect.arrayContaining(["ipc"]), windowsHide: true }),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Local machine runner started"));
    expect(JSON.parse(readFileSync(join(testSessionsDir, "daemon-state.json"), "utf-8"))).toMatchObject({
      runtime: "local-daemon",
      machineId: "machine_local",
      pollInterval: 5000,
      taskTimeout: 60000,
    });
  });

  it("does not pass control-plane secrets to the local daemon process", async () => {
    for (const key of [
      "AK_API_KEY",
      "AMA_TOKEN",
      "AMA_RUNNER_CONFIG",
      "AMA_RUNNER_CREDENTIALS",
      "AMA_OIDC_CLIENT_SECRET",
      "OIDC_CLIENT_SECRET",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_API_KEY",
      "CF_API_TOKEN",
      "CF_API_KEY",
    ]) {
      vi.stubEnv(key, `secret-${key}`);
    }
    vi.stubEnv("ANTHROPIC_API_KEY", "provider-secret");
    vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerStartCommandSource(program);
    await program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    const childEnv = spawnMock.mock.calls[0]?.[2]?.env as Record<string, string>;
    expect(childEnv.ANTHROPIC_API_KEY).toBe("provider-secret");
    for (const key of [
      "AK_API_KEY",
      "AMA_TOKEN",
      "AMA_RUNNER_CONFIG",
      "AMA_RUNNER_CREDENTIALS",
      "AMA_OIDC_CLIENT_SECRET",
      "OIDC_CLIENT_SECRET",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_API_KEY",
      "CF_API_TOKEN",
      "CF_API_KEY",
    ]) {
      expect(childEnv).not.toHaveProperty(key);
    }
  });

  it.each([
    ["local", "local"],
    ["ama", "ama"],
    ["ama", "local"],
  ] as const)("serializes %s then %s startup with the shared transaction lock", async (winnerMode, loserMode) => {
    localSpawnBehavior = "manual";
    amaSpawnBehavior = "manual";
    if (winnerMode === "ama") mockMachineRunnerFetch();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "kill").mockImplementation((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) return true;
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const secondRelease = vi.fn(async () => {});
    let grantSecond: ((release: typeof secondRelease) => void) | undefined;
    const secondLock = new Promise<typeof secondRelease>((resolve) => {
      grantSecond = resolve;
    });
    const firstRelease = vi.fn(async () => {
      grantSecond?.(secondRelease);
    });
    startupLock.lock.mockResolvedValueOnce(firstRelease).mockReturnValueOnce(secondLock);
    const winner = new Command();
    const loser = new Command();
    registerStartCommandSource(winner);
    registerStartCommandSource(loser);

    const winnerStarted = winner.parseAsync(["start", "--mode", winnerMode, "--api-url", "https://ak.test", "--api-key", "ak_test_key"], {
      from: "user",
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    const winnerChild = lastSpawnChild;
    const loserStarted = loser.parseAsync(["start", "--mode", loserMode, "--api-url", "https://ak.test", "--api-key", "ak_test_key"], {
      from: "user",
    });
    await vi.waitFor(() => expect(startupLock.lock).toHaveBeenCalledTimes(2));

    expect(spawnMock).toHaveBeenCalledOnce();
    if (winnerMode === "local") winnerChild?.emit("message", { type: "ready", machineId: "machine_lock_winner" });
    else winnerChild?.emit("spawn");
    await winnerStarted;
    await expect(loserStarted).rejects.toThrow("process.exit");

    expect(startupLock.lock).toHaveBeenNthCalledWith(1, join(testSessionsDir, "daemon.pid"), {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 20, minTimeout: 50, maxTimeout: 250 },
    });
    expect(startupLock.lock.mock.calls[1]?.[0]).toBe(startupLock.lock.mock.calls[0]?.[0]);
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).toHaveBeenCalledOnce();
    expect(readFileSync(join(testSessionsDir, "daemon.pid"), "utf8")).toBe("12345");
  });

  it("finishes AMA onboarding and interactive login before acquiring the startup lock", async () => {
    const fetchSpy = mockMachineRunnerFetch();
    vi.spyOn(console, "log").mockImplementation(() => {});
    let loginObservedWithoutLock = false;
    spawnSyncMock.mockImplementationOnce(() => {
      loginObservedWithoutLock = startupLock.lock.mock.calls.length === 0;
      return { status: 0 };
    });
    const program = new Command();
    registerStartCommandSource(program);

    await program.parseAsync(["start", "--mode", "ama", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    expect(loginObservedWithoutLock).toBe(true);
    expect(fetchSpy.mock.invocationCallOrder[0]).toBeLessThan(spawnSyncMock.mock.invocationCallOrder[0]);
    expect(spawnSyncMock.mock.invocationCallOrder[0]).toBeLessThan(startupLock.lock.mock.invocationCallOrder[0]);
    expect(startupLock.lock.mock.invocationCallOrder[0]).toBeLessThan(spawnMock.mock.invocationCallOrder[0]);
  });

  it("rechecks a live PID inside the lock after an unlocked AMA login", async () => {
    mockMachineRunnerFetch();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "kill").mockImplementation((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) return true;
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const release = vi.fn(async () => {});
    startupLock.lock.mockResolvedValueOnce(release);
    spawnSyncMock.mockImplementationOnce(() => {
      expect(startupLock.lock).not.toHaveBeenCalled();
      writeFileSync(join(testSessionsDir, "daemon.pid"), "7654321");
      return { status: 0 };
    });
    const program = new Command();
    registerStartCommandSource(program);

    await expect(
      program.parseAsync(["start", "--mode", "ama", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" }),
    ).rejects.toThrow("process.exit");

    expect(startupLock.lock).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(readFileSync(join(testSessionsDir, "daemon.pid"), "utf8")).toBe("7654321");
  });

  it.each([
    ["--max-concurrent", "0"],
    ["--max-concurrent", "65"],
    ["--poll-interval", "-1"],
    ["--poll-interval", "1.5"],
    ["--task-timeout", "nope"],
    ["--task-timeout", "604800001"],
  ])("rejects invalid local numeric option %s=%s", async (option, value) => {
    const program = new Command();
    registerStartCommandSource(program);

    await expect(
      program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key", option, value], { from: "user" }),
    ).rejects.toThrow(/must be/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each(["error", "exit"] as const)("does not persist PID/state when the local child reports %s before readiness", async (behavior) => {
    localSpawnBehavior = behavior;
    const program = new Command();
    registerStartCommandSource(program);

    await expect(program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" })).rejects.toThrow(
      behavior === "error" ? "local spawn failed" : "exited before readiness",
    );
    expect(existsSync(join(testSessionsDir, "daemon.pid"))).toBe(false);
    expect(existsSync(join(testSessionsDir, "daemon-state.json"))).toBe(false);
  });

  it("rejects a concurrent start while the first parent owns the starting marker", async () => {
    localSpawnBehavior = "manual";
    const firstProgram = new Command();
    registerStartCommandSource(firstProgram);
    const first = firstProgram.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });
    await vi.waitFor(() => expect(readFileSync(join(testSessionsDir, "daemon.pid"), "utf8")).toBe(`starting:${process.pid}`));

    const secondProgram = new Command();
    registerStartCommandSource(secondProgram);
    await expect(secondProgram.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" })).rejects.toThrow(
      `Runtime already running or starting (PID ${process.pid})`,
    );
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(readFileSync(join(testSessionsDir, "daemon.pid"), "utf8")).toBe(`starting:${process.pid}`);

    lastSpawnChild?.emit("error", new Error("first startup failed"));
    await expect(first).rejects.toThrow("first startup failed");
    expect(existsSync(join(testSessionsDir, "daemon.pid"))).toBe(false);
  });

  it("reclaims a stale starting marker and commits the ready child PID", async () => {
    writeFileSync(join(testSessionsDir, "daemon.pid"), "starting:99999999");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerStartCommandSource(program);

    await program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(readFileSync(join(testSessionsDir, "daemon.pid"), "utf8")).toBe("12345");
  });

  it("rolls back the reservation and closes the log when spawn throws synchronously", async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error("synchronous spawn failure");
    });
    const program = new Command();
    registerStartCommandSource(program);

    await expect(program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" })).rejects.toThrow(
      "synchronous spawn failure",
    );

    expect(existsSync(join(testSessionsDir, "daemon.pid"))).toBe(false);
    expect(existsSync(join(testSessionsDir, "daemon-state.json"))).toBe(false);
    expect(fsHarness.closedFds).toHaveLength(1);
    expect(spawnedChildren).toHaveLength(0);
  });

  it("stops the ready child, closes the log, and preserves a replacement PID when commit loses ownership", async () => {
    localSpawnBehavior = "manual";
    let alive = true;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && !alive) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      if (signal === "SIGTERM") alive = false;
      return true;
    });
    const program = new Command();
    registerStartCommandSource(program);
    const started = program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });
    await vi.waitFor(() => expect(readFileSync(join(testSessionsDir, "daemon.pid"), "utf8")).toBe(`starting:${process.pid}`));
    writeFileSync(join(testSessionsDir, "daemon.pid"), "54321");

    lastSpawnChild?.emit("message", { type: "ready", machineId: "machine_lost_reservation" });

    await expect(started).rejects.toThrow("Lost Machine runner startup reservation");
    expect(readFileSync(join(testSessionsDir, "daemon.pid"), "utf8")).toBe("54321");
    expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(lastSpawnChild?.send).not.toHaveBeenCalled();
    expect(fsHarness.closedFds).toHaveLength(1);
  });

  it("stops the ready child, releases its PID, and closes the log when state persistence fails", async () => {
    localSpawnBehavior = "manual";
    let alive = true;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && !alive) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      if (signal === "SIGTERM") alive = false;
      return true;
    });
    mkdirSync(join(testSessionsDir, "daemon-state.json"));
    const program = new Command();
    registerStartCommandSource(program);
    const started = program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    lastSpawnChild?.emit("message", { type: "ready", machineId: "machine_state_failure" });

    await expect(started).rejects.toThrow();
    expect(existsSync(join(testSessionsDir, "daemon.pid"))).toBe(false);
    expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(lastSpawnChild?.send).not.toHaveBeenCalled();
    expect(fsHarness.closedFds).toHaveLength(1);
  });

  it("persists PID/state and reports success only after the local child sends IPC readiness", async () => {
    localSpawnBehavior = "manual";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerStartCommandSource(program);

    const started = program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    expect(readFileSync(join(testSessionsDir, "daemon.pid"), "utf8")).toBe(`starting:${process.pid}`);
    expect(existsSync(join(testSessionsDir, "daemon-state.json"))).toBe(false);
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("Local machine runner started"));

    lastSpawnChild?.emit("message", { type: "ready", machineId: "machine_after_ready" });
    await started;

    expect(readFileSync(join(testSessionsDir, "daemon.pid"), "utf8")).toBe("12345");
    expect(JSON.parse(readFileSync(join(testSessionsDir, "daemon-state.json"), "utf8"))).toMatchObject({
      machineId: "machine_after_ready",
      runtime: "local-daemon",
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Local machine runner started"));
  });

  it("escalates an unready local child from SIGTERM to SIGKILL and waits for confirmed exit", async () => {
    vi.useFakeTimers();
    localSpawnBehavior = "manual";
    let killed = false;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === "SIGKILL") {
        killed = true;
        return true;
      }
      if (signal === 0 && killed) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      return true;
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerStartCommandSource(program);

    const started = program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });
    const rejected = expect(started).rejects.toThrow("did not become ready within 30s");
    await vi.advanceTimersByTimeAsync(45_000);

    await rejected;
    expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(12345, "SIGKILL");
    expect(existsSync(join(testSessionsDir, "daemon.pid"))).toBe(false);
    expect(existsSync(join(testSessionsDir, "daemon-state.json"))).toBe(false);
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("Local machine runner started"));
  });

  it("preserves AMA onboarding when --mode ama is explicit", async () => {
    const program = new Command();
    registerStartCommandSource(program);
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockMachineRunnerFetch();

    await program.parseAsync(["start", "--mode", "ama", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      testRunnerBin,
      ["auth", "login", "--api-server", "https://runner-control.test"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(spawnMock).toHaveBeenCalledWith(testRunnerBin, expect.arrayContaining(["--project-id", "project_1"]), expect.any(Object));
  });

  it("sanitizes inherited control-plane secrets from AMA login and spawn environments", async () => {
    const controlPlaneKeys = [
      "AK_API_KEY",
      "AMA_TOKEN",
      "AMA_RUNNER_CONFIG",
      "AMA_OIDC_CLIENT_SECRET",
      "OIDC_CLIENT_SECRET",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_API_KEY",
      "CF_API_TOKEN",
      "CF_API_KEY",
    ];
    for (const key of controlPlaneKeys) vi.stubEnv(key, `inherited-${key}`);
    vi.stubEnv("AMA_RUNNER_CREDENTIALS", "inherited-credential-store");
    vi.stubEnv("ANTHROPIC_API_KEY", "provider-credential");
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockMachineRunnerFetch();

    const program = new Command();
    registerStartCommandSource(program);
    await program.parseAsync(["start", "--mode", "ama", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    const loginEnv = spawnSyncMock.mock.calls[0]?.[2]?.env as Record<string, string>;
    const runnerEnv = spawnMock.mock.calls[0]?.[2]?.env as Record<string, string>;
    for (const env of [loginEnv, runnerEnv]) {
      expect(env.ANTHROPIC_API_KEY).toBe("provider-credential");
      expect(env.AMA_RUNNER_CREDENTIALS).toBe(credentialsFilePath);
      expect(env.AMA_RUNNER_CREDENTIALS).not.toBe("inherited-credential-store");
      for (const key of controlPlaneKeys) expect(env).not.toHaveProperty(key);
    }
  });

  it("starts the Machine runner, pointing it at the AMA origin and project/environment to join (runner self-authenticates)", async () => {
    const program = new Command();
    registerStartCommand(program);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://ak.test/api/machines") {
        const body = JSON.parse(String(init?.body)) as Record<string, any>;
        expect(body.runtimes).toEqual([{ name: "codex", status: "ready", checked_at: expect.any(String) }]);
        return new Response(
          JSON.stringify({
            id: "machine_1",
            name: "test-machine",
            runner: {
              origin: "https://runner-control.test",
              projectId: "project_1",
              environmentId: "env_1",
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ak.test/api/machines",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer ak_test_key" }),
      }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Device login (spawnSync) must run BEFORE the detached run-mode spawn
    expect(spawnSyncMock).toHaveBeenCalledWith(
      testRunnerBin,
      ["auth", "login", "--api-server", "https://runner-control.test"],
      expect.objectContaining({
        stdio: "inherit",
        env: expect.objectContaining({
          AMA_RUNNER_CREDENTIALS: credentialsFilePath,
        }),
      }),
    );
    // AMA_TOKEN must NOT be forwarded to the runner
    expect(spawnSyncMock.mock.calls[0]?.[2]?.env).not.toHaveProperty("AMA_TOKEN");

    expect(spawnMock).toHaveBeenCalledWith(
      testRunnerBin,
      [
        "--api-server",
        "https://runner-control.test",
        "--project-id",
        "project_1",
        "--environment-id",
        "env_1",
        "--max-concurrent",
        "5",
        "--allow-unsafe-process",
      ],
      expect.objectContaining({ detached: true, windowsHide: true }),
    );

    // Verify invocation order: device login first, then run-mode detached spawn
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // AK itself does not synchronously write a login file — the runner writes it during the login flow
    expect(existsSync(credentialsFilePath)).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Machine runner started"));
    const state = JSON.parse(readFileSync(join(testSessionsDir, "daemon-state.json"), "utf-8"));
    expect(state).toMatchObject({ runtime: "ama-runner", apiUrl: "https://ak.test", providers: ["codex"] });
    expect(state.runnerVersion).toMatchObject({ version: "0.1.0", commit: "test-commit" });
  });

  it("does not pass onboarding runner id before AMA registration", async () => {
    const program = new Command();
    registerStartCommand(program);
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockMachineRunnerFetch("https://ama.test");

    await program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      testRunnerBin,
      ["auth", "login", "--api-server", "https://ama.test"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(spawnMock).toHaveBeenCalledWith(
      testRunnerBin,
      [
        "--api-server",
        "https://ama.test",
        "--project-id",
        "project_1",
        "--environment-id",
        "env_1",
        "--max-concurrent",
        "5",
        "--allow-unsafe-process",
      ],
      expect.objectContaining({ detached: true }),
    );
  });

  it("skips device login when a valid saved login exists for the origin", async () => {
    writeCredentialStore({
      apiServer: "https://runner-control.test",
      refreshToken: "r",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const program = new Command();
    registerStartCommand(program);
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockMachineRunnerFetch("https://runner-control.test");

    await program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(
      testRunnerBin,
      expect.arrayContaining(["--api-server", "https://runner-control.test"]),
      expect.objectContaining({ detached: true }),
    );
  });

  it("migrates a legacy saved login before starting the runner", async () => {
    writeFileSync(
      legacyLoginFilePath,
      JSON.stringify({
        apiServer: "https://runner-control.test",
        accessToken: "legacy-access-token",
        refreshToken: "legacy-refresh-token",
        tokenType: "Bearer",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scope: "openid profile email offline_access",
      }),
    );
    const program = new Command();
    registerStartCommand(program);
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockMachineRunnerFetch("https://runner-control.test");

    await program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    expect(spawnSyncMock).not.toHaveBeenCalled();
    const credentials = JSON.parse(readFileSync(credentialsFilePath, "utf-8"));
    expect(credentials).toMatchObject({
      active: "https://runner-control.test#legacy",
      profiles: [expect.objectContaining({ apiServer: "https://runner-control.test", accountId: "legacy", refreshToken: "legacy-refresh-token" })],
    });
  });

  it("re-runs device login when the saved login targets a different origin", async () => {
    writeCredentialStore({
      apiServer: "https://other-origin.test",
      refreshToken: "r",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const program = new Command();
    registerStartCommand(program);
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockMachineRunnerFetch("https://runner-control.test");

    await program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      testRunnerBin,
      ["auth", "login", "--api-server", "https://runner-control.test"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("re-runs device login when the saved access token is expired and has no refresh token", async () => {
    writeCredentialStore({
      apiServer: "https://runner-control.test",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const program = new Command();
    registerStartCommand(program);
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockMachineRunnerFetch("https://runner-control.test");

    await program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      testRunnerBin,
      ["auth", "login", "--api-server", "https://runner-control.test"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("refreshes a saved runner login before start when the access token is expired but refreshable", async () => {
    writeCredentialStore({
      apiServer: "https://runner-control.test",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const program = new Command();
    registerStartCommand(program);
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockMachineRunnerFetch("https://runner-control.test");

    await program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    expect(spawnSyncMock).toHaveBeenCalledOnce();
    expect(spawnSyncMock).toHaveBeenCalledWith(
      testRunnerBin,
      ["auth", "refresh"],
      expect.objectContaining({
        stdio: "inherit",
        env: expect.objectContaining({
          AMA_RUNNER_CREDENTIALS: credentialsFilePath,
        }),
      }),
    );
    expect(spawnMock).toHaveBeenCalledWith(
      testRunnerBin,
      expect.arrayContaining(["--api-server", "https://runner-control.test"]),
      expect.objectContaining({ detached: true }),
    );
  });

  it("clears a stale refreshable runner login and re-runs device login when refresh fails", async () => {
    writeCredentialStore({
      apiServer: "https://runner-control.test",
      refreshToken: "stale-refresh-token",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    spawnSyncMock.mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 0 });
    const program = new Command();
    registerStartCommand(program);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockMachineRunnerFetch("https://runner-control.test");

    await program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    expect(spawnSyncMock).toHaveBeenNthCalledWith(1, testRunnerBin, ["auth", "refresh"], expect.objectContaining({ stdio: "inherit" }));
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      2,
      testRunnerBin,
      ["auth", "logout", "https://runner-control.test"],
      expect.objectContaining({ stdio: "ignore" }),
    );
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      3,
      testRunnerBin,
      ["auth", "login", "--api-server", "https://runner-control.test"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(spawnMock).toHaveBeenCalledWith(
      testRunnerBin,
      expect.arrayContaining(["--api-server", "https://runner-control.test"]),
      expect.objectContaining({ detached: true }),
    );
  });

  it("starts using only --api-url when credentials are already saved", async () => {
    mkdirSync(testSessionsDir, { recursive: true });
    const host = "ak.test";
    writeFileSync(
      join(testSessionsDir, "config.json"),
      JSON.stringify({ current: host, credentials: { [host]: { "api-url": "https://ak.test", "api-key": "saved_key" } } }),
    );

    vi.spyOn(console, "log").mockImplementation(() => {});
    mockMachineRunnerFetch("https://runner-control.test");

    const program = new Command();
    registerStartCommand(program);
    await program.parseAsync(["start", "--api-url", "https://ak.test"], { from: "user" });

    expect(spawnMock).toHaveBeenCalledWith(
      testRunnerBin,
      expect.arrayContaining(["--api-server", "https://runner-control.test"]),
      expect.objectContaining({ detached: true }),
    );
  });

  it("exits when --api-url only is passed but no credentials are saved", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: any) => {
      throw new Error("process.exit");
    });

    const program = new Command();
    registerStartCommand(program);

    await expect(program.parseAsync(["start", "--api-url", "https://no-creds.test"], { from: "user" })).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("No saved credentials"));
    exitSpy.mockRestore();
  });

  it("exits when no credentials are passed and none are saved", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: any) => {
      throw new Error("process.exit");
    });

    const program = new Command();
    registerStartCommand(program);

    await expect(program.parseAsync(["start"], { from: "user" })).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("API URL and key required"));
    exitSpy.mockRestore();
  });

  it("throws when machine registration returns a non-OK HTTP status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    const program = new Command();
    registerStartCommand(program);

    await expect(program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "bad_key"], { from: "user" })).rejects.toThrow(
      /Machine registration failed with HTTP 401/,
    );

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("throws when machine registration response has no runner onboarding details", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "m1", name: "test", runner: null }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );

    const program = new Command();
    registerStartCommand(program);

    await expect(program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_key"], { from: "user" })).rejects.toThrow(
      /Machine registration did not return runner onboarding details/,
    );

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("clears session dir when starting with a different API URL than previous state", async () => {
    mkdirSync(testSessionsDir, { recursive: true });
    writeFileSync(
      join(testSessionsDir, "daemon-state.json"),
      JSON.stringify({ apiUrl: "https://old-api.test", providers: [], maxConcurrent: 5, startedAt: new Date().toISOString() }),
    );

    vi.spyOn(console, "log").mockImplementation(() => {});
    mockMachineRunnerFetch("https://runner-control.test");

    const program = new Command();
    registerStartCommand(program);
    await program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    const state = JSON.parse(readFileSync(join(testSessionsDir, "daemon-state.json"), "utf-8"));
    expect(state.apiUrl).toBe("https://ak.test");
  });

  it("fails start when device login exits non-zero", async () => {
    spawnSyncMock.mockReturnValue({ status: 1 });
    const program = new Command();
    registerStartCommand(program);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockMachineRunnerFetch("https://runner-control.test");

    await expect(program.parseAsync(["start", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" })).rejects.toThrow(
      /device login did not complete/,
    );

    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("restart runtime command", () => {
  it.each([
    ["--mode", "invalid"],
    ["--max-concurrent", "0"],
    ["--poll-interval", "1.5"],
    ["--task-timeout", "604800001"],
  ])("validates %s=%s before signaling an existing runner", async (option, value) => {
    writeFileSync(join(testSessionsDir, "daemon.pid"), String(process.pid));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const program = new Command();
    registerRestartCommandSource(program);

    await expect(
      program.parseAsync(["restart", "--api-url", "https://ak.test", "--api-key", "ak_test_key", option, value], { from: "user" }),
    ).rejects.toThrow();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["--max-concurrent", "-1"],
    ["--max-concurrent", "1.5"],
    ["--poll-interval", "0"],
    ["--poll-interval", "300001"],
    ["--task-timeout", "oops"],
    ["--task-timeout", "9007199254740992"],
  ])("rejects invalid local numeric option %s=%s", async (option, value) => {
    const program = new Command();
    registerRestartCommandSource(program);

    await expect(
      program.parseAsync(["restart", "--api-url", "https://ak.test", "--api-key", "ak_test_key", option, value], { from: "user" }),
    ).rejects.toThrow(/must be/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("preserves local mode and poll/timeout settings, while allowing overrides", async () => {
    mkdirSync(testSessionsDir, { recursive: true });
    writeFileSync(
      join(testSessionsDir, "daemon-state.json"),
      JSON.stringify({
        runtime: "local-daemon",
        apiUrl: "https://ak.test",
        maxConcurrent: 3,
        pollInterval: 6000,
        taskTimeout: 90000,
        startedAt: new Date().toISOString(),
      }),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockMachineRunnerFetch();

    const preservedProgram = new Command();
    registerRestartCommandSource(preservedProgram);
    await preservedProgram.parseAsync(["restart", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });
    expect(spawnMock).toHaveBeenLastCalledWith(
      process.execPath,
      [process.argv[1], "__daemon", "--max-concurrent", "3", "--poll-interval", "6000", "--task-timeout", "90000"],
      expect.any(Object),
    );

    rmSync(join(testSessionsDir, "daemon.pid"), { force: true });
    spawnMock.mockClear();
    const overrideProgram = new Command();
    registerRestartCommandSource(overrideProgram);
    await overrideProgram.parseAsync(
      ["restart", "--api-url", "https://ak.test", "--api-key", "ak_test_key", "--poll-interval", "5000", "--task-timeout", "0"],
      { from: "user" },
    );
    expect(spawnMock).toHaveBeenLastCalledWith(
      process.execPath,
      [process.argv[1], "__daemon", "--max-concurrent", "3", "--poll-interval", "5000", "--task-timeout", "0"],
      expect.any(Object),
    );
  });

  it("stops a running process before restarting (with poll loop sleep)", async () => {
    // Write PID file pointing at current process so readDaemonPid returns it
    mkdirSync(testSessionsDir, { recursive: true });
    writeFileSync(join(testSessionsDir, "daemon.pid"), String(process.pid));

    // sig=0 call order: readDaemonPid (1), poll iter 1 (2, alive → sleeps), poll iter 2 (3, dead → break), alive check (4, dead)
    let sig0Count = 0;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid: number, sig?: any) => {
      if (sig === 0) {
        sig0Count++;
        if (sig0Count <= 2) return true;
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      return true;
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockMachineRunnerFetch();

    const program = new Command();
    registerRestartCommand(program);
    await program.parseAsync(["restart", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes("Machine runner stopped"))).toBe(true);
    expect(logged.some((line) => line.includes("Machine runner started"))).toBe(true);
    killSpy.mockRestore();
  });

  it("force-kills process before restarting when it does not stop within deadline", async () => {
    mkdirSync(testSessionsDir, { recursive: true });
    writeFileSync(join(testSessionsDir, "daemon.pid"), String(process.pid));

    // sig=0 call order with Date.now mock (nowCount > 2 = past deadline):
    // restart readDaemonPid: sig0Count=1 alive. nowCount=1: deadline setup.
    // nowCount=2: while check (startTime < deadline → enter loop).
    // In loop: kill(0) sig0Count=2 alive → sleep(200). nowCount=3: while check (past deadline → exit).
    // Alive check: kill(0) sig0Count=3 alive → force-kill (SIGKILL).
    // startAmaRunner readDaemonPid: kill(0) sig0Count=4 → throw (no PID found → startAmaRunner proceeds).
    let sig0Count = 0;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid: number, sig?: any) => {
      if (sig === 0) {
        sig0Count++;
        if (sig0Count <= 3) return true;
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      return true;
    });

    let nowCallCount = 0;
    const startTime = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => {
      nowCallCount++;
      return nowCallCount > 2 ? startTime + 11_000 : startTime;
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockMachineRunnerFetch();

    const program = new Command();
    registerRestartCommand(program);
    await program.parseAsync(["restart", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes("force-killed"))).toBe(true);
    expect(logged.some((line) => line.includes("Machine runner started"))).toBe(true);
    killSpy.mockRestore();
  });

  it("restarts the Machine runner with the original AK credentials flow", async () => {
    const program = new Command();
    registerRestartCommand(program);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockMachineRunnerFetch();

    await program.parseAsync(["restart", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      testRunnerBin,
      ["auth", "login", "--api-server", "https://runner-control.test"],
      expect.objectContaining({
        stdio: "inherit",
        env: expect.objectContaining({
          AMA_RUNNER_CREDENTIALS: credentialsFilePath,
        }),
      }),
    );
    expect(spawnSyncMock.mock.calls[0]?.[2]?.env).not.toHaveProperty("AMA_TOKEN");

    expect(spawnMock).toHaveBeenCalledWith(
      testRunnerBin,
      [
        "--api-server",
        "https://runner-control.test",
        "--project-id",
        "project_1",
        "--environment-id",
        "env_1",
        "--max-concurrent",
        "5",
        "--allow-unsafe-process",
      ],
      expect.objectContaining({ detached: true }),
    );
    expect(logSpy).toHaveBeenCalledWith("○ Machine runner was not running");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Machine runner started"));
    const state = JSON.parse(readFileSync(join(testSessionsDir, "daemon-state.json"), "utf-8"));
    expect(state).toMatchObject({ runtime: "ama-runner", apiUrl: "https://ak.test" });
  });
});

describe("status command — ama-runner with machineId", () => {
  function writeDaemonState(state: Record<string, unknown>) {
    mkdirSync(testSessionsDir, { recursive: true });
    writeFileSync(join(testSessionsDir, "daemon-state.json"), JSON.stringify(state));
  }

  function writePidFile(pid: number) {
    mkdirSync(testSessionsDir, { recursive: true });
    writeFileSync(join(testSessionsDir, "daemon.pid"), String(pid));
  }

  function writeConfig(apiUrl: string, apiKey: string) {
    mkdirSync(testSessionsDir, { recursive: true });
    const host = new URL(apiUrl).host;
    writeFileSync(
      join(testSessionsDir, "config.json"),
      JSON.stringify({ current: host, credentials: { [host]: { "api-url": apiUrl, "api-key": apiKey } } }),
    );
  }

  it("prints AMA runner online status and ready runtimes when getMachine resolves", async () => {
    const machineId = "machine-status-test";
    writePidFile(process.pid);
    writeDaemonState({
      runtime: "ama-runner",
      machineId,
      providers: ["machine-runner"],
      maxConcurrent: 5,
      pollInterval: 0,
      taskTimeout: 0,
      apiUrl: "https://ak.test",
      startedAt: new Date().toISOString(),
    });
    writeConfig("https://ak.test", "ak_test_key");

    const lastHeartbeat = new Date().toISOString();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `https://ak.test/api/machines/${machineId}`) {
        return new Response(
          JSON.stringify({
            id: machineId,
            name: "test-machine",
            status: "online",
            last_heartbeat_at: lastHeartbeat,
            runtimes: [
              { name: "claude", status: "ready", checked_at: new Date().toISOString() },
              { name: "codex", status: "ready", checked_at: new Date().toISOString() },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerStatusCommand(program);
    await program.parseAsync(["status"], { from: "user" });

    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes("Runner:") && line.includes("online"))).toBe(true);
    expect(logged.some((line) => line.includes("Runtimes") && line.includes("claude") && line.includes("codex"))).toBe(true);
  });

  it("prints only ready runtimes, omitting non-ready ones", async () => {
    const machineId = "machine-partial-ready";
    writePidFile(process.pid);
    writeDaemonState({
      runtime: "ama-runner",
      machineId,
      providers: ["machine-runner"],
      maxConcurrent: 5,
      pollInterval: 0,
      taskTimeout: 0,
      apiUrl: "https://ak.test",
      startedAt: new Date().toISOString(),
    });
    writeConfig("https://ak.test", "ak_test_key");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      return new Response(
        JSON.stringify({
          id: machineId,
          name: "test-machine",
          status: "online",
          last_heartbeat_at: new Date().toISOString(),
          runtimes: [
            { name: "claude", status: "ready", checked_at: new Date().toISOString() },
            { name: "codex", status: "unavailable", checked_at: new Date().toISOString() },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerStatusCommand(program);
    await program.parseAsync(["status"], { from: "user" });

    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    const runtimesLine = logged.find((line) => line.includes("Runtimes"));
    expect(runtimesLine).toBeDefined();
    expect(runtimesLine).toContain("claude");
    expect(runtimesLine).not.toContain("codex");
  });

  it("prints error message when getMachine API call fails", async () => {
    const machineId = "machine-err";
    writePidFile(process.pid);
    writeDaemonState({
      runtime: "ama-runner",
      machineId,
      providers: ["machine-runner"],
      maxConcurrent: 5,
      pollInterval: 0,
      taskTimeout: 0,
      apiUrl: "https://ak.test",
      startedAt: new Date().toISOString(),
    });
    writeConfig("https://ak.test", "ak_test_key");

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerStatusCommand(program);
    await program.parseAsync(["status"], { from: "user" });

    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes("Runner:") && line.includes("could not reach AK API"))).toBe(true);
  });

  it("does not print AMA runner line when state has no machineId", async () => {
    writePidFile(process.pid);
    writeDaemonState({
      runtime: "ama-runner",
      // no machineId
      providers: ["machine-runner"],
      maxConcurrent: 5,
      pollInterval: 0,
      taskTimeout: 0,
      apiUrl: "https://ak.test",
      startedAt: new Date().toISOString(),
    });
    writeConfig("https://ak.test", "ak_test_key");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not be called"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerStatusCommand(program);
    await program.parseAsync(["status"], { from: "user" });

    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes("AMA runner"))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("prints not running when status has no PID file", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerStatusCommand(program);
    await program.parseAsync(["status"], { from: "user" });

    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes("not running"))).toBe(true);
  });

  it("falls back to PID file mtime for uptime when state has no startedAt", async () => {
    writePidFile(process.pid);
    // Daemon state without startedAt field
    writeDaemonState({
      runtime: "ama-runner",
      providers: ["codex"],
      maxConcurrent: 5,
      apiUrl: "https://ak.test",
      // no startedAt
    });
    writeConfig("https://ak.test", "ak_test_key");

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no machine id"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerStatusCommand(program);
    await program.parseAsync(["status"], { from: "user" });

    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes("Machine runner running"))).toBe(true);
  });
});

describe("stop command", () => {
  function writePidFile(pid: number) {
    mkdirSync(testSessionsDir, { recursive: true });
    writeFileSync(join(testSessionsDir, "daemon.pid"), String(pid));
  }

  function writeDaemonState(state: Record<string, unknown>) {
    mkdirSync(testSessionsDir, { recursive: true });
    writeFileSync(join(testSessionsDir, "daemon-state.json"), JSON.stringify(state));
  }

  it("prints not running when there is no PID file", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerStopCommand(program);
    await program.parseAsync(["stop"], { from: "user" });

    expect(logSpy).toHaveBeenCalledWith("○ Machine runner is not running");
  });

  it("stops a running process and prints stopped message with uptime", async () => {
    writePidFile(process.pid);
    writeDaemonState({
      providers: ["codex"],
      maxConcurrent: 5,
      apiUrl: "https://ak.test",
      startedAt: new Date(Date.now() - 5000).toISOString(),
    });

    let killCallCount = 0;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid: number, sig?: any) => {
      killCallCount++;
      // First call is SIGTERM; subsequent sig=0 polls should throw (process exited)
      if (sig === 0 && killCallCount > 1) {
        const err = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        throw err;
      }
      return true;
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerStopCommand(program);
    await program.parseAsync(["stop"], { from: "user" });

    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes("Machine runner stopped"))).toBe(true);
    expect(logged.some((line) => line.includes("Uptime"))).toBe(true);
    killSpy.mockRestore();
  });

  it("force-kills the process when it does not die within deadline", async () => {
    writePidFile(process.pid);
    writeDaemonState({
      providers: ["codex"],
      maxConcurrent: 5,
      apiUrl: "https://ak.test",
      startedAt: new Date(Date.now() - 5000).toISOString(),
    });

    // Process ignores SIGTERM, then exits after SIGKILL so termination can be confirmed.
    let forceKilled = false;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid: number, sig?: any) => {
      if (sig === "SIGKILL") forceKilled = true;
      if (sig === 0 && forceKilled) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      return true;
    });

    // Make Date.now() advance past the deadline immediately after the first check
    let nowCallCount = 0;
    const startTime = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => {
      nowCallCount++;
      // After the first few calls (deadline setup), return time past deadline
      return nowCallCount > 2 ? startTime + 11_000 : startTime;
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerStopCommand(program);
    await program.parseAsync(["stop"], { from: "user" });

    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes("force-killed"))).toBe(true);
    killSpy.mockRestore();
  });

  it("stops and waits at least one poll loop iteration before process exits", async () => {
    writePidFile(process.pid);
    // No daemon state — uptime path via PID file mtime

    // Track sig=0 calls separately; kill(0) is used by readDaemonPid, the poll loop, and the alive check.
    // Order: readDaemonPid (sig=0, count=1), SIGTERM (ignored), poll iter 1 (sig=0, count=2 → alive, enters sleep),
    // poll iter 2 (sig=0, count=3 → dead, break), alive check (sig=0, count=4 → dead).
    let sig0Count = 0;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid: number, sig?: any) => {
      if (sig === 0) {
        sig0Count++;
        // First two sig=0 calls return alive; third and beyond throw (dead)
        if (sig0Count <= 2) return true;
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      return true;
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerStopCommand(program);
    await program.parseAsync(["stop"], { from: "user" });

    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes("Machine runner stopped"))).toBe(true);
    killSpy.mockRestore();
  });
});

describe("restart command — additional flows", () => {
  it("restarts using only --api-url when credentials are already saved", async () => {
    // Pre-write credentials for https://ak.test
    mkdirSync(testSessionsDir, { recursive: true });
    const host = "ak.test";
    writeFileSync(
      join(testSessionsDir, "config.json"),
      JSON.stringify({ current: host, credentials: { [host]: { "api-url": "https://ak.test", "api-key": "saved_key" } } }),
    );

    vi.spyOn(console, "log").mockImplementation(() => {});
    mockMachineRunnerFetch();

    const program = new Command();
    registerRestartCommand(program);
    await program.parseAsync(["restart", "--api-url", "https://ak.test"], { from: "user" });

    expect(spawnMock).toHaveBeenCalledWith(
      testRunnerBin,
      expect.arrayContaining(["--api-server", "https://runner-control.test"]),
      expect.objectContaining({ detached: true }),
    );
  });

  it("exits with error when --api-url only is passed but no credentials are saved", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: any) => {
      throw new Error("process.exit");
    });

    const program = new Command();
    registerRestartCommand(program);

    await expect(program.parseAsync(["restart", "--api-url", "https://no-creds.test"], { from: "user" })).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("No saved credentials"));
    exitSpy.mockRestore();
  });
});

describe("restart command — error paths", () => {
  it("clears session dir when restarting with a different API URL", async () => {
    // Write pre-existing daemon state with a different API URL
    mkdirSync(testSessionsDir, { recursive: true });
    writeFileSync(
      join(testSessionsDir, "daemon-state.json"),
      JSON.stringify({ apiUrl: "https://old-api.test", providers: [], maxConcurrent: 5, startedAt: new Date().toISOString() }),
    );
    // Write a sessions subdirectory to verify it gets cleared
    const sessionsSubdir = join(testSessionsDir, "sessions");
    mkdirSync(sessionsSubdir, { recursive: true });
    writeFileSync(join(sessionsSubdir, "old-session.json"), "{}");

    vi.spyOn(console, "log").mockImplementation(() => {});
    mockMachineRunnerFetch();

    const program = new Command();
    registerRestartCommand(program);
    await program.parseAsync(["restart", "--api-url", "https://ak.test", "--api-key", "ak_test_key"], { from: "user" });

    // The state file should now reflect the new API URL (session dir may be cleared)
    const state = JSON.parse(readFileSync(join(testSessionsDir, "daemon-state.json"), "utf-8"));
    expect(state.apiUrl).toBe("https://ak.test");
  });
});

describe("restart command — error paths", () => {
  it("exits when no credentials are saved and none are passed", async () => {
    // No config.json written — getCredentials() will throw
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: any) => {
      throw new Error("process.exit");
    });

    const program = new Command();
    registerRestartCommand(program);

    await expect(program.parseAsync(["restart"], { from: "user" })).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("API URL and key required"));
    exitSpy.mockRestore();
  });
});

describe("logs command", () => {
  it("prints no logs found when log file does not exist", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerLogsCommand(program);
    await program.parseAsync(["logs"], { from: "user" });

    expect(logSpy).toHaveBeenCalledWith("No daemon logs found");
  });

  it("prints the requested final lines without spawning tail", async () => {
    const logsDir = join(testSessionsDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, "daemon.log"), "first\nsecond\nthird\n");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const program = new Command();
    registerLogsCommand(program);
    await program.parseAsync(["logs", "--lines", "2"], { from: "user" });

    expect(stdoutSpy).toHaveBeenCalledWith("second\nthird\n");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("prints initial lines and starts the native follower immediately in follow mode", async () => {
    const logsDir = join(testSessionsDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, "daemon.log");
    writeFileSync(logFile, "first\nsecond\n");
    let pollCallback: (() => void) | undefined;
    vi.spyOn(globalThis, "setInterval").mockImplementation((callback: any) => {
      pollCallback = callback;
      return 1 as any;
    });
    vi.spyOn(process, "on").mockImplementation(() => process);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const program = new Command();
    registerLogsCommand(program);
    await program.parseAsync(["logs", "--follow", "--lines", "1"], { from: "user" });

    expect(stdoutSpy).toHaveBeenCalledWith("second\n");
    expect(pollCallback).toBeTypeOf("function");
    expect(spawnMock).not.toHaveBeenCalled();

    writeFileSync(logFile, "first\nsecond\nthird\n");
    pollCallback?.();
    expect(stdoutSpy).toHaveBeenCalledWith(Buffer.from("third\n"));
  });

  it("reads final lines natively with CRLF and without a trailing newline", () => {
    const logsDir = join(testSessionsDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, "daemon.log");
    writeFileSync(logFile, "first\r\nsecond\r\nthird");

    expect(readLastLogLines(logFile, 2)).toBe("second\r\nthird");
    expect(readLastLogLines(logFile, 0)).toBe("");
    expect(() => readLastLogLines(logFile, -1)).toThrow("--lines must be a non-negative integer");
  });

  it("prints a divider and the new file contents after log rotation", async () => {
    const logsDir = join(testSessionsDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, "daemon.log");
    writeFileSync(logFile, "initial content\n");
    let pollCallback: (() => void) | undefined;
    vi.spyOn(globalThis, "setInterval").mockImplementation((callback: any) => {
      pollCallback = callback;
      return 1 as any;
    });
    vi.spyOn(process, "on").mockImplementation(() => process);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const program = new Command();
    registerLogsCommand(program);
    await program.parseAsync(["logs", "--follow"], { from: "user" });

    expect(pollCallback).toBeTypeOf("function");
    renameSync(logFile, `${logFile}.1`);
    writeFileSync(logFile, "new content after rotation\n");
    pollCallback?.();

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("daemon restarted"));
    expect(stdoutSpy).toHaveBeenCalledWith(Buffer.from("new content after rotation\n"));
  });

  it("recovers when the log disappears before follower initialization", async () => {
    const logsDir = join(testSessionsDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, "daemon.log");
    writeFileSync(logFile, "initial\n");
    let pollCallback: (() => void) | undefined;
    vi.spyOn(globalThis, "setInterval").mockImplementation((callback: any) => {
      pollCallback = callback;
      return 1 as any;
    });
    vi.spyOn(process, "on").mockImplementation(() => process);
    let firstWrite = true;
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      if (firstWrite) {
        firstWrite = false;
        rmSync(logFile);
      }
      return true;
    });

    const program = new Command();
    registerLogsCommand(program);
    await expect(program.parseAsync(["logs", "--follow"], { from: "user" })).resolves.toBeDefined();

    expect(pollCallback).toBeTypeOf("function");
    writeFileSync(logFile, "created after initialization\n");
    expect(() => pollCallback?.()).not.toThrow();
    expect(stdoutSpy).toHaveBeenCalledWith(Buffer.from("created after initialization\n"));
  });

  it("survives a missing file during polling and reads it after recreation", async () => {
    const logsDir = join(testSessionsDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, "daemon.log");
    writeFileSync(logFile, "content\n");
    let pollCallback: (() => void) | undefined;
    vi.spyOn(globalThis, "setInterval").mockImplementation((callback: any) => {
      pollCallback = callback;
      return 1 as any;
    });
    vi.spyOn(process, "on").mockImplementation(() => process);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const program = new Command();
    registerLogsCommand(program);
    await program.parseAsync(["logs", "--follow"], { from: "user" });

    expect(pollCallback).toBeTypeOf("function");
    rmSync(logFile);
    expect(() => pollCallback?.()).not.toThrow();

    writeFileSync(logFile, "recreated\n");
    expect(() => pollCallback?.()).not.toThrow();
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("daemon restarted"));
    expect(stdoutSpy).toHaveBeenCalledWith(Buffer.from("recreated\n"));
  });
});
