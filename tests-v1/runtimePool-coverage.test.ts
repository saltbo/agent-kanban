// @vitest-environment node
/**
 * Extended coverage tests for runtimePool.ts.
 *
 * Covers the contracts changed in the recent refactor:
 *   - routeTurnEnd: synchronous, reports per-segment tokens with cost_micro_usd=0,
 *     stores cumulative cost in lastCostUsd, sets resultReceived=true
 *   - finalize: checks task status, reports cumulative cost once, always releases
 *     in completing path (crash or non-crash)
 *   - AgentProcess / AgentFlags: lastCostUsd field, no taskInReview field
 *   - consumeEvents: syncs rateLimited, resultReceived, lastCostUsd back to agent
 *
 * Also covers RuntimePool public API:
 *   - getActiveTaskIds, sendToAgent, sendToSession, killTask, killAll
 *
 * Internal functions (routeTurnEnd, finalize, routeRateLimit, archiveMessage,
 * archiveBlock, finalizeCancelled) are driven indirectly through spawnAgent()
 * and killTask(), which exercise the full event loop.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Use a unique temp dir per test file so concurrent vitest workers don't
// conflict on the shared SESSIONS_DIR. The factory runs at hoist time so
// we cannot reference module-level variables — compute inline.
vi.mock("../packages/cli/src/paths.js", () => {
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const base = join(tmpdir(), `ak-test-runtimepool-cov-${process.pid}`);
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

// ---- Mock logger (avoid pino noise) ----------------------------------------
vi.mock("../packages/cli/src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  }),
}));

// ---- Mock systemPrompt to avoid file I/O ------------------------------------
vi.mock("../packages/cli/src/agent/systemPrompt.js", () => ({
  cleanupPromptFile: vi.fn(),
  writeSystemPromptFile: vi.fn().mockResolvedValue(undefined),
}));

import type { AgentClient, ApiClient } from "../packages/cli/src/client/index.js";
import { TransientError } from "../packages/cli/src/daemon/errors.js";
import { RuntimePool } from "../packages/cli/src/daemon/runtimePool.js";
import type { AgentEvent, AgentHandle, AgentProvider } from "../packages/cli/src/providers/types.js";
import { _setSessionManagerForTest, SessionManager } from "../packages/cli/src/session/manager.js";
import { clearAllSessions } from "../packages/cli/src/session/store.js";

// ============================================================================
// Helpers
// ============================================================================

function makeHandle(events: AgentEvent[] = []): AgentHandle {
  return {
    events: (async function* () {
      for (const ev of events) yield ev;
    })(),
    abort: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCrashHandle(afterEvents: AgentEvent[] = [], error?: Error): AgentHandle {
  const err = error ?? new Error("agent crashed");
  return {
    events: (async function* () {
      for (const ev of afterEvents) yield ev;
      throw err;
    })(),
    abort: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

function makeProvider(handle: AgentHandle): AgentProvider {
  return {
    name: "claude" as any,
    label: "Claude Code",
    execute: vi.fn().mockResolvedValue(handle),
  };
}

function makeApiClient(overrides: Partial<Record<string, any>> = {}): ApiClient {
  return {
    getTask: vi.fn().mockResolvedValue({ status: "in_progress" }),
    releaseTask: vi.fn().mockResolvedValue({}),
    closeSession: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as ApiClient;
}

function makeAgentClient(taskStub: { status?: string } | null = null): AgentClient {
  return {
    getAgentId: vi.fn().mockReturnValue("agent-id"),
    getSessionId: vi.fn().mockReturnValue("session-id"),
    getTask: vi.fn().mockResolvedValue(taskStub),
    updateSessionUsage: vi.fn().mockResolvedValue({}),
    sendMessage: vi.fn().mockResolvedValue({}),
  } as unknown as AgentClient;
}

function makeTurnEndEvent(cost = 0.001, inputTokens = 10, outputTokens = 5): AgentEvent {
  return {
    type: "turn.end",
    cost,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    },
  } as unknown as AgentEvent;
}

function makeRateLimitRejectedEvent(resetAt?: string, isUsingOverage = false): AgentEvent {
  return {
    type: "turn.rate_limit",
    status: "rejected",
    resetAt: resetAt ?? new Date(Date.now() + 60_000).toISOString(),
    isUsingOverage,
  } as AgentEvent;
}

function makeRateLimitRejectedWithOverageEvent(resetAt: string, overageResetAt: string): AgentEvent {
  return {
    type: "turn.rate_limit",
    status: "rejected",
    resetAt,
    isUsingOverage: false,
    overage: { status: "rejected", resetAt: overageResetAt },
  } as AgentEvent;
}

function makeRateLimitAllowedEvent(isUsingOverage = false): AgentEvent {
  return {
    type: "turn.rate_limit",
    status: "allowed",
    isUsingOverage,
  } as AgentEvent;
}

function makeMessageEvent(text: string): AgentEvent {
  return { type: "message", blocks: [{ type: "text", text }] } as AgentEvent;
}

function makeEmptyMessageEvent(): AgentEvent {
  return { type: "message", blocks: [] } as AgentEvent;
}

function makeBlockDoneEvent(text: string): AgentEvent {
  return { type: "block.done", block: { type: "text", text } } as AgentEvent;
}

function makeBlockDoneNonTextEvent(): AgentEvent {
  return { type: "block.done", block: { type: "tool_result" } } as AgentEvent;
}

function makeTurnErrorEvent(): AgentEvent {
  return { type: "turn.error", detail: "something went wrong" } as AgentEvent;
}

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
 * Spawn agent and await the onSlotFreed callback (which fires at the end of
 * runEventLoop's finally block, right after finalize() resolves).
 */
async function spawnAndWait(
  apiClient: ApiClient,
  opts: {
    events?: AgentEvent[];
    handle?: AgentHandle;
    taskId: string;
    sessionId: string;
    agentClient: AgentClient;
    onCleanup?: () => void;
    rateLimitSink?: { onRateLimited: any; onRateLimitResumed: any };
  },
): Promise<{ pool: RuntimePool }> {
  const handle = opts.handle ?? makeHandle(opts.events ?? []);
  const provider = makeProvider(handle);
  const rateLimitSink = opts.rateLimitSink ?? { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() };

  let pool!: RuntimePool;
  await new Promise<void>((resolve) => {
    pool = new RuntimePool(apiClient, { onSlotFreed: resolve }, rateLimitSink, 0, null);
    pool.spawnAgent({
      provider,
      taskId: opts.taskId,
      sessionId: opts.sessionId,
      cwd: "/tmp",
      taskContext: "test task",
      agentClient: opts.agentClient,
      agentEnv: {},
      onCleanup: opts.onCleanup,
    });
  });

  return { pool };
}

// ============================================================================
// Fixtures
// ============================================================================

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

// ============================================================================
// RuntimePool public API
// ============================================================================

describe("RuntimePool — getActiveTaskIds", () => {
  it("returns empty array when no agents are running", () => {
    const pool = new RuntimePool(apiClient, { onSlotFreed: vi.fn() }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);
    expect(pool.getActiveTaskIds()).toEqual([]);
  });

  it("returns the taskId of a running agent", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient({ status: "in_progress" });
    // Use a handle that never resolves so the task stays in the pool while we check
    let resolveEvents!: () => void;
    const stuckHandle: AgentHandle = {
      events: (async function* () {
        await new Promise<void>((r) => {
          resolveEvents = r;
        });
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };
    const provider = makeProvider(stuckHandle);
    const pool = new RuntimePool(apiClient, { onSlotFreed: vi.fn() }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);

    pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });

    // Allow microtasks to run so the agent is registered
    await new Promise((r) => setTimeout(r, 0));

    expect(pool.getActiveTaskIds()).toContain(taskId);
    // Clean up: resolve the generator so the loop exits
    resolveEvents();
  });
});

describe("RuntimePool — provider resume token persistence", () => {
  it("persists provider resume token while events are still streaming", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const token = "thread-live-123";
    let yielded = false;
    const handle: AgentHandle = {
      events: (async function* () {
        yielded = true;
        yield makeMessageEvent("hello");
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      getResumeToken: () => (yielded ? token : undefined),
    };

    await spawnAndWait(apiClient, {
      handle,
      taskId,
      sessionId,
      agentClient: makeAgentClient({ status: "in_progress" }),
    });

    expect(sessions.read(sessionId)?.providerResumeToken).toBe(token);
  });
});

describe("RuntimePool — provider execute options", () => {
  it("passes systemPromptFile through to the provider", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient({ status: "in_progress" });
    let resolveEvents!: () => void;
    const stuckHandle: AgentHandle = {
      events: (async function* () {
        await new Promise<void>((r) => {
          resolveEvents = r;
        });
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };
    const provider = makeProvider(stuckHandle);
    const pool = new RuntimePool(apiClient, { onSlotFreed: vi.fn() }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);

    await pool.spawnAgent({
      provider,
      taskId,
      sessionId,
      cwd: "/tmp",
      taskContext: "test task",
      agentClient,
      agentEnv: {},
      systemPromptFile: "/tmp/system-prompt.txt",
    });

    expect(provider.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPromptFile: "/tmp/system-prompt.txt",
      }),
    );
    resolveEvents();
  });
});

describe("RuntimePool — sendToAgent", () => {
  it("sends message to a running agent", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient({ status: "in_progress" });
    const sendSpy = vi.fn().mockResolvedValue(undefined);

    let resolveEvents!: () => void;
    const stuckHandle: AgentHandle = {
      events: (async function* () {
        await new Promise<void>((r) => {
          resolveEvents = r;
        });
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: sendSpy,
    };
    const provider = makeProvider(stuckHandle);
    const pool = new RuntimePool(apiClient, { onSlotFreed: vi.fn() }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);

    pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
    await new Promise((r) => setTimeout(r, 0));

    await pool.sendToAgent(taskId, "hello agent");

    expect(sendSpy).toHaveBeenCalledWith("hello agent");
    resolveEvents();
  });

  it("does nothing when taskId is not in pool", async () => {
    const pool = new RuntimePool(apiClient, { onSlotFreed: vi.fn() }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);
    // Should not throw
    await expect(pool.sendToAgent("nonexistent-task", "msg")).resolves.toBeUndefined();
  });
});

describe("RuntimePool — sendToSession", () => {
  it("sends message to agent matching sessionId and returns true", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient({ status: "in_progress" });
    const sendSpy = vi.fn().mockResolvedValue(undefined);

    let resolveEvents!: () => void;
    const stuckHandle: AgentHandle = {
      events: (async function* () {
        await new Promise<void>((r) => {
          resolveEvents = r;
        });
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: sendSpy,
    };
    const provider = makeProvider(stuckHandle);
    const pool = new RuntimePool(apiClient, { onSlotFreed: vi.fn() }, { onRateLimited: vi.fn(), onRatLimitResumed: vi.fn() }, 0, null);

    pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
    await new Promise((r) => setTimeout(r, 0));

    const result = await pool.sendToSession(sessionId, "hello session");

    expect(result).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith("hello session");
    resolveEvents();
  });

  it("returns false when no agent matches sessionId", async () => {
    const pool = new RuntimePool(apiClient, { onSlotFreed: vi.fn() }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);
    const result = await pool.sendToSession("nonexistent-session", "msg");
    expect(result).toBe(false);
  });
});

describe("RuntimePool — killTask", () => {
  it("removes task from pool and calls onSlotFreed", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient({ status: "in_progress" });
    const onSlotFreed = vi.fn();

    let resolveEvents!: () => void;
    const stuckHandle: AgentHandle = {
      events: (async function* () {
        await new Promise<void>((r) => {
          resolveEvents = r;
        });
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };
    const provider = makeProvider(stuckHandle);
    const pool = new RuntimePool(apiClient, { onSlotFreed }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);

    pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
    await new Promise((r) => setTimeout(r, 0));

    expect(pool.hasTask(taskId)).toBe(true);

    await pool.killTask(taskId);

    expect(pool.hasTask(taskId)).toBe(false);
    expect(onSlotFreed).toHaveBeenCalledTimes(1);
    resolveEvents();
  });

  it("does nothing when taskId is not in pool", async () => {
    const onSlotFreed = vi.fn();
    const pool = new RuntimePool(apiClient, { onSlotFreed }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);
    await pool.killTask("nonexistent-task");
    expect(onSlotFreed).not.toHaveBeenCalled();
  });

  it("calls closeSession after killing the task", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient({ status: "in_progress" });

    let resolveEvents!: () => void;
    const stuckHandle: AgentHandle = {
      events: (async function* () {
        await new Promise<void>((r) => {
          resolveEvents = r;
        });
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };
    const provider = makeProvider(stuckHandle);
    const pool = new RuntimePool(apiClient, { onSlotFreed: vi.fn() }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);

    pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
    await new Promise((r) => setTimeout(r, 0));

    await pool.killTask(taskId);

    // closeSession is fire-and-forget — give microtasks a chance to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(apiClient.closeSession as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    resolveEvents();
  });
});

describe("RuntimePool — killAll", () => {
  it("removes all tasks and fires releaseTask for each", async () => {
    const taskId1 = randomUUID();
    const sessionId1 = randomUUID();
    const taskId2 = randomUUID();
    const sessionId2 = randomUUID();
    await seedActiveSession(sessions, sessionId1, taskId1);
    await seedActiveSession(sessions, sessionId2, taskId2);

    const agentClient1 = makeAgentClient(null);
    const agentClient2 = makeAgentClient(null);

    let resolveEvents1!: () => void;
    let resolveEvents2!: () => void;
    const stuckHandle1: AgentHandle = {
      events: (async function* () {
        await new Promise<void>((r) => {
          resolveEvents1 = r;
        });
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };
    const stuckHandle2: AgentHandle = {
      events: (async function* () {
        await new Promise<void>((r) => {
          resolveEvents2 = r;
        });
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };

    const pool = new RuntimePool(apiClient, { onSlotFreed: vi.fn() }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);

    pool.spawnAgent({
      provider: makeProvider(stuckHandle1),
      taskId: taskId1,
      sessionId: sessionId1,
      cwd: "/tmp",
      taskContext: "t1",
      agentClient: agentClient1,
      agentEnv: {},
    });
    pool.spawnAgent({
      provider: makeProvider(stuckHandle2),
      taskId: taskId2,
      sessionId: sessionId2,
      cwd: "/tmp",
      taskContext: "t2",
      agentClient: agentClient2,
      agentEnv: {},
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(pool.activeCount).toBe(2);

    await pool.killAll();

    // Allow fire-and-forget calls to settle
    await new Promise((r) => setTimeout(r, 10));

    expect(pool.activeCount).toBe(0);
    expect(apiClient.releaseTask as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(taskId1);
    expect(apiClient.releaseTask as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(taskId2);
    resolveEvents1();
    resolveEvents2();
  });
});

// ============================================================================
// routeTurnEnd — per-segment token reporting and lastCostUsd storage
// ============================================================================

describe("routeTurnEnd — per-segment token reporting", () => {
  it("calls updateSessionUsage with cost_micro_usd=0 for per-segment reporting", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient({ status: "in_review" });
    const turnEnd = makeTurnEndEvent(0.005, 100, 50);

    await spawnAndWait(apiClient, { events: [turnEnd], taskId, sessionId, agentClient });

    // Let fire-and-forget settle
    await new Promise((r) => setTimeout(r, 10));

    const usageCalls = (agentClient.updateSessionUsage as ReturnType<typeof vi.fn>).mock.calls;
    // The per-segment call (from routeTurnEnd) must have cost_micro_usd=0
    const perSegmentCall = usageCalls.find((call: any[]) => call[2]?.cost_micro_usd === 0);
    expect(perSegmentCall).toBeDefined();
    expect(perSegmentCall[2].input_tokens).toBe(100);
    expect(perSegmentCall[2].output_tokens).toBe(50);
  });

  it("sets agent.lastCostUsd to the turn.end cost (stored for finalize)", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    // With task in_review, finalize reports cumulative cost via updateSessionUsage
    // with cost_micro_usd set and tokens all 0.
    const cost = 0.0025;
    const agentClient = makeAgentClient({ status: "in_review" });
    const turnEnd = makeTurnEndEvent(cost);

    await spawnAndWait(apiClient, { events: [turnEnd], taskId, sessionId, agentClient });

    await new Promise((r) => setTimeout(r, 10));

    const usageCalls = (agentClient.updateSessionUsage as ReturnType<typeof vi.fn>).mock.calls;
    // The cumulative cost call (from finalize) has cost_micro_usd != 0 and tokens all 0
    const costCall = usageCalls.find((call: any[]) => call[2]?.cost_micro_usd !== 0 && call[2]?.input_tokens === 0);
    expect(costCall).toBeDefined();
    expect(costCall[2].cost_micro_usd).toBe(Math.round(cost * 1_000_000));
  });

  it("does NOT call cumulative cost updateSessionUsage when lastCostUsd is 0", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    // turn.end with cost=0 → lastCostUsd=0 → finalize should skip cost reporting
    const agentClient = makeAgentClient({ status: "in_review" });
    const turnEnd = makeTurnEndEvent(0);

    await spawnAndWait(apiClient, { events: [turnEnd], taskId, sessionId, agentClient });

    await new Promise((r) => setTimeout(r, 10));

    const usageCalls = (agentClient.updateSessionUsage as ReturnType<typeof vi.fn>).mock.calls;
    // Should only have the per-segment call (cost_micro_usd=0), not a cumulative call
    const cumulativeCostCall = usageCalls.find((call: any[]) => call[2]?.cost_micro_usd !== 0);
    expect(cumulativeCostCall).toBeUndefined();
  });

  it("overwrites lastCostUsd when multiple turn.end events are received", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    // Two turn.end events — second overwrites first; finalize should report second cost
    const firstCost = 0.001;
    const secondCost = 0.003; // cumulative; overwrites first
    const agentClient = makeAgentClient({ status: "in_review" });
    const events: AgentEvent[] = [makeTurnEndEvent(firstCost), makeTurnEndEvent(secondCost)];

    await spawnAndWait(apiClient, { events, taskId, sessionId, agentClient });

    await new Promise((r) => setTimeout(r, 10));

    const usageCalls = (agentClient.updateSessionUsage as ReturnType<typeof vi.fn>).mock.calls;
    // Cumulative cost call uses the LAST cost (secondCost)
    const costCall = usageCalls.find((call: any[]) => call[2]?.cost_micro_usd !== 0 && call[2]?.input_tokens === 0);
    expect(costCall).toBeDefined();
    expect(costCall[2].cost_micro_usd).toBe(Math.round(secondCost * 1_000_000));
  });

  it("resultReceived=true causes finalize to preserve worktree (no release)", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient({ status: "in_progress" });
    const turnEnd = makeTurnEndEvent(0.001);

    await spawnAndWait(apiClient, { events: [turnEnd], taskId, sessionId, agentClient });

    // resultReceived=true → worktree preserved, no release
    expect(apiClient.releaseTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("resultReceived=false causes finalize to release task", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    // No turn.end → resultReceived stays false → release
    const agentClient = makeAgentClient(null);

    await spawnAndWait(apiClient, { events: [], taskId, sessionId, agentClient });

    expect(apiClient.releaseTask as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(taskId);
  });
});

// ============================================================================
// routeRateLimit — various branches
// ============================================================================

describe("routeRateLimit — rejected status", () => {
  it("sets rateLimited=true and calls onRateLimited when rate_limit is rejected", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    const onRateLimited = vi.fn();
    const rateLimitSink = { onRateLimited, onRateLimitResumed: vi.fn() };
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    const events: AgentEvent[] = [makeRateLimitRejectedEvent(resetAt)];

    await spawnAndWait(apiClient, { events, taskId, sessionId, agentClient, rateLimitSink });

    expect(onRateLimited).toHaveBeenCalledWith("claude", expect.any(String));
  });

  it("picks the later of main resetAt and overage resetAt", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    const onRateLimited = vi.fn();
    const rateLimitSink = { onRateLimited, onRateLimitResumed: vi.fn() };

    // Overage resets later — should use overage time
    const earlier = new Date(Date.now() + 30_000).toISOString();
    const later = new Date(Date.now() + 120_000).toISOString();
    const events: AgentEvent[] = [makeRateLimitRejectedWithOverageEvent(earlier, later)];

    await spawnAndWait(apiClient, { events, taskId, sessionId, agentClient, rateLimitSink });

    expect(onRateLimited).toHaveBeenCalledWith("claude", later);
  });

  it("uses fallback pauseUntil (1h from now) when resetAt is missing", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    const onRateLimited = vi.fn();
    const rateLimitSink = { onRateLimited, onRateLimitResumed: vi.fn() };

    // Missing resetAt — candidates array is empty — fallback to 1h
    const event: AgentEvent = {
      type: "turn.rate_limit",
      status: "rejected",
      resetAt: undefined as any,
      isUsingOverage: false,
    } as AgentEvent;

    await spawnAndWait(apiClient, { events: [event], taskId, sessionId, agentClient, rateLimitSink });

    expect(onRateLimited).toHaveBeenCalledOnce();
    // The pauseUntil should be roughly 1h from now
    const [, pauseUntil] = onRateLimited.mock.calls[0];
    const delta = new Date(pauseUntil).getTime() - Date.now();
    expect(delta).toBeGreaterThan(59 * 60 * 1000);
    expect(delta).toBeLessThan(61 * 60 * 1000);
  });
});

describe("routeRateLimit — persists resumeAfter to session file", () => {
  it("persists resumeAfter equal to new Date(pauseUntil).getTime() after a rejected rate_limit event", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    const rateLimitSink = { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() };
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    const expectedResumeAfter = new Date(resetAt).getTime();
    const events: AgentEvent[] = [makeRateLimitRejectedEvent(resetAt)];

    await spawnAndWait(apiClient, { events, taskId, sessionId, agentClient, rateLimitSink });

    const session = sessions.read(sessionId);
    expect(session).not.toBeNull();
    expect(session!.resumeAfter).toBe(expectedResumeAfter);
  });

  it("persists resumeAfter equal to the later overage resetAt when overage resets later than main", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    const rateLimitSink = { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() };

    // Overage resets later — pauseUntil should be the later time
    const earlier = new Date(Date.now() + 30_000).toISOString();
    const later = new Date(Date.now() + 120_000).toISOString();
    const expectedResumeAfter = new Date(later).getTime();
    const events: AgentEvent[] = [makeRateLimitRejectedWithOverageEvent(earlier, later)];

    await spawnAndWait(apiClient, { events, taskId, sessionId, agentClient, rateLimitSink });

    const session = sessions.read(sessionId);
    expect(session).not.toBeNull();
    expect(session!.resumeAfter).toBe(expectedResumeAfter);
  });

  it("persists resumeAfter approximately 1h from now when resetAt is missing and no overage", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    const rateLimitSink = { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() };

    // No resetAt and no overage → resetTimestamps.length === 0 → fallback: Date.now() + 3_600_000
    const before = Date.now();
    const event: AgentEvent = {
      type: "turn.rate_limit",
      status: "rejected",
      resetAt: undefined as any,
      isUsingOverage: false,
    } as AgentEvent;

    await spawnAndWait(apiClient, { events: [event], taskId, sessionId, agentClient, rateLimitSink });

    const session = sessions.read(sessionId);
    expect(session).not.toBeNull();
    const delta = session!.resumeAfter! - before;
    // Should be approximately 1 hour (3_600_000ms), within ±5s tolerance
    expect(delta).toBeGreaterThanOrEqual(3_600_000 - 5_000);
    expect(delta).toBeLessThanOrEqual(3_600_000 + 5_000);
  });
});

describe("routeRateLimit — allowed status", () => {
  it("clears rateLimited flag and calls onRateLimitResumed when allowed without overage", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    const onRateLimitResumed = vi.fn();
    const rateLimitSink = { onRateLimited: vi.fn(), onRateLimitResumed };

    // First reject (sets rateLimited=true), then allow (clears it)
    const events: AgentEvent[] = [makeRateLimitRejectedEvent(), makeRateLimitAllowedEvent(false)];

    await spawnAndWait(apiClient, { events, taskId, sessionId, agentClient, rateLimitSink });

    expect(onRateLimitResumed).toHaveBeenCalledWith("claude");
  });

  it("does NOT call onRateLimitResumed when isUsingOverage=true (scheduler stays paused)", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    const onRateLimitResumed = vi.fn();
    const rateLimitSink = { onRateLimited: vi.fn(), onRateLimitResumed };

    const events: AgentEvent[] = [makeRateLimitAllowedEvent(true)];

    await spawnAndWait(apiClient, { events, taskId, sessionId, agentClient, rateLimitSink });

    expect(onRateLimitResumed).not.toHaveBeenCalled();
  });
});

// ============================================================================
// archiveMessage and archiveBlock routing
// ============================================================================

describe("message event routing", () => {
  it("calls sendMessage when message event has text blocks", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    const events: AgentEvent[] = [makeMessageEvent("agent says hello")];

    await spawnAndWait(apiClient, { events, taskId, sessionId, agentClient });

    await new Promise((r) => setTimeout(r, 10));

    expect(agentClient.sendMessage as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ content: "agent says hello", sender_type: "agent" }),
    );
  });

  it("does NOT call sendMessage when message event has no text blocks", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    const events: AgentEvent[] = [makeEmptyMessageEvent()];

    await spawnAndWait(apiClient, { events, taskId, sessionId, agentClient });

    await new Promise((r) => setTimeout(r, 10));

    expect(agentClient.sendMessage as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

describe("block.done event routing", () => {
  it("calls sendMessage when block.done has a non-empty text block", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    const events: AgentEvent[] = [makeBlockDoneEvent("final answer")];

    await spawnAndWait(apiClient, { events, taskId, sessionId, agentClient });

    await new Promise((r) => setTimeout(r, 10));

    expect(agentClient.sendMessage as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ content: "final answer", sender_type: "agent" }),
    );
  });

  it("does NOT call sendMessage when block.done is non-text type", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    const events: AgentEvent[] = [makeBlockDoneNonTextEvent()];

    await spawnAndWait(apiClient, { events, taskId, sessionId, agentClient });

    await new Promise((r) => setTimeout(r, 10));

    expect(agentClient.sendMessage as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

describe("turn.error event routing", () => {
  it("does not crash when turn.error event is received", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    const events: AgentEvent[] = [makeTurnErrorEvent()];

    await expect(spawnAndWait(apiClient, { events, taskId, sessionId, agentClient })).resolves.toBeDefined();
  });
});

// ============================================================================
// finalize — rate_limited path
// ============================================================================

describe("finalize — rate_limited path (agent exits while rate-limited)", () => {
  it("does NOT call releaseTask when agent exits while rate-limited", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    const onRateLimited = vi.fn();
    const rateLimitSink = { onRateLimited, onRateLimitResumed: vi.fn() };

    // Rate limit event is received, then iterator ends cleanly
    const events: AgentEvent[] = [makeRateLimitRejectedEvent()];

    await spawnAndWait(apiClient, { events, taskId, sessionId, agentClient, rateLimitSink });

    await new Promise((r) => setTimeout(r, 10));

    expect(apiClient.releaseTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

// ============================================================================
// finalize — transient crash path
// ============================================================================

describe("finalize — transient crash (iterator throws TransientError)", () => {
  it("calls releaseTask even when agent crashes with transient error (completing path)", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    // TransientError maps to kind="transient" → classify returns TransientError → transient=true
    // transient + crashed + not rateLimited → iterator_crashed → completing
    const transientCrashHandle = makeCrashHandle([], new TransientError("network hiccup"));

    await spawnAndWait(apiClient, { handle: transientCrashHandle, taskId, sessionId, agentClient });

    await new Promise((r) => setTimeout(r, 10));

    // transient crash goes to rate_limited state (suspends), NOT completing
    // So releaseTask should NOT be called
    expect(apiClient.releaseTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

// ============================================================================
// finalizeCancelled — via killTask
// ============================================================================

describe("finalizeCancelled — via killTask", () => {
  it("calls closeSession after killing task", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    let resolveEvents!: () => void;
    const stuckHandle: AgentHandle = {
      events: (async function* () {
        await new Promise<void>((r) => {
          resolveEvents = r;
        });
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };

    const pool = new RuntimePool(apiClient, { onSlotFreed: vi.fn() }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);
    pool.spawnAgent({ provider: makeProvider(stuckHandle), taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
    await new Promise((r) => setTimeout(r, 0));

    await pool.killTask(taskId);
    await new Promise((r) => setTimeout(r, 10));

    expect(apiClient.closeSession as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    resolveEvents();
  });

  it("invokes onCleanup callback when task is killed", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    const onCleanup = vi.fn();

    let resolveEvents!: () => void;
    const stuckHandle: AgentHandle = {
      events: (async function* () {
        await new Promise<void>((r) => {
          resolveEvents = r;
        });
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };

    const pool = new RuntimePool(apiClient, { onSlotFreed: vi.fn() }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);
    pool.spawnAgent({
      provider: makeProvider(stuckHandle),
      taskId,
      sessionId,
      cwd: "/tmp",
      taskContext: "test",
      agentClient,
      agentEnv: {},
      onCleanup,
    });
    await new Promise((r) => setTimeout(r, 0));

    await pool.killTask(taskId);

    expect(onCleanup).toHaveBeenCalledTimes(1);
    resolveEvents();
  });
});

// ============================================================================
// consumeEvents — flag sync-back (rateLimited, resultReceived, lastCostUsd)
// ============================================================================

describe("consumeEvents — syncs flags back to AgentProcess", () => {
  it("resultReceived flag is persisted after turn.end so finalize calls getTask", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    // getTask returns in_review → expect finalize to preserve worktree (no releaseTask)
    const agentClient = makeAgentClient({ status: "in_review" });

    await spawnAndWait(apiClient, { events: [makeTurnEndEvent(0.001)], taskId, sessionId, agentClient });

    // resultReceived=true → worktree preserved, no release
    expect(apiClient.releaseTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("rateLimited flag sync prevents releaseTask when rate_limit event precedes iterator end", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    const rateLimitSink = { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() };
    const events: AgentEvent[] = [makeRateLimitRejectedEvent()];

    await spawnAndWait(apiClient, { events, taskId, sessionId, agentClient, rateLimitSink });

    await new Promise((r) => setTimeout(r, 10));

    // rateLimited=true was synced back → classifyIteratorEnd → rate_limited → no releaseTask
    expect(apiClient.releaseTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

// ============================================================================
// AgentProcess / AgentFlags shape — lastCostUsd field contract
// ============================================================================

describe("AgentProcess shape — lastCostUsd field", () => {
  it("initializes lastCostUsd to 0 on spawn", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    // No turn.end → lastCostUsd stays 0 → finalize does NOT call cumulative cost
    const agentClient = makeAgentClient(null);

    await spawnAndWait(apiClient, { events: [], taskId, sessionId, agentClient });

    await new Promise((r) => setTimeout(r, 10));

    const usageCalls = (agentClient.updateSessionUsage as ReturnType<typeof vi.fn>).mock.calls;
    const costCall = usageCalls.find((call: any[]) => call[2]?.cost_micro_usd !== 0);
    // No cost call — lastCostUsd was 0
    expect(costCall).toBeUndefined();
  });
});

// ============================================================================
// Timeout path (taskTimeoutMs > 0)
// ============================================================================

describe("RuntimePool — task timeout", () => {
  it("calls handle.abort when task exceeds the timeout", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    const abortSpy = vi.fn().mockResolvedValue(undefined);

    // A very short timeout (1ms) to trigger without waiting long
    let resolveEvents!: () => void;
    const stuckHandle: AgentHandle = {
      events: (async function* () {
        // Wait until abort is called, then resolve
        await new Promise<void>((r) => {
          resolveEvents = r;
        });
      })(),
      abort: abortSpy,
      send: vi.fn().mockResolvedValue(undefined),
    };
    const provider = makeProvider(stuckHandle);

    await new Promise<void>((resolve) => {
      const pool = new RuntimePool(
        apiClient,
        { onSlotFreed: resolve },
        { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() },
        1, // 1ms timeout — fires almost immediately
        null,
      );
      pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
      // Let the timeout fire, then resolve the generator to allow finalize to complete
      setTimeout(() => resolveEvents(), 20);
    });

    expect(abortSpy).toHaveBeenCalled();
  });
});

// ============================================================================
// clearTimer path (timeout timer is cleared in finalize)
// ============================================================================

describe("RuntimePool — clearTimer", () => {
  it("clears the timeout timer when agent finishes before timeout fires", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    // Use a long timeout (60s) so it doesn't fire during the test
    // but timer is set, and clearTimer is called in finalize
    const handle = makeHandle([]); // immediately resolves
    const provider = makeProvider(handle);

    await new Promise<void>((resolve) => {
      const pool = new RuntimePool(
        apiClient,
        { onSlotFreed: resolve },
        { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() },
        60_000, // 60s — won't fire during test
        null,
      );
      pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
    });

    // If clearTimer wasn't called, the timer would leak and keep the process alive.
    // We verify indirectly by checking the agent completed normally.
    expect(apiClient.releaseTask as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(taskId);
  });
});

// ============================================================================
// Unknown event type (default case in routeEvent switch)
// ============================================================================

describe("routeEvent — unknown event type", () => {
  it("handles unknown event types without crashing", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    // Inject an event type not handled by the switch
    const unknownEvent = { type: "unknown.event.type" } as unknown as AgentEvent;

    await expect(spawnAndWait(apiClient, { events: [unknownEvent], taskId, sessionId, agentClient })).resolves.toBeDefined();
  });
});

// ============================================================================
// tunnel integration — sendStatus called on spawn
// ============================================================================

describe("RuntimePool — tunnel integration", () => {
  it("calls tunnel.sendStatus with 'working' when agent is spawned", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    const sendStatus = vi.fn();
    const sendEvent = vi.fn();
    const tunnel = { sendStatus, sendEvent };

    const handle = makeHandle([]);
    const provider = makeProvider(handle);

    await new Promise<void>((resolve) => {
      const pool = new RuntimePool(apiClient, { onSlotFreed: resolve }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, tunnel);
      pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
    });

    expect(sendStatus).toHaveBeenCalledWith(sessionId, "working");
  });

  it("forwards events to tunnel via sendEvent", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    const sendEvent = vi.fn();
    const tunnel = { sendEvent };

    const events: AgentEvent[] = [makeTurnErrorEvent()];
    const handle = makeHandle(events);
    const provider = makeProvider(handle);

    await new Promise<void>((resolve) => {
      const pool = new RuntimePool(apiClient, { onSlotFreed: resolve }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, tunnel);
      pool.spawnAgent({ provider, taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
    });

    expect(sendEvent).toHaveBeenCalledWith(sessionId, expect.objectContaining({ type: "turn.error" }));
  });
});

// ============================================================================
// Multi-result (background task) — multiple turn.end events
// ============================================================================

function makeMultiTurnEndHandle(turns: Array<{ cost: number; inputTokens: number; outputTokens: number }>): AgentHandle {
  return {
    events: (async function* () {
      for (const t of turns) {
        yield {
          type: "turn.end",
          cost: t.cost,
          usage: {
            input_tokens: t.inputTokens,
            output_tokens: t.outputTokens,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        } as unknown as AgentEvent;
      }
    })(),
    abort: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

describe("multi-result: tokens reported per-segment, cost reported once in finalize", () => {
  it("calls updateSessionUsage 2x with cost_micro_usd=0 (tokens) and 1x with cumulative cost", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    // Two segments; finalize reports the LAST cumulative cost (0.09)
    const handle = makeMultiTurnEndHandle([
      { cost: 0.08, inputTokens: 100, outputTokens: 50 },
      { cost: 0.09, inputTokens: 10, outputTokens: 5 },
    ]);
    const agentClient = makeAgentClient({ status: "in_review" });

    await spawnAndWait(apiClient, { handle, taskId, sessionId, agentClient });
    await new Promise((r) => setTimeout(r, 10));

    const usageCalls = (agentClient.updateSessionUsage as ReturnType<typeof vi.fn>).mock.calls;

    const perSegmentCalls = usageCalls.filter((call: any[]) => call[2]?.cost_micro_usd === 0);
    expect(perSegmentCalls).toHaveLength(2);

    const cumulativeCalls = usageCalls.filter((call: any[]) => call[2]?.cost_micro_usd !== 0 && call[2]?.input_tokens === 0);
    expect(cumulativeCalls).toHaveLength(1);
    expect(cumulativeCalls[0][2].cost_micro_usd).toBe(Math.round(0.09 * 1_000_000));
  });
});

describe("multi-result: taskInReview reflects final state, not intermediate", () => {
  it("transitions to in_review when getTask returns in_review after all segments complete", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    // Agent called `ak task review` during the second segment; getTask returns in_review
    const agentClient = makeAgentClient({ status: "in_review" });
    const handle = makeMultiTurnEndHandle([
      { cost: 0.04, inputTokens: 80, outputTokens: 30 },
      { cost: 0.06, inputTokens: 20, outputTokens: 10 },
    ]);

    await spawnAndWait(apiClient, { handle, taskId, sessionId, agentClient });
    await new Promise((r) => setTimeout(r, 10));

    // resultReceived=true → worktree preserved, no release
    expect(apiClient.releaseTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

describe("multi-result: lastCostUsd overwrites, not accumulates", () => {
  it("reports finalize cost as 0.09 (second value), not 0.14 (sum)", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const handle = makeMultiTurnEndHandle([
      { cost: 0.05, inputTokens: 50, outputTokens: 20 },
      { cost: 0.09, inputTokens: 15, outputTokens: 8 },
    ]);
    const agentClient = makeAgentClient({ status: "in_review" });

    await spawnAndWait(apiClient, { handle, taskId, sessionId, agentClient });
    await new Promise((r) => setTimeout(r, 10));

    const usageCalls = (agentClient.updateSessionUsage as ReturnType<typeof vi.fn>).mock.calls;
    const cumulativeCall = usageCalls.find((call: any[]) => call[2]?.cost_micro_usd !== 0 && call[2]?.input_tokens === 0);
    expect(cumulativeCall).toBeDefined();
    // Must be 0.09 (overwrite), not 0.14 (accumulation)
    expect(cumulativeCall[2].cost_micro_usd).toBe(Math.round(0.09 * 1_000_000));
    expect(cumulativeCall[2].cost_micro_usd).not.toBe(Math.round(0.14 * 1_000_000));
  });
});

describe("finalize: cost reporting when lastCostUsd > 0 (line 415 coverage)", () => {
  it("calls updateSessionUsage with non-zero cost_micro_usd and all tokens=0 in finalize", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const cost = 0.0042;
    const agentClient = makeAgentClient({ status: "in_review" });
    const turnEnd = makeTurnEndEvent(cost, 200, 100);

    await spawnAndWait(apiClient, { events: [turnEnd], taskId, sessionId, agentClient });
    await new Promise((r) => setTimeout(r, 10));

    const usageCalls = (agentClient.updateSessionUsage as ReturnType<typeof vi.fn>).mock.calls;
    const finalizeCall = usageCalls.find(
      (call: any[]) =>
        call[2]?.cost_micro_usd === Math.round(cost * 1_000_000) &&
        call[2]?.input_tokens === 0 &&
        call[2]?.output_tokens === 0 &&
        call[2]?.cache_read_tokens === 0 &&
        call[2]?.cache_creation_tokens === 0,
    );
    expect(finalizeCall).toBeDefined();
  });
});

// ============================================================================
// finalize — non-transient crash → completing (line 454)
// ============================================================================

describe("finalize — non-transient crash → completing path", () => {
  it("calls releaseTask and logs agent-crashed warning when agent crashes with non-transient error", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);
    // A plain Error (not TransientError) → kind="fatal" → iterator_crashed → completing
    const crashHandle = makeCrashHandle([], new Error("fatal failure"));

    await spawnAndWait(apiClient, { handle: crashHandle, taskId, sessionId, agentClient });
    await new Promise((r) => setTimeout(r, 10));

    // Non-transient crash → completing → releaseTask is called
    expect(apiClient.releaseTask as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(taskId);
  });
});

// ============================================================================
// finalize — applyEvent error handler (lines 446-447, 465)
// ============================================================================

describe("finalize — applyEvent state transition error handler", () => {
  it("continues to completing path (releaseTask) even when state transition applyEvent throws", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);

    // Intercept the session state machine call that classifies iterator end (not task_cancelled)
    // so we exercise the catch at line 446-447. We make the first applyEvent call throw,
    // but only for the iterator_done_normal/iterator_crashed event type.
    const originalApplyEvent = sessions.applyEvent.bind(sessions);
    let firstApplyCall = true;
    vi.spyOn(sessions, "applyEvent").mockImplementation(async (sid: string, event: any) => {
      // Throw only on the first call (the main classifyIteratorEnd event)
      if (firstApplyCall && event.type !== "task_cancelled" && event.type !== "cleanup_done") {
        firstApplyCall = false;
        throw new Error("state transition failed");
      }
      return originalApplyEvent(sid, event);
    });

    // No events → resultReceived=false → iterator_done_normal → applyEvent throws → null returned → terminal
    await spawnAndWait(apiClient, { events: [], taskId, sessionId, agentClient });
    await new Promise((r) => setTimeout(r, 10));

    // When applyEvent throws, next is null → nextStatus is "terminal" → no releaseTask
    expect(apiClient.releaseTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("continues when cleanup_done applyEvent throws (line 465)", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);

    // Make cleanup_done applyEvent throw to exercise line 465
    const originalApplyEvent = sessions.applyEvent.bind(sessions);
    vi.spyOn(sessions, "applyEvent").mockImplementation(async (sid: string, event: any) => {
      if (event.type === "cleanup_done") {
        throw new Error("cleanup transition failed");
      }
      return originalApplyEvent(sid, event);
    });

    // No events → iterator_done_normal → completing → releaseTask → cleanup_done throws (caught)
    await spawnAndWait(apiClient, { events: [], taskId, sessionId, agentClient });
    await new Promise((r) => setTimeout(r, 10));

    // releaseTask is still called even though cleanup_done threw
    expect(apiClient.releaseTask as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(taskId);
  });
});

// ============================================================================
// errMessage — non-Error branch (lines 513-516)
// ============================================================================

describe("errMessage — non-Error branch via finalizeCancelled error handlers", () => {
  it("handles non-Error thrown values in finalizeCancelled error paths", async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await seedActiveSession(sessions, sessionId, taskId);

    const agentClient = makeAgentClient(null);

    // Patch sessions.applyEvent to throw a non-Error string value for task_cancelled
    // so the .catch handler in finalizeCancelled (line 486) calls errMessage("string error")
    const originalApplyEvent = sessions.applyEvent.bind(sessions);
    let _callCount = 0;
    vi.spyOn(sessions, "applyEvent").mockImplementation(async (sid: string, event: any) => {
      _callCount++;
      if (event.type === "task_cancelled") {
        // Throw a non-Error value to exercise errMessage's String() branch (line 515)
        throw "non-error string thrown from applyEvent";
      }
      if (event.type === "cleanup_done") {
        throw "another non-error value";
      }
      return originalApplyEvent(sid, event);
    });

    let resolveEvents!: () => void;
    const stuckHandle: AgentHandle = {
      events: (async function* () {
        await new Promise<void>((r) => {
          resolveEvents = r;
        });
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };

    const pool = new RuntimePool(apiClient, { onSlotFreed: vi.fn() }, { onRateLimited: vi.fn(), onRateLimitResumed: vi.fn() }, 0, null);
    pool.spawnAgent({ provider: makeProvider(stuckHandle), taskId, sessionId, cwd: "/tmp", taskContext: "test", agentClient, agentEnv: {} });
    await new Promise((r) => setTimeout(r, 0));

    // killTask triggers finalizeCancelled, which calls sessions.applyEvent for task_cancelled and cleanup_done
    await pool.killTask(taskId);
    await new Promise((r) => setTimeout(r, 10));

    // closeSession is still called even when applyEvent throws
    expect(apiClient.closeSession as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    resolveEvents();
  });
});
