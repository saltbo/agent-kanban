// @vitest-environment node

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testPaths = vi.hoisted(() => {
  const { join } = require("node:path") as typeof import("node:path");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  return { root: join(tmpdir(), `ak-daemon-heartbeat-${process.pid}`) };
});

const mocks = vi.hoisted(() => ({
  heartbeat: vi.fn(),
  registerMachine: vi.fn(),
  getProvider: vi.fn(),
  getHistory: vi.fn(),
  sendHistory: vi.fn(),
  warn: vi.fn(),
  prMonitorStart: vi.fn(),
  loopStart: vi.fn(),
  setRuntimeSettings: vi.fn(),
  setSchedulingSettings: vi.fn(),
  startSkillCacheRefresh: vi.fn(),
  stopSkillCacheRefresh: vi.fn(),
  cleanupUntrackedWorktrees: vi.fn(),
  session: null as null | { runtime: string; providerResumeToken?: string },
  historyHandler: null as null | ((sessionId: string, requestId: string) => void),
  capturedRateLimitSink: null as null | {
    onRateLimited: (runtime: string, resetAt: string) => void | Promise<void>;
    onRateLimitResumed: (runtime: string) => void;
  },
  availability: null as null | Record<string, { status: "ready" | "unauthorized"; detail?: string }>,
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn().mockReturnValue("test-machine\n"),
  execSync: vi.fn(),
}));

vi.mock("../src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/paths.js")>();
  const { join } = await import("node:path");
  return { ...actual, STATE_DIR: testPaths.root, PID_FILE: join(testPaths.root, "daemon.pid") };
});

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../src/client/index.js", () => ({
  MachineClient: vi.fn().mockImplementation(() => ({
    registerMachine: mocks.registerMachine,
    heartbeat: mocks.heartbeat,
  })),
}));

vi.mock("../src/config.js", () => ({
  getCredentials: () => ({ apiUrl: "https://example.test", apiKey: "ak_test" }),
}));

vi.mock("../src/providers/runtimeSettingsState.js", () => ({ setRuntimeSettings: mocks.setRuntimeSettings }));
vi.mock("../src/providers/schedulingState.js", () => ({ setSchedulingSettings: mocks.setSchedulingSettings }));
vi.mock("../src/workspace/skills.js", () => ({ startSkillCacheRefresh: mocks.startSkillCacheRefresh }));

vi.mock("../src/device.js", () => ({
  generateDeviceId: () => "device-test",
}));

vi.mock("../src/version.js", () => ({
  getVersion: () => "1.2.3",
}));

vi.mock("../src/providers/registry.js", () => ({
  getAvailableProviders: () => [
    {
      name: "claude",
      label: "Claude",
      checkAvailability: async () => mocks.availability?.claude ?? { status: "ready" },
      execute: vi.fn(),
      getHistory: vi.fn().mockResolvedValue([]),
    },
    {
      name: "codex",
      label: "Codex",
      checkAvailability: async () => mocks.availability?.codex ?? { status: "ready" },
      execute: vi.fn(),
      getHistory: vi.fn().mockResolvedValue([]),
    },
  ],
  getProvider: mocks.getProvider,
}));

vi.mock("../src/session/manager.js", () => ({
  getSessionManager: () => ({ read: vi.fn(() => mocks.session) }),
}));

vi.mock("../src/session/store.js", () => ({
  migrateLegacySessions: vi.fn(),
}));

vi.mock("../src/daemon/cleanup.js", () => ({
  auditOrphanedTasks: vi.fn().mockResolvedValue(undefined),
  cleanupLeaderSessions: vi.fn().mockResolvedValue(undefined),
  cleanupStaleSessions: vi.fn().mockResolvedValue(undefined),
  cleanupUntrackedWorktrees: mocks.cleanupUntrackedWorktrees,
}));

vi.mock("../src/daemon/loop.js", () => ({
  DaemonLoop: vi.fn().mockImplementation(() => ({
    start: mocks.loopStart,
    stop: vi.fn(),
    onSlotFreed: vi.fn(),
    resumeRateLimitedSessions: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../src/daemon/prMonitor.js", () => ({
  PrMonitor: vi.fn().mockImplementation(() => ({ start: mocks.prMonitorStart, stop: vi.fn(), track: vi.fn() })),
}));

vi.mock("../src/daemon/runtimePool.js", () => ({
  RuntimePool: vi.fn().mockImplementation((_client, _callbacks, rateLimitSink) => {
    mocks.capturedRateLimitSink = rateLimitSink;
    return { killAll: vi.fn().mockResolvedValue(undefined), sendToSession: vi.fn().mockResolvedValue(false) };
  }),
}));

vi.mock("../src/daemon/tunnel.js", () => ({
  TunnelClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    onHistoryRequest: vi.fn((handler) => {
      mocks.historyHandler = handler;
    }),
    onHumanMessage: vi.fn(),
    sendHistory: mocks.sendHistory,
  })),
}));

vi.mock("../src/daemon/usageCollector.js", () => ({
  UsageCollector: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn(), getSnapshot: vi.fn().mockReturnValue(null) })),
}));

import { startDaemon } from "../src/daemon/index.js";

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("daemon heartbeat runtime states", () => {
  let listeners: Partial<Record<NodeJS.Signals | "unhandledRejection", Array<(...args: never[]) => unknown>>>;

  beforeEach(() => {
    rmSync(testPaths.root, { recursive: true, force: true });
    mkdirSync(testPaths.root, { recursive: true });
    listeners = {
      SIGINT: process.listeners("SIGINT"),
      SIGTERM: process.listeners("SIGTERM"),
      unhandledRejection: process.listeners("unhandledRejection"),
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T10:00:00.000Z"));
    mocks.heartbeat.mockReset();
    mocks.heartbeat.mockResolvedValue({});
    mocks.registerMachine.mockReset();
    mocks.registerMachine.mockResolvedValue({ id: "machine-1" });
    mocks.getHistory.mockReset();
    mocks.getHistory.mockResolvedValue([]);
    mocks.getProvider.mockReset();
    mocks.getProvider.mockReturnValue({ getHistory: mocks.getHistory });
    mocks.sendHistory.mockReset();
    mocks.warn.mockReset();
    mocks.prMonitorStart.mockReset();
    mocks.loopStart.mockReset();
    mocks.setRuntimeSettings.mockReset();
    mocks.setSchedulingSettings.mockReset();
    mocks.startSkillCacheRefresh.mockReset();
    mocks.stopSkillCacheRefresh.mockReset();
    mocks.startSkillCacheRefresh.mockReturnValue(mocks.stopSkillCacheRefresh);
    mocks.cleanupUntrackedWorktrees.mockReset();
    mocks.session = null;
    mocks.historyHandler = null;
    mocks.capturedRateLimitSink = null;
    mocks.availability = null;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    for (const event of ["SIGINT", "SIGTERM", "unhandledRejection"] as const) {
      process.removeAllListeners(event);
      for (const listener of listeners[event] ?? []) process.on(event, listener as any);
    }
    rmSync(testPaths.root, { recursive: true, force: true });
  });

  it("reports IPC readiness only after registration and the initial heartbeat", async () => {
    const onReady = vi.fn();

    await startDaemon({ maxConcurrent: 1, pollInterval: 5000, onReady });

    expect(onReady).toHaveBeenCalledWith("machine-1");
    expect(mocks.registerMachine.mock.invocationCallOrder[0]).toBeLessThan(mocks.heartbeat.mock.invocationCallOrder[0]);
    expect(mocks.heartbeat.mock.invocationCallOrder[0]).toBeLessThan(mocks.prMonitorStart.mock.invocationCallOrder[0]);
    expect(mocks.heartbeat.mock.invocationCallOrder[0]).toBeLessThan(mocks.startSkillCacheRefresh.mock.invocationCallOrder[0]);
    expect(mocks.startSkillCacheRefresh.mock.invocationCallOrder[0]).toBeLessThan(onReady.mock.invocationCallOrder[0]);
    expect(mocks.prMonitorStart.mock.invocationCallOrder[0]).toBeLessThan(mocks.loopStart.mock.invocationCallOrder[0]);
    expect(mocks.loopStart.mock.invocationCallOrder[0]).toBeLessThan(onReady.mock.invocationCallOrder[0]);
  });

  it("applies scheduling and runtime settings from initial and subsequent heartbeats", async () => {
    mocks.heartbeat
      .mockResolvedValueOnce({
        scheduling: { peak_windows: [], timezone: "UTC" },
        runtime_settings: { skill_cache_auto_update: false, skill_cache_refresh_hours: 12 },
      })
      .mockResolvedValueOnce({
        scheduling: { peak_windows: [{ start: "09:00", end: "10:00" }], timezone: "Asia/Shanghai" },
        runtime_settings: { skill_cache_auto_update: true, skill_cache_refresh_hours: 6 },
      });

    await startDaemon({ maxConcurrent: 1, pollInterval: 5000 });
    expect(mocks.setSchedulingSettings).toHaveBeenNthCalledWith(1, { peak_windows: [], timezone: "UTC" });
    expect(mocks.setRuntimeSettings).toHaveBeenNthCalledWith(1, { skill_cache_auto_update: false, skill_cache_refresh_hours: 12 });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.setSchedulingSettings).toHaveBeenNthCalledWith(2, {
      peak_windows: [{ start: "09:00", end: "10:00" }],
      timezone: "Asia/Shanghai",
    });
    expect(mocks.setRuntimeSettings).toHaveBeenNthCalledWith(2, { skill_cache_auto_update: true, skill_cache_refresh_hours: 6 });
  });

  it("starts the skill refresher after initial settings and stops it during shutdown", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await startDaemon({ maxConcurrent: 1, pollInterval: 5000 });

    expect(mocks.startSkillCacheRefresh).toHaveBeenCalledOnce();
    expect(mocks.cleanupUntrackedWorktrees).toHaveBeenCalledOnce();
    expect(mocks.heartbeat.mock.invocationCallOrder[0]).toBeLessThan(mocks.startSkillCacheRefresh.mock.invocationCallOrder[0]);

    const original = new Set(listeners.SIGTERM ?? []);
    const shutdown = process.listeners("SIGTERM").find((listener) => !original.has(listener as any));
    expect(shutdown).toBeDefined();
    await (shutdown as () => Promise<void>)();

    expect(mocks.stopSkillCacheRefresh).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("does not unlink a newer daemon PID when the old daemon shuts down", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await startDaemon({ maxConcurrent: 1, pollInterval: 5000 });
    const pidFile = `${testPaths.root}/daemon.pid`;
    writeFileSync(pidFile, "654321");

    const original = new Set(listeners.SIGTERM ?? []);
    const shutdown = process.listeners("SIGTERM").find((listener) => !original.has(listener as any));
    expect(shutdown).toBeDefined();
    await (shutdown as () => Promise<void>)();

    expect(readFileSync(pidFile, "utf8")).toBe("654321");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it.each([
    ["registration", () => mocks.registerMachine.mockRejectedValueOnce(new Error("registration failed"))],
    ["initial heartbeat", () => mocks.heartbeat.mockRejectedValueOnce(new Error("heartbeat failed"))],
    [
      "PR monitor",
      () =>
        mocks.prMonitorStart.mockImplementationOnce(() => {
          throw new Error("PR monitor failed");
        }),
    ],
    [
      "polling loop",
      () =>
        mocks.loopStart.mockImplementationOnce(() => {
          throw new Error("polling failed");
        }),
    ],
  ])("does not report readiness when %s initialization fails", async (_phase, arrangeFailure) => {
    const onReady = vi.fn();
    arrangeFailure();

    await expect(startDaemon({ maxConcurrent: 1, pollInterval: 5000, onReady })).rejects.toThrow(/failed/);
    expect(onReady).not.toHaveBeenCalled();
  });

  it("reports ready runtimes, then reports a rate-limited runtime with reset_at", async () => {
    await startDaemon({ maxConcurrent: 1, pollInterval: 5000 });

    expect(mocks.registerMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        device_id: "device-test",
        runtimes: [
          { name: "claude", status: "ready", checked_at: "2026-03-21T10:00:00.000Z" },
          { name: "codex", status: "ready", checked_at: "2026-03-21T10:00:00.000Z" },
        ],
      }),
    );
    expect(mocks.heartbeat).toHaveBeenCalledWith("machine-1", {
      version: "1.2.3",
      runtimes: [
        { name: "claude", status: "ready", checked_at: "2026-03-21T10:00:00.000Z" },
        { name: "codex", status: "ready", checked_at: "2026-03-21T10:00:00.000Z" },
      ],
    });

    const resetAt = "2026-03-21T10:30:00.000Z";
    await mocks.capturedRateLimitSink!.onRateLimited("claude", resetAt);

    expect(mocks.heartbeat).toHaveBeenLastCalledWith("machine-1", {
      version: "1.2.3",
      usage_info: null,
      runtimes: [
        {
          name: "claude",
          status: "limited",
          detail: "runtime paused by rate limiter",
          reset_at: resetAt,
          checked_at: "2026-03-21T10:00:00.000Z",
        },
        { name: "codex", status: "ready", checked_at: "2026-03-21T10:00:00.000Z" },
      ],
    });
  });

  it("reports unauthorized runtimes from provider availability checks", async () => {
    mocks.availability = {
      claude: { status: "unauthorized", detail: "Claude Code is not logged in" },
      codex: { status: "ready" },
    };

    await startDaemon({ maxConcurrent: 1, pollInterval: 5000 });

    expect(mocks.registerMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimes: [
          {
            name: "claude",
            status: "unauthorized",
            detail: "Claude Code is not logged in",
            checked_at: "2026-03-21T10:00:00.000Z",
          },
          { name: "codex", status: "ready", checked_at: "2026-03-21T10:00:00.000Z" },
        ],
      }),
    );
  });

  it("rejects history requests for leader-only runtimes before provider lookup", async () => {
    mocks.session = { runtime: "opencode" };
    await startDaemon({ maxConcurrent: 1, pollInterval: 5000 });

    mocks.historyHandler!("leader-session", "request-1");
    await flushMicrotasks();

    expect(mocks.getProvider).not.toHaveBeenCalled();
    expect(mocks.sendHistory).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith('History fetch failed for leader-s: History is unavailable for leader runtime "opencode"');
  });

  it("fetches worker runtime history from its provider", async () => {
    const events = [{ timestamp: 1, event: { type: "message.user", text: "hello" } }];
    mocks.session = { runtime: "codex", providerResumeToken: "resume-1" };
    mocks.getHistory.mockResolvedValue(events);
    await startDaemon({ maxConcurrent: 1, pollInterval: 5000 });

    mocks.historyHandler!("worker-session", "request-2");
    await flushMicrotasks();

    expect(mocks.getProvider).toHaveBeenCalledWith("codex");
    expect(mocks.getHistory).toHaveBeenCalledWith("worker-session", "resume-1");
    expect(mocks.sendHistory).toHaveBeenCalledWith(events, "request-2", "worker-session");
  });
});
