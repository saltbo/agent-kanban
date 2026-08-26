// @vitest-environment node
/**
 * Tests for idle exponential backoff in DaemonLoop (loop.ts).
 *
 * Covers:
 *   - idleBackoffMs starts at pollInterval
 *   - Each idle tick multiplies by IDLE_BACKOFF_MULTIPLIER (1.5)
 *   - idleBackoffMs is capped at MAX_IDLE_BACKOFF_MS (120_000)
 *   - A tick where dispatchTasks returns true resets idleBackoffMs
 *   - A tick where pool count changes (reap/resume) resets idleBackoffMs
 *   - onSlotFreed() resets idleBackoffMs
 *   - resumeRateLimitedSessions() resets idleBackoffMs
 *   - Pool saturation path leaves idleBackoffMs untouched
 *   - nextPollDelay clamps against rate-limit session resumeAfter
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Hoist mocks so factory closures can reference them ---------------------

const { resumeOneSessionMock, dispatchTasksMock } = vi.hoisted(() => ({
  resumeOneSessionMock: vi.fn().mockResolvedValue(undefined),
  dispatchTasksMock: vi.fn().mockResolvedValue(false),
}));

vi.mock("../packages/cli/src/daemon/resumer.js", () => ({
  resumeOneSession: resumeOneSessionMock,
}));

vi.mock("../packages/cli/src/daemon/dispatcher.js", () => ({
  dispatchTasks: dispatchTasksMock,
}));

vi.mock("../packages/cli/src/paths.js", () => {
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const base = join(tmpdir(), `ak-test-idle-backoff-${process.pid}`);
  return {
    STATE_DIR: base,
    CONFIG_DIR: base,
    DATA_DIR: base,
    LOGS_DIR: join(base, "logs"),
    CONFIG_FILE: join(base, "config.json"),
    PID_FILE: join(base, "daemon.pid"),
    DAEMON_STATE_FILE: join(base, "daemon-state.json"),
    REPOS_DIR: join(base, "repos"),
    WORKTREES_DIR: join(base, "worktrees"),
    SESSIONS_DIR: join(base, "sessions"),
    TRACKED_TASKS_FILE: join(base, "tracked-tasks.json"),
    IDENTITIES_DIR: join(base, "identities"),
    LEGACY_SAVED_SESSIONS_FILE: join(base, "saved-sessions.json"),
    LEGACY_SESSION_PIDS_FILE: join(base, "session-pids.json"),
  };
});

vi.mock("../packages/cli/src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  }),
}));

// ---- Imports after mocks ----------------------------------------------------

import { DaemonLoop } from "../packages/cli/src/daemon/loop.js";
import type { SessionFile } from "../packages/cli/src/session/types.js";

// ---- Constants mirrored from loop.ts ----------------------------------------

const IDLE_BACKOFF_MULTIPLIER = 1.5;
const MAX_IDLE_BACKOFF_MS = 120_000;
const POLL_INTERVAL = 10_000;

// ---- Minimal fakes ----------------------------------------------------------

function makeRateLimitedSession(resumeAfter?: number): SessionFile {
  return {
    type: "worker",
    agentId: "agent-1",
    sessionId: "session-aaaaaaaa-0000-0000-0000-000000000001",
    runtime: "claude" as any,
    startedAt: Date.now(),
    apiUrl: "http://localhost",
    privateKeyJwk: {} as any,
    taskId: "task-1",
    status: "rate_limited",
    resumeAfter,
  };
}

function makePool(
  overrides: Partial<{
    activeCount: number;
    activeCountForRuntime: (runtime: string) => number;
    hasTask: (id: string) => boolean;
    getActiveTaskIds: () => string[];
  }> = {},
) {
  return {
    activeCount: overrides.activeCount ?? 0,
    activeCountForRuntime: overrides.activeCountForRuntime ?? ((_runtime: string) => overrides.activeCount ?? 0),
    hasTask: overrides.hasTask ?? ((_id: string) => false),
    getActiveTaskIds: overrides.getActiveTaskIds ?? (() => []),
    killTask: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeSessionManager(sessions: SessionFile[] = []) {
  return {
    list: (filter: { type: string; status: string }) => sessions.filter((s) => s.type === filter.type && s.status === filter.status),
    patch: vi.fn().mockResolvedValue(undefined),
    applyEvent: vi.fn().mockResolvedValue(undefined),
  };
}

function makeLoop(
  opts: {
    sessions?: SessionFile[];
    poolOverrides?: Partial<{
      activeCount: number;
      activeCountForRuntime: (runtime: string) => number;
      hasTask: (id: string) => boolean;
      getActiveTaskIds: () => string[];
    }>;
    maxConcurrent?: number;
    pollInterval?: number;
  } = {},
) {
  const pool = makePool(opts.poolOverrides ?? {});
  const sessionManager = makeSessionManager(opts.sessions ?? []);

  const loop = new DaemonLoop(
    {} as any, // client — unused in backoff tests
    pool,
    {} as any, // rateLimiter
    {} as any, // prMonitor
    {
      maxConcurrent: opts.maxConcurrent ?? 4,
      pollInterval: opts.pollInterval ?? POLL_INTERVAL,
    },
  );

  (loop as any).sessions = sessionManager;
  (loop as any).running = true;

  return { loop, pool, sessionManager };
}

// Helper: read private idleBackoffMs
function getIdleBackoff(loop: DaemonLoop): number {
  return (loop as any).idleBackoffMs;
}

// Helper: invoke tick without scheduling (suppress the timer)
async function runTick(loop: DaemonLoop) {
  // Stub schedulePoll so it never fires a real setTimeout
  (loop as any).schedulePoll = vi.fn();
  await (loop as any).tick();
}

// ---- Tests ------------------------------------------------------------------

describe("DaemonLoop idle exponential backoff", () => {
  beforeEach(() => {
    resumeOneSessionMock.mockClear();
    dispatchTasksMock.mockClear();
    // Default: dispatchTasks does no work
    dispatchTasksMock.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --- initial state ---

  it("idleBackoffMs starts at pollInterval", () => {
    const { loop } = makeLoop({ pollInterval: POLL_INTERVAL });
    expect(getIdleBackoff(loop)).toBe(POLL_INTERVAL);
  });

  // --- single idle tick ---

  it("one idle tick increases idleBackoffMs by IDLE_BACKOFF_MULTIPLIER", async () => {
    const { loop } = makeLoop({ pollInterval: POLL_INTERVAL });

    await runTick(loop);

    expect(getIdleBackoff(loop)).toBe(POLL_INTERVAL * IDLE_BACKOFF_MULTIPLIER);
  });

  // --- two idle ticks ---

  it("two idle ticks apply the multiplier twice (compounding)", async () => {
    const { loop } = makeLoop({ pollInterval: POLL_INTERVAL });

    await runTick(loop);
    await runTick(loop);

    expect(getIdleBackoff(loop)).toBeCloseTo(POLL_INTERVAL * IDLE_BACKOFF_MULTIPLIER * IDLE_BACKOFF_MULTIPLIER, 5);
  });

  // --- ceiling ---

  it("idleBackoffMs does not exceed MAX_IDLE_BACKOFF_MS regardless of how many idle ticks occur", async () => {
    const { loop } = makeLoop({ pollInterval: POLL_INTERVAL });

    // Run enough ticks to overflow the cap
    for (let i = 0; i < 30; i++) {
      await runTick(loop);
    }

    expect(getIdleBackoff(loop)).toBe(MAX_IDLE_BACKOFF_MS);
  });

  it("idleBackoffMs reaches the ceiling at exactly MAX_IDLE_BACKOFF_MS, not higher", async () => {
    const { loop } = makeLoop({ pollInterval: POLL_INTERVAL });

    // Force idleBackoffMs just below the cap
    (loop as any).idleBackoffMs = MAX_IDLE_BACKOFF_MS / IDLE_BACKOFF_MULTIPLIER + 1;
    await runTick(loop);

    expect(getIdleBackoff(loop)).toBe(MAX_IDLE_BACKOFF_MS);
  });

  // --- reset on dispatch ---

  it("a tick where dispatchTasks returns true resets idleBackoffMs to pollInterval", async () => {
    const { loop } = makeLoop({ pollInterval: POLL_INTERVAL });

    // Prime with an idle tick to move past base
    await runTick(loop);
    expect(getIdleBackoff(loop)).toBeGreaterThan(POLL_INTERVAL);

    // Now a tick that dispatches work
    dispatchTasksMock.mockResolvedValueOnce(true);
    await runTick(loop);

    expect(getIdleBackoff(loop)).toBe(POLL_INTERVAL);
  });

  // --- reset when pool count changes (reap/resume) ---

  it("a tick where pool.activeCount changes (reap) resets idleBackoffMs even if dispatch returns false", async () => {
    // Pool whose activeCount increases during the tick (simulating reap)
    let callCount = 0;
    const pool = {
      // First read (activeBefore) returns 0; subsequent reads return 1
      get activeCount() {
        return callCount++ === 0 ? 0 : 1;
      },
      hasTask: () => false,
      getActiveTaskIds: () => [],
      killTask: vi.fn().mockResolvedValue(undefined),
    } as any;

    const sessionManager = makeSessionManager([]);
    const loop = new DaemonLoop({} as any, pool, {} as any, {} as any, {
      maxConcurrent: 4,
      pollInterval: POLL_INTERVAL,
    });
    (loop as any).sessions = sessionManager;
    (loop as any).running = true;

    // Prime with an idle tick to move past base
    (loop as any).schedulePoll = vi.fn();
    // Manually bump so we can see the reset
    (loop as any).idleBackoffMs = POLL_INTERVAL * 2;

    await runTick(loop);

    // reapedOrResumed=true → resetIdleBackoff()
    expect(getIdleBackoff(loop)).toBe(POLL_INTERVAL);
  });

  // --- onSlotFreed resets backoff ---

  it("onSlotFreed resets idleBackoffMs to pollInterval", () => {
    const { loop } = makeLoop({ pollInterval: POLL_INTERVAL });

    // Manually inflate
    (loop as any).idleBackoffMs = MAX_IDLE_BACKOFF_MS;
    // Stub schedulePoll to avoid real timer
    (loop as any).schedulePoll = vi.fn();

    loop.onSlotFreed();

    expect(getIdleBackoff(loop)).toBe(POLL_INTERVAL);
  });

  // --- resumeRateLimitedSessions resets backoff ---

  it("resumeRateLimitedSessions resets idleBackoffMs to pollInterval", async () => {
    const session = makeRateLimitedSession(undefined); // no future resumeAfter
    const { loop } = makeLoop({ sessions: [session] });

    // Inflate backoff
    (loop as any).idleBackoffMs = MAX_IDLE_BACKOFF_MS;
    // Stub schedulePoll
    (loop as any).schedulePoll = vi.fn();

    await loop.resumeRateLimitedSessions("claude");

    expect(getIdleBackoff(loop)).toBe(POLL_INTERVAL);
  });

  it("resumeRateLimitedSessions resets idleBackoffMs even when no session matches", async () => {
    const { loop } = makeLoop({ sessions: [] });

    (loop as any).idleBackoffMs = MAX_IDLE_BACKOFF_MS;
    (loop as any).schedulePoll = vi.fn();

    await loop.resumeRateLimitedSessions("claude");

    expect(getIdleBackoff(loop)).toBe(POLL_INTERVAL);
  });

  // --- global pool saturation does not block per-runtime dispatch ---

  it("when global pool is saturated, idleBackoffMs still advances if no runtime dispatches", async () => {
    const { loop } = makeLoop({
      poolOverrides: { activeCount: 4 },
      maxConcurrent: 4,
      pollInterval: POLL_INTERVAL,
    });

    const inflated = POLL_INTERVAL * 3;
    (loop as any).idleBackoffMs = inflated;
    (loop as any).schedulePoll = vi.fn();

    await (loop as any).tick();

    expect(getIdleBackoff(loop)).toBe(Math.min(inflated * 1.5, MAX_IDLE_BACKOFF_MS));
  });

  it("when global pool is saturated, dispatchTasks still decides per-runtime capacity", async () => {
    const { loop } = makeLoop({
      poolOverrides: { activeCount: 4 },
      maxConcurrent: 4,
    });

    (loop as any).schedulePoll = vi.fn();
    await (loop as any).tick();

    expect(dispatchTasksMock).toHaveBeenCalledOnce();
  });

  // --- nextPollDelay clamps against rate-limit resume time ---

  it("nextPollDelay returns the rate-limit session resumeAfter when it is shorter than idleBackoffMs", () => {
    const resumeAfter = Date.now() + 5_000; // 5 s from now
    const session = makeRateLimitedSession(resumeAfter);
    const { loop } = makeLoop({ sessions: [session] });

    // Set a large idle backoff (60 s)
    (loop as any).idleBackoffMs = 60_000;

    const delay = (loop as any).nextPollDelay();

    // Should be ~5000 ms, clamped to at least 1000 ms
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(5_500); // small tolerance for elapsed time
  });

  it("nextPollDelay returns idleBackoffMs when no rate-limit session is present", () => {
    const { loop } = makeLoop({ sessions: [] });

    (loop as any).idleBackoffMs = 30_000;

    const delay = (loop as any).nextPollDelay();

    expect(delay).toBe(30_000);
  });

  it("nextPollDelay returns idleBackoffMs when it is shorter than rate-limit resume time", () => {
    const resumeAfter = Date.now() + 90_000; // 90 s — longer than idle backoff
    const session = makeRateLimitedSession(resumeAfter);
    const { loop } = makeLoop({ sessions: [session] });

    (loop as any).idleBackoffMs = 30_000;

    const delay = (loop as any).nextPollDelay();

    expect(delay).toBe(30_000);
  });

  it("nextPollDelay ignores rate-limited sessions whose resumeAfter is in the past", () => {
    const resumeAfter = Date.now() - 5_000; // expired
    const session = makeRateLimitedSession(resumeAfter);
    const { loop } = makeLoop({ sessions: [session] });

    (loop as any).idleBackoffMs = 20_000;

    const delay = (loop as any).nextPollDelay();

    // Past resumeAfter is skipped → falls back to idleBackoffMs
    expect(delay).toBe(20_000);
  });
});
