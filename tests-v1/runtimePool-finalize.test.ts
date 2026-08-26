// @vitest-environment node
/**
 * Tests for the finalize() release-task logic in RuntimePool.
 *
 * Changed behavior (runtimePool.ts ~line 416-427):
 *   When nextStatus === "completing", releaseTask is called when:
 *     - opts.crashed is true  (was already the case), OR
 *     - !agent.taskInReview   (NEW: agent finished normally but didn't move task to in_review)
 *
 *   When taskInReview is true and not crashed, releaseTask must NOT be called.
 *
 * finalize() is internal. We drive it through RuntimePool.spawnAgent() which
 * calls runEventLoop() → consumeEvents() → finalize() after the event iterator
 * ends.  We control the outcome by returning specific AgentEvent sequences from
 * a mock provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mock paths to avoid polluting production sessions dir ------------------
vi.mock("../packages/cli/src/paths.js", () => {
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const base = join(tmpdir(), `ak-test-runtimepool-fin-${process.pid}`);
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

// ---- Mock logger (avoid pino noise in test output) -------------------------
vi.mock("../packages/cli/src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  }),
}));

// ---- Mock systemPrompt to avoid writing files ------------------------------
vi.mock("../packages/cli/src/agent/systemPrompt.js", () => ({
  cleanupPromptFile: vi.fn(),
  writeSystemPromptFile: vi.fn().mockResolvedValue(undefined),
}));

import { randomUUID } from "node:crypto";
import type { AgentClient, ApiClient } from "../packages/cli/src/client/index.js";
import { RuntimeCircuitBreaker } from "../packages/cli/src/daemon/runtimeCircuitBreaker.js";
import { RuntimePool } from "../packages/cli/src/daemon/runtimePool.js";
import type { AgentEvent, AgentHandle, AgentProvider } from "../packages/cli/src/providers/types.js";
import { _setSessionManagerForTest, SessionManager } from "../packages/cli/src/session/manager.js";
import { clearAllSessions } from "../packages/cli/src/session/store.js";

// ---- Helpers ----------------------------------------------------------------

/**
 * Build a minimal fake AgentHandle whose `events` async generator yields
 * exactly the provided events then returns.
 */
function makeHandle(events: AgentEvent[] = []): AgentHandle {
  return {
    events: (async function* () {
      for (const ev of events) yield ev;
    })(),
    abort: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Build a mock AgentProvider that immediately resolves with the given handle.
 */
function makeProvider(handle: AgentHandle): AgentProvider {
  return {
    name: "claude" as any,
    label: "Claude Code",
    execute: vi.fn().mockResolvedValue(handle),
  };
}

/**
 * Build a minimal mock ApiClient.  `releaseTask` is a spy so tests can assert
 * whether it was called.
 */
function makeApiClient(overrides: Partial<Record<string, any>> = {}): ApiClient {
  return {
    getTask: vi.fn().mockResolvedValue({ status: "in_progress" }),
    releaseTask: vi.fn().mockResolvedValue({}),
    closeSession: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as ApiClient;
}

/**
 * Build a minimal mock AgentClient. getTask returns the provided task stub.
 */
function makeAgentClient(taskStub: { status?: string } | null = null): AgentClient {
  return {
    getAgentId: vi.fn().mockReturnValue("agent-id"),
    getSessionId: vi.fn().mockReturnValue("session-id"),
    getTask: vi.fn().mockResolvedValue(taskStub),
    updateSessionUsage: vi.fn().mockResolvedValue({}),
    sendMessage: vi.fn().mockResolvedValue({}),
  } as unknown as AgentClient;
}

/**
 * A turn.end event with minimal required fields.
 */
function makeTurnEndEvent(): AgentEvent {
  return {
    type: "turn.end",
    cost: 0.001,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  } as unknown as AgentEvent;
}

/**
 * Seed a worker session in "active" state so the state machine transitions work.
 */
async function seedActiveSession(sessions: SessionManager, sessionId: string, taskId: string): Promise<void> {
  await sessions.create({
    type: "worker",
    agentId: "agent-id",
    sessionId,
    taskId,
    runtime: "claude" as any,
    startedAt: Date.now(),
    apiUrl: "http://localhost",
    privateKeyJwk: {} as JsonWebKey,
    status: "active",
  });
}

/**
 * Spawn an agent and wait for the finalize() phase to complete.
 *
 * Because RuntimePool.spawnAgent() launches the event loop in the background,
 * we wait for `onSlotFreed` (which is called in the finally block of the loop,
 * immediately after finalize() resolves).
 */
async function _spawnAndWait(
  pool: RuntimePool,
  opts: {
    provider: AgentProvider;
    taskId: string;
    sessionId: string;
    agentClient: AgentClient;
  },
): Promise<void> {
  return new Promise<void>((resolve) => {
    // onSlotFreed fires at the end of runEventLoop's finally block
    const callbacks = { onSlotFreed: resolve };
    const poolWithCallback = new RuntimePool(
      pool.client,
      callbacks,
      pool.rateLimitSink,
      0, // taskTimeoutMs = 0 disables the timeout timer
      null,
    );

    poolWithCallback.spawnAgent({
      provider: opts.provider,
      taskId: opts.taskId,
      sessionId: opts.sessionId,
      cwd: "/tmp",
      taskContext: "test task",
      agentClient: opts.agentClient,
      agentEnv: {},
    });
  });
}

// ---- Shared fixtures --------------------------------------------------------

let sessions: SessionManager;
let apiClient: ApiClient;

beforeEach(() => {
  clearAllSessions();
  sessions = new SessionManager();
  _setSessionManagerForTest(sessions);
  apiClient = makeApiClient();
});

afterEach(() => {
  clearAllSessions();
  _setSessionManagerForTest(null);
  vi.restoreAllMocks();
});

// ---- Factory for a pool (callbacks wired to the spy) ------------------------

function _makePool(): RuntimePool {
  const rateLimitSink = { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() };
  return new RuntimePool(
    apiClient,
    { onSlotFreed: vi.fn() },
    rateLimitSink,
    0, // no timeout
    null,
  );
}

// ============================================================================
// Additional event helpers
// ============================================================================

function _makeRateLimitRejectedEvent(resetAt?: string): AgentEvent {
  return {
    type: "turn.rate_limit",
    status: "rejected",
    resetAt: resetAt ?? new Date(Date.now() + 60_000).toISOString(),
    isUsingOverage: false,
  } as AgentEvent;
}

function _makeRateLimitAllowedEvent(): AgentEvent {
  return {
    type: "turn.rate_limit",
    status: "allowed",
    isUsingOverage: false,
  } as AgentEvent;
}

function _makeRateLimitOverageEvent(): AgentEvent {
  return {
    type: "turn.rate_limit",
    status: "allowed",
    isUsingOverage: true,
  } as AgentEvent;
}

function _makeTurnErrorEvent(): AgentEvent {
  return { type: "turn.error", detail: "something went wrong" } as AgentEvent;
}

function _makeMessageEvent(text: string): AgentEvent {
  return { type: "message", blocks: [{ type: "text", text }] } as AgentEvent;
}

function _makeMessageEventNoText(): AgentEvent {
  return { type: "message", blocks: [] } as AgentEvent;
}

function _makeBlockDoneEvent(text: string): AgentEvent {
  return { type: "block.done", block: { type: "text", text } } as AgentEvent;
}

function _makeBlockDoneNonTextEvent(): AgentEvent {
  return { type: "block.done", block: { type: "tool_result" } } as AgentEvent;
}

// ============================================================================
// Test suite
// ============================================================================

describe("RuntimePool finalize() — releaseTask on completing", () => {
  // --------------------------------------------------------------------------
  // Case 1: agent finishes normally and task IS in_review
  //   → nextStatus === "completing" (via iterator_done_with_result, taskInReview=true → in_review,
  //     then cleanup_done → terminal) is NOT reached for in_review, but when
  //     the state machine goes to "completing", taskInReview=true → do NOT release
  // --------------------------------------------------------------------------

  it("does NOT call releaseTask when agent finishes normally with task in_review", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    // turn.end fires; agentClient.getTask returns in_review → agent.taskInReview = true
    const agentClient = makeAgentClient({ status: "in_review" });
    const handle = makeHandle([makeTurnEndEvent()]);
    const provider = makeProvider(handle);

    await new Promise<void>((resolve) => {
      const pool = new RuntimePool(apiClient, { onSlotFreed: resolve }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);
      pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
    });

    expect(apiClient.releaseTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("closes a half-open runtime circuit when the probe reaches in_review", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const circuitBreaker = new RuntimeCircuitBreaker({ failureThreshold: 1, cooldownMs: 0 });
    circuitBreaker.recordPreClaimFailure("claude", taskId, "agent exited before claim");
    expect(circuitBreaker.tryAcquireDispatch("claude")).toBe(true);
    expect(circuitBreaker.canDispatch("claude")).toBe(false);

    const agentClient = makeAgentClient({ status: "in_review" });
    const handle = makeHandle([makeTurnEndEvent()]);
    const provider = makeProvider(handle);

    await new Promise<void>((resolve) => {
      const pool = new RuntimePool(
        apiClient,
        { onSlotFreed: resolve },
        { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() },
        0,
        null,
        circuitBreaker,
      );
      pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
    });

    expect(circuitBreaker.canDispatch("claude")).toBe(true);
    expect(circuitBreaker.pauseResetAt("claude")).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Case 2: agent finishes normally with result but task is in_progress
  //   (e.g. rejected before finalize ran). Since agent produced a result,
  //   worktree is preserved for resume — releaseTask must NOT be called.
  // --------------------------------------------------------------------------

  it("does NOT call releaseTask when agent produces result even if task is in_progress", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient({ status: "in_progress" });
    const handle = makeHandle([makeTurnEndEvent()]);
    const provider = makeProvider(handle);

    await new Promise<void>((resolve) => {
      const pool = new RuntimePool(apiClient, { onSlotFreed: resolve }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);
      pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
    });

    expect(apiClient.releaseTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Case 3: agent finishes without a turn.end (no result received, not in_review)
  //   → nextStatus === "completing", opts.crashed === false, taskInReview === false
  //   → releaseTask MUST be called (the new behavior)
  // --------------------------------------------------------------------------

  it("calls releaseTask when agent exits without receiving any result", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    // Iterator ends cleanly with no events — no turn.end → resultReceived=false, taskInReview=false
    const agentClient = makeAgentClient(null); // getTask won't be called (no turn.end)
    const handle = makeHandle([]); // empty event stream
    const provider = makeProvider(handle);

    await new Promise<void>((resolve) => {
      const pool = new RuntimePool(apiClient, { onSlotFreed: resolve }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);
      pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
    });

    expect(apiClient.releaseTask as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(taskId);
  });

  it("does NOT release todo tasks and opens the runtime circuit after pre-claim exit", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const apiWithTodo = makeApiClient({ getTask: vi.fn().mockResolvedValue({ status: "todo" }) });
    const circuitBreaker = new RuntimeCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
    const agentClient = makeAgentClient(null);
    const handle = makeHandle([]);
    const provider = makeProvider(handle);

    await new Promise<void>((resolve) => {
      const pool = new RuntimePool(
        apiWithTodo,
        { onSlotFreed: resolve },
        { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() },
        0,
        null,
        circuitBreaker,
      );
      pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
    });

    expect(apiWithTodo.releaseTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(circuitBreaker.pauseResetAt("claude")).toEqual(expect.any(String));
  });

  // --------------------------------------------------------------------------
  // Case 4: agent crashes (iterator throws) — opts.crashed === true
  //   → releaseTask MUST be called (original behavior, preserved)
  // --------------------------------------------------------------------------

  it("calls releaseTask when agent crashes (iterator throws)", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    // Iterator throws immediately → crashed=true, taskInReview=false
    const agentClient = makeAgentClient(null);
    const crashHandle: AgentHandle = {
      // biome-ignore lint/correctness/useYield: generator must throw before yielding to simulate crash
      events: (async function* () {
        throw new Error("agent process died");
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };
    const provider = makeProvider(crashHandle);

    await new Promise<void>((resolve) => {
      const pool = new RuntimePool(apiClient, { onSlotFreed: resolve }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);
      pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
    });

    expect(apiClient.releaseTask as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(taskId);
  });

  // --------------------------------------------------------------------------
  // Case 5: agent crashes after receiving a result (crashed=true, taskInReview may be true)
  //   → releaseTask MUST be called because opts.crashed takes priority
  // --------------------------------------------------------------------------

  it("calls releaseTask when agent crashes even though turn.end was received and task is in_review", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    // turn.end fires first (sets taskInReview=true), then iterator throws
    const agentClient = makeAgentClient({ status: "in_review" });
    const crashAfterResult: AgentHandle = {
      events: (async function* () {
        yield makeTurnEndEvent();
        // turn.end causes agent.handle.abort() to be called (fire-and-forget).
        // Then the iterator throws to simulate an unexpected crash after result.
        throw new Error("unexpected exit after result");
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };
    const provider = makeProvider(crashAfterResult);

    await new Promise<void>((resolve) => {
      const pool = new RuntimePool(apiClient, { onSlotFreed: resolve }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);
      pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
    });

    expect(apiClient.releaseTask as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(taskId);
  });

  // --------------------------------------------------------------------------
  // Case 6: onSlotFreed fires exactly once (invariant for pool slot accounting)
  // --------------------------------------------------------------------------

  it("calls onSlotFreed exactly once when agent finishes normally", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient({ status: "in_progress" });
    const handle = makeHandle([]);
    const provider = makeProvider(handle);

    const onSlotFreed = vi.fn();
    await new Promise<void>((resolve) => {
      const wrappedSlotFreed = () => {
        onSlotFreed();
        resolve();
      };
      const pool = new RuntimePool(apiClient, { onSlotFreed: wrappedSlotFreed }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);
      pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
    });

    expect(onSlotFreed).toHaveBeenCalledTimes(1);
  });

  // --------------------------------------------------------------------------
  // Case 7: closeSession is always called (in addition to releaseTask when needed)
  // --------------------------------------------------------------------------

  it("calls closeSession regardless of whether releaseTask is called", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    // Normal finish with task in_review → no releaseTask but closeSession still fires
    const agentClient = makeAgentClient({ status: "in_review" });
    const handle = makeHandle([makeTurnEndEvent()]);
    const provider = makeProvider(handle);

    await new Promise<void>((resolve) => {
      const pool = new RuntimePool(apiClient, { onSlotFreed: resolve }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);
      pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
    });

    expect(apiClient.closeSession as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(apiClient.releaseTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Case 8: task removed from pool after finalize (hasTask returns false)
  // --------------------------------------------------------------------------

  it("removes the task from the pool after finalize completes", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient({ status: "in_progress" });
    const handle = makeHandle([]);
    const provider = makeProvider(handle);

    let pool!: RuntimePool;
    await new Promise<void>((resolve) => {
      pool = new RuntimePool(apiClient, { onSlotFreed: resolve }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);
      pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
    });

    expect(pool.hasTask(taskId)).toBe(false);
    expect(pool.activeCount).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Case 9: onCleanup callback fires during completing path (worktree cleanup)
  // --------------------------------------------------------------------------

  it("invokes onCleanup when agent completes (completing path, not in_review)", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient({ status: "in_progress" });
    const handle = makeHandle([]);
    const provider = makeProvider(handle);
    const onCleanup = vi.fn();

    await new Promise<void>((resolve) => {
      const pool = new RuntimePool(apiClient, { onSlotFreed: resolve }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);
      pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {}, onCleanup });
    });

    expect(onCleanup).toHaveBeenCalledTimes(1);
  });

  // --------------------------------------------------------------------------
  // Case 10: onCleanup is NOT invoked when task goes to in_review (worktree preserved)
  // --------------------------------------------------------------------------

  it("does NOT invoke onCleanup when task transitions to in_review (worktree preserved)", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    // turn.end + task in_review → state machine goes to in_review, not completing
    const agentClient = makeAgentClient({ status: "in_review" });
    const handle = makeHandle([makeTurnEndEvent()]);
    const provider = makeProvider(handle);
    const onCleanup = vi.fn();

    await new Promise<void>((resolve) => {
      const pool = new RuntimePool(apiClient, { onSlotFreed: resolve }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);
      pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {}, onCleanup });
    });

    expect(onCleanup).not.toHaveBeenCalled();
  });
});
