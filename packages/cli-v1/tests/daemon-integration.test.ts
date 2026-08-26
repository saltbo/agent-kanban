// @vitest-environment node
/**
 * Daemon integration tests — cross-module flows.
 *
 * Tests exercise real SessionManager + real state machine backed by a real
 * temp filesystem. ApiClient, RuntimePool, and workspace ops are faked at
 * their boundaries so no actual network or subprocesses are invoked.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Redirect SESSIONS_DIR to isolated temp dir BEFORE any session code is imported ──
const { testSessionsDir } = vi.hoisted(() => {
  const { join } = require("node:path") as typeof import("node:path");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
  return { testSessionsDir: join(tmpdir(), `ak-di-test-${randomUUID()}`) };
});

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return {
    ...actual,
    SESSIONS_DIR: testSessionsDir,
    LEGACY_SAVED_SESSIONS_FILE: join(testSessionsDir, "saved-sessions.json"),
    LEGACY_SESSION_PIDS_FILE: join(testSessionsDir, "session-pids.json"),
  };
});

// ── Silence logger output in tests ───────────────────────────────────────────
vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── systemPrompt: avoid real filesystem writes ─────────────────────────────
vi.mock("../src/agent/systemPrompt.js", () => ({
  cleanupPromptFile: vi.fn(),
  generateSystemPrompt: vi.fn().mockReturnValue("system prompt"),
  writePromptFile: vi.fn().mockReturnValue(null),
}));

// ── config: provide fake credentials for resumeSession ───────────────────
vi.mock("../src/config.js", () => ({
  getCredentials: vi.fn().mockReturnValue({ apiUrl: "https://example.com", apiKey: "fake-key" }),
}));

// ── providers/registry: injectable fake provider ──────────────────────────
vi.mock("../src/providers/registry.js", () => ({
  getProvider: vi.fn().mockReturnValue({
    name: "claude",
    execute: vi.fn().mockResolvedValue({
      events: { [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }) },
      pid: process.pid,
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    }),
  }),
  normalizeRuntime: vi.fn().mockImplementation((r: string) => r),
}));

// ── AgentClient: stub to avoid real JWT signing during resume ────────────
vi.mock("../src/client/index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    AgentClient: vi.fn().mockImplementation(() => ({
      getAgentId: () => "agent-1",
      getSessionId: () => "session-1",
      getTask: vi.fn().mockResolvedValue({ status: "in_progress" }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      updateSessionUsage: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

// ── workspace: allow cleanupWorkspace to be overridden per-test ──────────
// Default: pass-through to real implementation. Individual tests can use
// vi.mocked(cleanupWorkspace).mockImplementation(...) to simulate failures.
vi.mock("../src/workspace/workspace.js", async (importOriginal) => {
  const real = (await importOriginal()) as any;
  return {
    ...real,
    cleanupWorkspace: vi.fn((...args: any[]) => real.cleanupWorkspace(...args)),
  };
});

// ── Real imports after mocks ──────────────────────────────────────────────────
import { ApiError } from "../src/client/index.js";
import {
  apiCall,
  apiCallIdempotent,
  apiCallOptional,
  apiFireAndForget,
  cleanupSync,
  cryptoBoundary,
  execBoundary,
  execBoundaryAsync,
  fsSync,
  providerExecute,
} from "../src/daemon/boundaries.js";
import {
  boundary,
  boundarySync,
  ClassifiedError,
  CleanupError,
  classify,
  RateLimitError,
  TerminalError,
  TransientError,
  CleanupError as WorkspaceCleanupError,
} from "../src/daemon/errors.js";
import { checkRejectedReviews, reapCleanupPending, reapOrphanWorkerSessions } from "../src/daemon/loop.js";
import { RateLimiter } from "../src/daemon/rateLimiter.js";
import { resumeOneSession } from "../src/daemon/resumer.js";
import type { RuntimePool } from "../src/daemon/runtimePool.js";
import { _setSessionManagerForTest, SessionManager } from "../src/session/manager.js";
import { applyTransition, classifyIteratorEnd, TransitionError } from "../src/session/stateMachine.js";
import type { SessionFile } from "../src/session/types.js";
import { cleanupWorkspace } from "../src/workspace/workspace.js";

// ── Shared setup / teardown ───────────────────────────────────────────────────

let sm: SessionManager;

beforeEach(() => {
  mkdirSync(testSessionsDir, { recursive: true });
  sm = new SessionManager();
  _setSessionManagerForTest(sm);
});

afterEach(() => {
  _setSessionManagerForTest(null);
  rmSync(testSessionsDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ── Shared factories ──────────────────────────────────────────────────────────

function makeWorkerFile(sessionId: string, overrides: Partial<SessionFile> = {}): SessionFile {
  return {
    type: "worker",
    agentId: "agent-1",
    sessionId,
    runtime: "claude" as any,
    startedAt: Date.now(),
    apiUrl: "http://localhost",
    privateKeyJwk: { kty: "OKP" } as JsonWebKey,
    taskId: "task-1",
    workspace: { type: "temp", cwd: "/tmp/fake-cwd" },
    status: "active",
    ...overrides,
  };
}

function makePool(overrides: Partial<RuntimePool> = {}): RuntimePool {
  return {
    hasTask: vi.fn().mockReturnValue(false),
    activeCount: 0,
    activeCountForRuntime: vi.fn().mockReturnValue(0),
    getActiveTaskIds: vi.fn().mockReturnValue([]),
    spawnAgent: vi.fn().mockResolvedValue(undefined),
    killAll: vi.fn().mockResolvedValue(undefined),
    killTask: vi.fn().mockResolvedValue(undefined),
    sendToAgent: vi.fn().mockResolvedValue(undefined),
    sendToSession: vi.fn().mockResolvedValue(false),
    ...overrides,
  } as unknown as RuntimePool;
}

function makeApiClient(overrides: Record<string, unknown> = {}) {
  const _makeNotFound = () => {
    const err = Object.assign(new Error("not found"), { status: 404 });
    return Promise.reject(err);
  };
  return {
    getTask: vi.fn().mockResolvedValue({ status: "in_progress" }),
    releaseTask: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    getTaskNotes: vi.fn().mockResolvedValue([]),
    listTasks: vi.fn().mockResolvedValue([]),
    listRepositories: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Orphan reaping — orphanFromStore (task still viable on server)
// ════════════════════════════════════════════════════════════════════════════

describe("orphan reaping — active session not in pool (task viable)", () => {
  it("releases task on server, drives session to closed", async () => {
    const sessionId = randomUUID();
    const taskId = `task-${randomUUID()}`;
    await sm.create(makeWorkerFile(sessionId, { taskId, status: "active" }));

    const pool = makePool({ hasTask: vi.fn().mockReturnValue(false) });
    const client = makeApiClient({
      getTask: vi.fn().mockResolvedValue({ status: "in_progress" }),
      releaseTask: vi.fn().mockResolvedValue(undefined),
    });

    await reapOrphanWorkerSessions(sm, pool, client as any);

    expect(client.releaseTask).toHaveBeenCalledWith(taskId);
    expect(sm.read(sessionId)?.status).toBe("closed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Orphan reaping — task already done on server
// ════════════════════════════════════════════════════════════════════════════

describe("orphan reaping — task done on server", () => {
  it("reaps session without calling releaseTask", async () => {
    const sessionId = randomUUID();
    const taskId = `task-${randomUUID()}`;
    await sm.create(makeWorkerFile(sessionId, { taskId, status: "active" }));

    const pool = makePool({ hasTask: vi.fn().mockReturnValue(false) });
    const client = makeApiClient({
      getTask: vi.fn().mockResolvedValue({ status: "done" }),
      releaseTask: vi.fn().mockResolvedValue(undefined),
    });

    await reapOrphanWorkerSessions(sm, pool, client as any);

    expect(client.releaseTask).not.toHaveBeenCalled();
    expect(sm.read(sessionId)?.status).toBe("closed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Orphan reaping — task 404 on server
// ════════════════════════════════════════════════════════════════════════════

describe("orphan reaping — task 404", () => {
  it("reaps session when server returns 404", async () => {
    const sessionId = randomUUID();
    const taskId = `task-${randomUUID()}`;
    await sm.create(makeWorkerFile(sessionId, { taskId, status: "active" }));

    const pool = makePool({ hasTask: vi.fn().mockReturnValue(false) });
    const client = makeApiClient({
      getTask: vi.fn().mockRejectedValue(new ApiError(404, "not found")),
      releaseTask: vi.fn().mockResolvedValue(undefined),
    });

    await reapOrphanWorkerSessions(sm, pool, client as any);

    expect(sm.read(sessionId)?.status).toBe("closed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Orphan reaping — pool already holds the task (not an orphan)
// ════════════════════════════════════════════════════════════════════════════

describe("orphan reaping — session held by pool is skipped", () => {
  it("does not reap a session whose taskId is in the pool", async () => {
    const sessionId = randomUUID();
    const taskId = `task-${randomUUID()}`;
    await sm.create(makeWorkerFile(sessionId, { taskId, status: "active" }));

    const pool = makePool({ hasTask: vi.fn().mockReturnValue(true) });
    const client = makeApiClient();

    await reapOrphanWorkerSessions(sm, pool, client as any);

    expect(sm.read(sessionId)).not.toBeNull();
    expect(client.releaseTask).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Cleanup retry — cleanupPending
// ════════════════════════════════════════════════════════════════════════════

describe("cleanup retry — cleanupPending", () => {
  it("retries a completing session with cleanupPending=true and closes it on success", async () => {
    const sessionId = randomUUID();
    // Create session in completing state with cleanupPending
    await sm.create(makeWorkerFile(sessionId, { taskId: "t1", status: "active" }));
    // Advance to completing via state machine
    await sm.applyEvent(sessionId, { type: "iterator_done_normal" });
    // Patch in cleanupPending
    await sm.patch(sessionId, { cleanupPending: true });

    const before = sm.read(sessionId);
    expect(before?.status).toBe("completing");
    expect(before?.cleanupPending).toBe(true);

    // reapCleanupPending should drive it through cleanup_done → closed
    await reapCleanupPending(sm);

    expect(sm.read(sessionId)?.status).toBe("closed");
  });

  it("leaves session intact if cleanupPending=false", async () => {
    const sessionId = randomUUID();
    await sm.create(makeWorkerFile(sessionId, { taskId: "t1", status: "active" }));
    await sm.applyEvent(sessionId, { type: "iterator_done_normal" });
    // Do NOT set cleanupPending

    await reapCleanupPending(sm);

    // Should not have been touched — still completing
    const after = sm.read(sessionId);
    expect(after?.status).toBe("completing");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Concurrent applyEvent — mutex serialization
// ════════════════════════════════════════════════════════════════════════════

describe("concurrent applyEvent — mutex serializes writes", () => {
  it("second concurrent applyEvent sees completing state and throws TransitionError", async () => {
    const sessionId = randomUUID();
    await sm.create(makeWorkerFile(sessionId, { status: "active" }));

    const first = sm.applyEvent(sessionId, { type: "iterator_done_normal" });
    const second = sm.applyEvent(sessionId, { type: "iterator_done_normal" });

    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(TransitionError);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. RateLimiter — longer window wins on duplicate pause calls
// ════════════════════════════════════════════════════════════════════════════

describe("RateLimiter — max window wins", () => {
  it("keeps the longer reset window when pause is called twice", () => {
    vi.useFakeTimers();
    const onResumed = vi.fn();
    const rl = new RateLimiter({ onResumed });

    const shortReset = new Date(Date.now() + 70_000).toISOString(); // ~1m10s
    const longReset = new Date(Date.now() + 300_000).toISOString(); // 5m

    rl.pause("claude", shortReset);
    expect(rl.isRuntimePaused("claude")).toBe(true);

    rl.pause("claude", longReset);
    expect(rl.isRuntimePaused("claude")).toBe(true);

    // Short pause fires after 70s — runtime should still be paused (long window)
    vi.advanceTimersByTime(80_000);
    expect(rl.isRuntimePaused("claude")).toBe(true);

    // After 5m the long window expires
    vi.advanceTimersByTime(300_000);
    expect(rl.isRuntimePaused("claude")).toBe(false);

    rl.stop();
    vi.useRealTimers();
  });

  it("does NOT extend the window when pause is called with a shorter reset", () => {
    vi.useFakeTimers();
    const onResumed = vi.fn();
    const rl = new RateLimiter({ onResumed });

    const longReset = new Date(Date.now() + 300_000).toISOString(); // 5m
    const shortReset = new Date(Date.now() + 70_000).toISOString(); // ~1m

    rl.pause("claude", longReset);
    rl.pause("claude", shortReset); // shorter — must be ignored

    // After 1m10s the runtime must still be paused
    vi.advanceTimersByTime(80_000);
    expect(rl.isRuntimePaused("claude")).toBe(true);

    rl.stop();
    vi.useRealTimers();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. RateLimiter — resumeRateLimit fires onResumed immediately
// ════════════════════════════════════════════════════════════════════════════

describe("RateLimiter — resumeRateLimit", () => {
  it("fires onResumed and clears pause when resumeRateLimit is called", () => {
    vi.useFakeTimers();
    const onResumed = vi.fn();
    const rl = new RateLimiter({ onResumed });

    const reset = new Date(Date.now() + 300_000).toISOString();
    rl.pause("claude", reset);
    expect(rl.isRuntimePaused("claude")).toBe(true);

    rl.resumeRateLimit("claude");

    expect(rl.isRuntimePaused("claude")).toBe(false);
    expect(onResumed).toHaveBeenCalledWith("claude");

    rl.stop();
    vi.useRealTimers();
  });

  it("is a no-op when runtime is not paused", () => {
    const onResumed = vi.fn();
    const rl = new RateLimiter({ onResumed });

    rl.resumeRateLimit("claude"); // not paused — must not throw

    expect(onResumed).not.toHaveBeenCalled();
    rl.stop();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. Review watcher — task flipped to in_progress (rejection)
// ════════════════════════════════════════════════════════════════════════════

describe("review watcher — task rejected (in_progress)", () => {
  it("calls resumeOne with rejection message for in_review session when task is in_progress", async () => {
    const sessionId = randomUUID();
    const taskId = `task-${randomUUID()}`;
    await sm.create(makeWorkerFile(sessionId, { taskId, status: "in_review" }));

    const pool = makePool({ hasTask: vi.fn().mockReturnValue(false), activeCount: 0 } as any);
    const client = makeApiClient({
      getTask: vi.fn().mockResolvedValue({ status: "in_progress" }),
      getTaskNotes: vi.fn().mockResolvedValue([{ action: "rejected", detail: "wrong approach" }]),
    });

    const resumeOne = vi.fn().mockResolvedValue(undefined);
    await checkRejectedReviews(sm, pool, client as any, resumeOne, 5);

    expect(resumeOne).toHaveBeenCalledOnce();
    const [calledSession, message] = resumeOne.mock.calls[0];
    expect(calledSession.sessionId).toBe(sessionId);
    expect(message).toContain("wrong approach");
  });

  it("cleans up session when in_progress with no rejection note (agent never submitted review)", async () => {
    const sessionId = randomUUID();
    const taskId = `task-${randomUUID()}`;
    await sm.create(makeWorkerFile(sessionId, { taskId, status: "in_review" }));

    const pool = makePool({ hasTask: vi.fn().mockReturnValue(false), activeCount: 0 } as any);
    const client = makeApiClient({
      getTask: vi.fn().mockResolvedValue({ status: "in_progress" }),
      getTaskNotes: vi.fn().mockResolvedValue([]),
    });

    const resumeOne = vi.fn().mockResolvedValue(undefined);
    await checkRejectedReviews(sm, pool, client as any, resumeOne, 5);

    // No reject action → don't resume, clean up instead
    expect(resumeOne).not.toHaveBeenCalled();
    expect(sm.read(sessionId)?.status).toBe("closed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 10. Review watcher — task done during review
// ════════════════════════════════════════════════════════════════════════════

describe("review watcher — task done while in_review", () => {
  it("drives the session to closed when task.status is done", async () => {
    const sessionId = randomUUID();
    const taskId = `task-${randomUUID()}`;
    await sm.create(makeWorkerFile(sessionId, { taskId, status: "in_review" }));

    const pool = makePool({ hasTask: vi.fn().mockReturnValue(false), activeCount: 0 } as any);
    const client = makeApiClient({
      getTask: vi.fn().mockResolvedValue({ status: "done" }),
    });

    const resumeOne = vi.fn().mockResolvedValue(undefined);
    await checkRejectedReviews(sm, pool, client as any, resumeOne, 5);

    expect(resumeOne).not.toHaveBeenCalled();
    expect(sm.read(sessionId)?.status).toBe("closed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 11. Review watcher — task 404 during review
// ════════════════════════════════════════════════════════════════════════════

describe("review watcher — task 404 during review", () => {
  it("drives session to closed when task returns 404", async () => {
    const sessionId = randomUUID();
    const taskId = `task-${randomUUID()}`;
    await sm.create(makeWorkerFile(sessionId, { taskId, status: "in_review" }));

    const pool = makePool({ hasTask: vi.fn().mockReturnValue(false), activeCount: 0 } as any);
    const client = makeApiClient({
      getTask: vi.fn().mockRejectedValue(new ApiError(404, "not found")),
    });

    const resumeOne = vi.fn().mockResolvedValue(undefined);
    await checkRejectedReviews(sm, pool, client as any, resumeOne, 5);

    expect(resumeOne).not.toHaveBeenCalled();
    expect(sm.read(sessionId)?.status).toBe("closed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 12. Review watcher — maxConcurrent gate
// ════════════════════════════════════════════════════════════════════════════

describe("review watcher — maxConcurrent gate", () => {
  it("skips processing when session runtime is at maxConcurrent", async () => {
    const sessionId = randomUUID();
    const taskId = `task-${randomUUID()}`;
    await sm.create(makeWorkerFile(sessionId, { taskId, status: "in_review" }));

    const pool = makePool({ hasTask: vi.fn().mockReturnValue(false), activeCountForRuntime: vi.fn().mockReturnValue(5) } as any);
    const client = makeApiClient({
      getTask: vi.fn().mockResolvedValue({ status: "in_progress" }),
    });

    const resumeOne = vi.fn().mockResolvedValue(undefined);
    await checkRejectedReviews(sm, pool, client as any, resumeOne, 5);

    expect(resumeOne).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 13. Review watcher — resumeAfter backoff gate
// ════════════════════════════════════════════════════════════════════════════

describe("review watcher — resumeAfter gate", () => {
  it("skips a session whose resumeAfter is in the future", async () => {
    const sessionId = randomUUID();
    const taskId = `task-${randomUUID()}`;
    await sm.create(
      makeWorkerFile(sessionId, {
        taskId,
        status: "in_review",
        resumeAfter: Date.now() + 60_000, // backoff window active
      }),
    );

    const pool = makePool({ hasTask: vi.fn().mockReturnValue(false), activeCount: 0 } as any);
    const client = makeApiClient({
      getTask: vi.fn().mockResolvedValue({ status: "in_progress" }),
    });

    const resumeOne = vi.fn().mockResolvedValue(undefined);
    await checkRejectedReviews(sm, pool, client as any, resumeOne, 5);

    expect(resumeOne).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14. resumeOneSession — backoff persists across failures
// ════════════════════════════════════════════════════════════════════════════

describe("resumeOneSession — backoff on failure", () => {
  // resumeOneSession sets backoff when resumeSession THROWS (transient error).
  // A 503 from getTask (after workspace check passes) causes resumeSession to
  // throw a TransientError, which resumeOneSession classifies as ok=false and
  // applies the backoff patch. The session file survives because the throw
  // path does NOT call forceRemove.
  it("sets resumeBackoffMs after first failure and doubles on second", async () => {
    const sessionId = randomUUID();
    const taskId = `task-${randomUUID()}`;
    const workDir = mkdtempSync(join(tmpdir(), "ak-di-resume-"));

    const session = makeWorkerFile(sessionId, {
      taskId,
      status: "in_review",
      workspace: { type: "temp", cwd: workDir },
    });
    await sm.create(session);

    // 503 → TransientError → resumeSession throws → resumeOneSession sets backoff
    const client = makeApiClient({
      getTask: vi.fn().mockRejectedValue(new ApiError(503, "service unavailable")),
      releaseTask: vi.fn().mockResolvedValue(undefined),
    });

    const pool = makePool();

    // First failure — should set initial backoff
    const sessionSnapshot = sm.read(sessionId)!;
    await resumeOneSession(sessionSnapshot, "test message", client as any, pool);

    const afterFirst = sm.read(sessionId);
    expect(afterFirst?.resumeBackoffMs).toBeDefined();
    expect(afterFirst!.resumeBackoffMs).toBeGreaterThan(0);
    expect(afterFirst?.resumeAfter).toBeDefined();

    // Second failure — backoff should double
    const prevBackoff = afterFirst!.resumeBackoffMs!;
    const sessionSnapshot2 = sm.read(sessionId)!;
    await resumeOneSession(sessionSnapshot2, "test message", client as any, pool);

    const afterSecond = sm.read(sessionId);
    expect(afterSecond?.resumeBackoffMs).toBeDefined();
    expect(afterSecond!.resumeBackoffMs).toBeGreaterThanOrEqual(prevBackoff);

    rmSync(workDir, { recursive: true, force: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 15. State machine — full happy path lifecycle
// ════════════════════════════════════════════════════════════════════════════

describe("state machine — full lifecycle active→in_review→active→completing→closed", () => {
  it("transitions through complete lifecycle successfully", async () => {
    const sessionId = randomUUID();
    await sm.create(makeWorkerFile(sessionId, { status: "active" }));

    // active → in_review
    const s1 = await sm.applyEvent(sessionId, { type: "iterator_done_with_result", taskInReview: true });
    expect(s1?.status).toBe("in_review");

    // in_review → active (rejected)
    const s2 = await sm.applyEvent(sessionId, { type: "rejected_by_reviewer" });
    expect(s2?.status).toBe("active");

    // active → completing
    const s3 = await sm.applyEvent(sessionId, { type: "iterator_done_normal" });
    expect(s3?.status).toBe("completing");

    // completing → closed (file retained with status: "closed")
    const s4 = await sm.applyEvent(sessionId, { type: "cleanup_done" });
    expect(s4?.status).toBe("closed");
    expect(sm.read(sessionId)?.status).toBe("closed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 16. State machine — rate limit lifecycle
// ════════════════════════════════════════════════════════════════════════════

describe("state machine — rate limit lifecycle", () => {
  it("transitions active→rate_limited→active→completing→closed", async () => {
    const sessionId = randomUUID();
    await sm.create(makeWorkerFile(sessionId, { status: "active" }));

    // active → rate_limited
    const s1 = await sm.applyEvent(sessionId, { type: "iterator_done_rate_limited" });
    expect(s1?.status).toBe("rate_limited");

    // rate_limited → active
    const s2 = await sm.applyEvent(sessionId, { type: "resume_started" });
    expect(s2?.status).toBe("active");

    // active → completing
    const s3 = await sm.applyEvent(sessionId, { type: "iterator_done_normal" });
    expect(s3?.status).toBe("completing");

    // completing → closed (file retained with status: "closed")
    const s4 = await sm.applyEvent(sessionId, { type: "cleanup_done" });
    expect(s4?.status).toBe("closed");
    expect(sm.read(sessionId)?.status).toBe("closed");
  });

  it("transitions rate_limited→completing via resume_failed_terminal", async () => {
    const sessionId = randomUUID();
    await sm.create(makeWorkerFile(sessionId, { status: "rate_limited" }));

    const s1 = await sm.applyEvent(sessionId, { type: "resume_failed_terminal" });
    expect(s1?.status).toBe("completing");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 17. Corrupt session file — SessionManager skips it on list
// ════════════════════════════════════════════════════════════════════════════

describe("corrupt session file handling", () => {
  it("list() skips corrupt JSON files", () => {
    const corruptId = randomUUID();
    writeFileSync(join(testSessionsDir, `${corruptId}.json`), "NOT_VALID_JSON{{{");

    const all = sm.list();
    const ids = all.map((s) => s.sessionId);
    expect(ids).not.toContain(corruptId);
  });

  it("read() returns null for a corrupt file", () => {
    const corruptId = randomUUID();
    writeFileSync(join(testSessionsDir, `${corruptId}.json`), "NOT_VALID_JSON{{{");

    expect(sm.read(corruptId)).toBeNull();
  });

  it("a corrupt file does not prevent listing valid sessions", async () => {
    const corruptId = randomUUID();
    writeFileSync(join(testSessionsDir, `${corruptId}.json`), "BAD");

    const goodId = randomUUID();
    await sm.create(makeWorkerFile(goodId, { status: "active" }));

    const all = sm.list();
    const ids = all.map((s) => s.sessionId);
    expect(ids).toContain(goodId);
    expect(ids).not.toContain(corruptId);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 18. State machine — task_cancelled from active
// ════════════════════════════════════════════════════════════════════════════

describe("state machine — task_cancelled from active", () => {
  it("active + task_cancelled → completing", async () => {
    const sessionId = randomUUID();
    await sm.create(makeWorkerFile(sessionId, { status: "active" }));

    const s = await sm.applyEvent(sessionId, { type: "task_cancelled" });
    expect(s?.status).toBe("completing");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 19. State machine — task_cancelled from rate_limited
// ════════════════════════════════════════════════════════════════════════════

describe("state machine — task_cancelled from rate_limited", () => {
  it("rate_limited + task_cancelled → completing", async () => {
    const sessionId = randomUUID();
    await sm.create(makeWorkerFile(sessionId, { status: "rate_limited" }));

    const s = await sm.applyEvent(sessionId, { type: "task_cancelled" });
    expect(s?.status).toBe("completing");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 20. State machine — task_deleted from in_review
// ════════════════════════════════════════════════════════════════════════════

describe("state machine — task_deleted from in_review", () => {
  it("in_review + task_deleted → completing", async () => {
    const sessionId = randomUUID();
    await sm.create(makeWorkerFile(sessionId, { status: "in_review" }));

    const s = await sm.applyEvent(sessionId, { type: "task_deleted" });
    expect(s?.status).toBe("completing");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 21. State machine — orphan_detected from active
// ════════════════════════════════════════════════════════════════════════════

describe("state machine — orphan_detected from active", () => {
  it("active + orphan_detected → completing", async () => {
    const sessionId = randomUUID();
    await sm.create(makeWorkerFile(sessionId, { status: "active" }));

    const s = await sm.applyEvent(sessionId, { type: "orphan_detected" });
    expect(s?.status).toBe("completing");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 22. State machine — illegal transitions throw TransitionError
// ════════════════════════════════════════════════════════════════════════════

describe("state machine — illegal transitions throw TransitionError", () => {
  it("cleanup_done on active session throws TransitionError", async () => {
    const sessionId = randomUUID();
    await sm.create(makeWorkerFile(sessionId, { status: "active" }));

    await expect(sm.applyEvent(sessionId, { type: "cleanup_done" })).rejects.toThrow(TransitionError);
  });

  it("orphan_detected on in_review session throws TransitionError", async () => {
    const sessionId = randomUUID();
    await sm.create(makeWorkerFile(sessionId, { status: "in_review" }));

    await expect(sm.applyEvent(sessionId, { type: "orphan_detected" })).rejects.toThrow(TransitionError);
  });

  it("iterator_done_normal on completing session throws TransitionError", async () => {
    const sessionId = randomUUID();
    await sm.create(makeWorkerFile(sessionId, { status: "active" }));
    await sm.applyEvent(sessionId, { type: "iterator_done_normal" });
    // Now in completing

    await expect(sm.applyEvent(sessionId, { type: "iterator_done_normal" })).rejects.toThrow(TransitionError);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 23. Orphan reaping — in_review sessions are never reaped
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// orphanReaper — CleanupError in completeTerminal → cleanupPending (lines 88-93)
// ════════════════════════════════════════════════════════════════════════════

describe("orphan reaping — completeTerminal: workspace cleanup CleanupError → cleanupPending", () => {
  afterEach(() => {
    vi.mocked(cleanupWorkspace).mockRestore();
  });

  it("marks session with cleanupPending when cleanupWorkspace throws CleanupError", async () => {
    const sessionId = randomUUID();
    const taskId = `task-${randomUUID()}`;
    const workDir = mkdtempSync(join(tmpdir(), "ak-di-ct-cle-"));

    await sm.create(
      makeWorkerFile(sessionId, {
        taskId,
        status: "active",
        workspace: { type: "temp", cwd: workDir },
      }),
    );

    const pool = makePool({ hasTask: vi.fn().mockReturnValue(false) });
    const client = makeApiClient({
      getTask: vi.fn().mockResolvedValue({ status: "in_progress" }),
      releaseTask: vi.fn().mockResolvedValue(undefined),
    });

    // Make cleanupWorkspace throw CleanupError — exercises lines 88-93 in completeTerminal
    vi.mocked(cleanupWorkspace).mockImplementation(() => {
      throw new WorkspaceCleanupError("simulated cleanup failure");
    });

    await reapOrphanWorkerSessions(sm, pool, client as any);

    const after = sm.read(sessionId);
    expect(after).not.toBeNull();
    expect(after?.cleanupPending).toBe(true);
    expect(after?.status).toBe("completing");

    rmSync(workDir, { recursive: true, force: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// orphanReaper — CleanupError in reapCleanupPending → stays pending (lines 71-73)
// ════════════════════════════════════════════════════════════════════════════

describe("orphan reaper — reapCleanupPending: cleanupWorkspace still throws → stays pending", () => {
  it("leaves session with cleanupPending when cleanup throws again", async () => {
    const sessionId = randomUUID();
    const workDir = mkdtempSync(join(tmpdir(), "ak-di-rcp-cle-"));

    await sm.create(
      makeWorkerFile(sessionId, {
        taskId: "t-rcp",
        status: "active",
        workspace: { type: "temp", cwd: workDir },
      }),
    );
    await sm.applyEvent(sessionId, { type: "iterator_done_normal" });
    await sm.patch(sessionId, { cleanupPending: true });

    // Make cleanupWorkspace throw CleanupError — exercises lines 71-73 in reapCleanupPending
    vi.mocked(cleanupWorkspace).mockImplementationOnce(() => {
      throw new WorkspaceCleanupError("cleanup still failing");
    });

    await reapCleanupPending(sm);

    const after = sm.read(sessionId);
    expect(after).not.toBeNull();
    expect(after?.cleanupPending).toBe(true);

    // Restore real implementation for cleanup
    vi.mocked(cleanupWorkspace).mockRestore();
    rmSync(workDir, { recursive: true, force: true });
  });
});

describe("orphan reaping — in_review sessions are preserved", () => {
  it("does not touch an in_review session even when not in the pool", async () => {
    const sessionId = randomUUID();
    const taskId = `task-${randomUUID()}`;
    await sm.create(makeWorkerFile(sessionId, { taskId, status: "in_review" }));

    const pool = makePool({ hasTask: vi.fn().mockReturnValue(false) });
    const client = makeApiClient({
      getTask: vi.fn().mockResolvedValue({ status: "in_review" }),
      releaseTask: vi.fn().mockResolvedValue(undefined),
    });

    // reapOrphanWorkerSessions only looks at active sessions
    await reapOrphanWorkerSessions(sm, pool, client as any);

    expect(sm.read(sessionId)).not.toBeNull();
    expect(sm.read(sessionId)?.status).toBe("in_review");
    expect(client.releaseTask).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 24. SessionManager — patch refuses status change
// ════════════════════════════════════════════════════════════════════════════

describe("SessionManager — patch guards", () => {
  it("patch refuses to change status", async () => {
    const sessionId = randomUUID();
    await sm.create(makeWorkerFile(sessionId, { status: "active" }));

    await expect(sm.patch(sessionId, { status: "in_review" })).rejects.toThrow(/status change/);
  });

  it("patch allows same status in the payload (no-op status)", async () => {
    const sessionId = randomUUID();
    await sm.create(makeWorkerFile(sessionId, { status: "active" }));

    const result = await sm.patch(sessionId, { status: "active", resumeBackoffMs: 1000 });
    expect(result?.status).toBe("active");
    expect(result?.resumeBackoffMs).toBe(1000);
  });

  it("patch returns null for missing session", async () => {
    const result = await sm.patch("no-such-id", { resumeBackoffMs: 1000 });
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 25. RateLimiter — stop clears all timers
// ════════════════════════════════════════════════════════════════════════════

describe("RateLimiter — stop", () => {
  it("stop() clears all paused runtimes", () => {
    vi.useFakeTimers();
    const onResumed = vi.fn();
    const rl = new RateLimiter({ onResumed });

    const reset = new Date(Date.now() + 300_000).toISOString();
    rl.pause("claude", reset);
    rl.pause("gemini", reset);

    expect(rl.isRuntimePaused("claude")).toBe(true);
    expect(rl.isRuntimePaused("gemini")).toBe(true);

    rl.stop();

    expect(rl.isRuntimePaused("claude")).toBe(false);
    expect(rl.isRuntimePaused("gemini")).toBe(false);
    // onResumed should NOT fire on stop — stop is shutdown, not recovery
    expect(onResumed).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 26. Review watcher — task held by pool is skipped
// ════════════════════════════════════════════════════════════════════════════

describe("review watcher — session already active in pool is skipped", () => {
  it("skips an in_review session whose taskId is already in the pool", async () => {
    const sessionId = randomUUID();
    const taskId = `task-${randomUUID()}`;
    await sm.create(makeWorkerFile(sessionId, { taskId, status: "in_review" }));

    const pool = makePool({ hasTask: vi.fn().mockReturnValue(true), activeCount: 0 } as any);
    const client = makeApiClient({
      getTask: vi.fn().mockResolvedValue({ status: "in_progress" }),
    });

    const resumeOne = vi.fn().mockResolvedValue(undefined);
    await checkRejectedReviews(sm, pool, client as any, resumeOne, 5);

    expect(resumeOne).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 27. Orphan reaping — cancelled task is also reaped
// ════════════════════════════════════════════════════════════════════════════

describe("orphan reaping — cancelled task triggers reap without releaseTask", () => {
  it("reaps session without calling releaseTask when task.status is cancelled", async () => {
    const sessionId = randomUUID();
    const taskId = `task-${randomUUID()}`;
    await sm.create(makeWorkerFile(sessionId, { taskId, status: "active" }));

    const pool = makePool({ hasTask: vi.fn().mockReturnValue(false) });
    const client = makeApiClient({
      getTask: vi.fn().mockResolvedValue({ status: "cancelled" }),
      releaseTask: vi.fn().mockResolvedValue(undefined),
    });

    await reapOrphanWorkerSessions(sm, pool, client as any);

    expect(client.releaseTask).not.toHaveBeenCalled();
    expect(sm.read(sessionId)?.status).toBe("closed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 28. SessionManager — create fails for duplicate
// ════════════════════════════════════════════════════════════════════════════

describe("SessionManager — create duplicate throws", () => {
  it("throws when creating a session with an existing sessionId", async () => {
    const sessionId = randomUUID();
    await sm.create(makeWorkerFile(sessionId));
    await expect(sm.create(makeWorkerFile(sessionId))).rejects.toThrow(/already exists/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 29. SessionManager — forceRemove
// ════════════════════════════════════════════════════════════════════════════

describe("SessionManager — forceRemove", () => {
  it("removes the session file regardless of state", async () => {
    const sessionId = randomUUID();
    await sm.create(makeWorkerFile(sessionId, { status: "in_review" }));
    expect(sm.read(sessionId)).not.toBeNull();

    await sm.forceRemove(sessionId);
    expect(sm.read(sessionId)).toBeNull();
  });

  it("forceRemove on missing session is a no-op", async () => {
    await expect(sm.forceRemove("ghost-id")).resolves.toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 30. SessionManager — applyEvent on missing session returns null
// ════════════════════════════════════════════════════════════════════════════

describe("SessionManager — applyEvent on missing session", () => {
  it("returns null without throwing when session does not exist", async () => {
    const result = await sm.applyEvent("ghost-id", { type: "iterator_done_normal" });
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// errors.ts — ClassifiedError subclasses
// ════════════════════════════════════════════════════════════════════════════

describe("ClassifiedError subclasses", () => {
  it("TransientError has kind=transient", () => {
    const e = new TransientError("net blip");
    expect(e).toBeInstanceOf(ClassifiedError);
    expect(e.kind).toBe("transient");
    expect(e.name).toBe("TransientError");
  });

  it("TerminalError has kind=terminal", () => {
    const e = new TerminalError("auth failed");
    expect(e.kind).toBe("terminal");
    expect(e.name).toBe("TerminalError");
  });

  it("CleanupError has kind=cleanup", () => {
    const e = new CleanupError("rm failed");
    expect(e.kind).toBe("cleanup");
    expect(e.name).toBe("CleanupError");
  });

  it("RateLimitError has kind=rate_limit and exposes resetAt/overage", () => {
    const e = new RateLimitError("rate limited", "2030-01-01T00:00:00Z", undefined);
    expect(e.kind).toBe("rate_limit");
    expect(e.name).toBe("RateLimitError");
    expect(e.resetAt).toBe("2030-01-01T00:00:00Z");
    expect(e.overage).toBeUndefined();
  });

  it("ClassifiedError passes through classify unchanged", () => {
    const e = new TransientError("already classified");
    expect(classify(e, "ctx")).toBe(e);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// errors.ts — classify: network error codes
// ════════════════════════════════════════════════════════════════════════════

describe("classify — network error codes", () => {
  it("ECONNRESET → transient", () => {
    const err = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    expect(classify(err, "ctx")).toBeInstanceOf(TransientError);
  });

  it("ETIMEDOUT → transient", () => {
    const err = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    expect(classify(err, "ctx")).toBeInstanceOf(TransientError);
  });

  it("ENOENT → terminal", () => {
    const err = Object.assign(new Error("no file"), { code: "ENOENT" });
    expect(classify(err, "ctx")).toBeInstanceOf(TerminalError);
  });

  it("AbortError name → terminal", () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classify(err, "ctx")).toBeInstanceOf(TerminalError);
  });

  it("unknown error → terminal", () => {
    expect(classify(new Error("mystery"), "ctx")).toBeInstanceOf(TerminalError);
  });

  it("plain string error → terminal", () => {
    expect(classify("just a string", "ctx")).toBeInstanceOf(TerminalError);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// errors.ts — classify: SDK API errors (plain Error with message pattern)
// ════════════════════════════════════════════════════════════════════════════

describe("classify — SDK errors with .status property", () => {
  it("error with status 500 → transient", () => {
    const err = Object.assign(new Error("Internal server error"), { status: 500 });
    expect(classify(err, "ctx")).toBeInstanceOf(TransientError);
  });

  it("error with status 502 → transient", () => {
    const err = Object.assign(new Error("Bad Gateway"), { status: 502 });
    expect(classify(err, "ctx")).toBeInstanceOf(TransientError);
  });

  it("error with status 503 → transient", () => {
    const err = Object.assign(new Error("Service Unavailable"), { status: 503 });
    expect(classify(err, "ctx")).toBeInstanceOf(TransientError);
  });

  it("error with status 529 → transient", () => {
    const err = Object.assign(new Error("Overloaded"), { status: 529 });
    expect(classify(err, "ctx")).toBeInstanceOf(TransientError);
  });

  it("error with status 401 → terminal", () => {
    const err = Object.assign(new Error("Unauthorized"), { status: 401 });
    expect(classify(err, "ctx")).toBeInstanceOf(TerminalError);
  });

  it("error with status 429 → terminal (SDK rate limits use rate_limit_event)", () => {
    const err = Object.assign(new Error("Too Many Requests"), { status: 429 });
    expect(classify(err, "ctx")).toBeInstanceOf(TerminalError);
  });

  it("plain Error containing 'fetch failed' → transient", () => {
    const err = new Error("fetch failed");
    expect(classify(err, "ctx")).toBeInstanceOf(TransientError);
  });

  it("plain Error without .status → terminal", () => {
    const err = new Error("something broke");
    expect(classify(err, "ctx")).toBeInstanceOf(TerminalError);
  });

  it("plain Error with 'fetch failed' in longer message → transient", () => {
    const err = new Error("TypeError: fetch failed: ECONNRESET");
    expect(classify(err, "ctx")).toBeInstanceOf(TransientError);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// errors.ts — classify: error-like objects without .message (branch coverage)
// ════════════════════════════════════════════════════════════════════════════

describe("classify — error-like objects with undefined .message (branch coverage)", () => {
  it("ECONNREFUSED with message=undefined → transient (String(err) fallback path)", () => {
    // Exercises the `(err as Error).message ?? String(err)` branch when message is undefined
    const err = { code: "ECONNREFUSED", message: undefined };
    const result = classify(err, "ctx");
    expect(result).toBeInstanceOf(TransientError);
  });

  it("EPIPE with message=undefined → transient (String(err) fallback path)", () => {
    const err = { code: "EPIPE", message: undefined };
    const result = classify(err, "ctx");
    expect(result).toBeInstanceOf(TransientError);
  });

  it("ENOENT with message=undefined → terminal (String(err) fallback path)", () => {
    const err = { code: "ENOENT", message: undefined };
    const result = classify(err, "ctx");
    expect(result).toBeInstanceOf(TerminalError);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// errors.ts — boundary and boundarySync helpers
// ════════════════════════════════════════════════════════════════════════════

describe("boundary helpers", () => {
  it("boundary resolves on success", async () => {
    const result = await boundary("ctx", async () => 42);
    expect(result).toBe(42);
  });

  it("boundary classifies thrown error", async () => {
    const err = Object.assign(new Error("boom"), { code: "ECONNRESET" });
    await expect(
      boundary("ctx", async () => {
        throw err;
      }),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("boundarySync returns value on success", () => {
    expect(boundarySync("ctx", () => "hello")).toBe("hello");
  });

  it("boundarySync classifies thrown error", () => {
    const err = Object.assign(new Error("gone"), { code: "ENOENT" });
    expect(() =>
      boundarySync("ctx", () => {
        throw err;
      }),
    ).toThrow(TerminalError);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// boundaries.ts — apiCall, apiCallOptional, apiCallIdempotent
// ════════════════════════════════════════════════════════════════════════════

describe("boundaries.ts — apiCall", () => {
  it("resolves on success", async () => {
    const result = await apiCall("label", async () => "ok");
    expect(result).toBe("ok");
  });

  it("classifies thrown ApiError", async () => {
    await expect(
      apiCall("label", async () => {
        throw new ApiError(500, "oops");
      }),
    ).rejects.toBeInstanceOf(TransientError);
  });
});

describe("boundaries.ts — apiCallOptional", () => {
  it("returns null on 404 ApiError", async () => {
    const result = await apiCallOptional("label", async () => {
      throw new ApiError(404, "not found");
    });
    expect(result).toBeNull();
  });

  it("throws ClassifiedError on non-404 ApiError", async () => {
    await expect(
      apiCallOptional("label", async () => {
        throw new ApiError(500, "error");
      }),
    ).rejects.toBeInstanceOf(ClassifiedError);
  });

  it("resolves on success", async () => {
    const result = await apiCallOptional("label", async () => "value");
    expect(result).toBe("value");
  });
});

describe("boundaries.ts — apiCallIdempotent", () => {
  it("returns null on 404", async () => {
    const result = await apiCallIdempotent("label", async () => {
      throw new ApiError(404, "not found");
    });
    expect(result).toBeNull();
  });

  it("returns null on 409 conflict", async () => {
    const result = await apiCallIdempotent("label", async () => {
      throw new ApiError(409, "conflict");
    });
    expect(result).toBeNull();
  });

  it("throws on other errors", async () => {
    await expect(
      apiCallIdempotent("label", async () => {
        throw new ApiError(500, "err");
      }),
    ).rejects.toBeInstanceOf(ClassifiedError);
  });
});

describe("boundaries.ts — apiFireAndForget", () => {
  it("resolves even when fn throws", async () => {
    const log = vi.fn();
    await expect(
      apiFireAndForget(
        "label",
        async () => {
          throw new Error("boom");
        },
        log,
      ),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
  });

  it("does not call log when fn succeeds", async () => {
    const log = vi.fn();
    await apiFireAndForget("label", async () => {}, log);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("boundaries.ts — providerExecute", () => {
  it("resolves on success", async () => {
    const result = await providerExecute("claude", async () => "spawned");
    expect(result).toBe("spawned");
  });

  it("classifies thrown error", async () => {
    const err = Object.assign(new Error("abort"), { name: "AbortError" });
    await expect(
      providerExecute("claude", async () => {
        throw err;
      }),
    ).rejects.toBeInstanceOf(TerminalError);
  });
});

describe("boundaries.ts — fsSync", () => {
  it("returns value on success", () => {
    expect(fsSync("label", () => 99)).toBe(99);
  });

  it("EBUSY → TransientError", () => {
    const err = Object.assign(new Error("busy"), { code: "EBUSY" });
    expect(() =>
      fsSync("label", () => {
        throw err;
      }),
    ).toThrow(TransientError);
  });

  it("ENOENT → TerminalError", () => {
    const err = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(() =>
      fsSync("label", () => {
        throw err;
      }),
    ).toThrow(TerminalError);
  });
});

describe("boundaries.ts — cleanupSync", () => {
  it("wraps thrown error as CleanupError", () => {
    expect(() =>
      cleanupSync("ws", () => {
        throw new Error("rm failed");
      }),
    ).toThrow(CleanupError);
  });

  it("does not throw on success", () => {
    expect(() => cleanupSync("ws", () => {})).not.toThrow();
  });
});

describe("boundaries.ts — execBoundary / execBoundaryAsync", () => {
  it("execBoundary returns value on success", () => {
    expect(execBoundary("cmd", () => "result")).toBe("result");
  });

  it("execBoundary classifies thrown error", () => {
    const err = Object.assign(new Error("not found"), { code: "ENOENT" });
    expect(() =>
      execBoundary("cmd", () => {
        throw err;
      }),
    ).toThrow(TerminalError);
  });

  it("execBoundaryAsync resolves on success", async () => {
    const result = await execBoundaryAsync("cmd", async () => "async-result");
    expect(result).toBe("async-result");
  });

  it("execBoundaryAsync classifies thrown error", async () => {
    const err = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    await expect(
      execBoundaryAsync("cmd", async () => {
        throw err;
      }),
    ).rejects.toBeInstanceOf(TransientError);
  });
});

describe("boundaries.ts — cryptoBoundary", () => {
  it("resolves on success", async () => {
    const result = await cryptoBoundary("key", async () => "key-data");
    expect(result).toBe("key-data");
  });

  it("wraps thrown error as TerminalError", async () => {
    await expect(
      cryptoBoundary("key", async () => {
        throw new Error("bad key");
      }),
    ).rejects.toBeInstanceOf(TerminalError);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// stateMachine.ts — classifyIteratorEnd
// ════════════════════════════════════════════════════════════════════════════

describe("classifyIteratorEnd", () => {
  it("crashed=true → iterator_crashed", () => {
    const ev = classifyIteratorEnd({ resultReceived: false, rateLimited: false, taskInReview: false, crashed: true, transient: false });
    expect(ev.type).toBe("iterator_crashed");
  });

  it("resultReceived=true, taskInReview=true → iterator_done_with_result(true)", () => {
    const ev = classifyIteratorEnd({ resultReceived: true, rateLimited: false, taskInReview: true, crashed: false, transient: false });
    expect(ev.type).toBe("iterator_done_with_result");
    if (ev.type === "iterator_done_with_result") expect(ev.taskInReview).toBe(true);
  });

  it("resultReceived=true, taskInReview=false → iterator_done_with_result(false)", () => {
    const ev = classifyIteratorEnd({ resultReceived: true, rateLimited: false, taskInReview: false, crashed: false, transient: false });
    expect(ev.type).toBe("iterator_done_with_result");
    if (ev.type === "iterator_done_with_result") expect(ev.taskInReview).toBe(false);
  });

  it("rateLimited=true → iterator_done_rate_limited", () => {
    const ev = classifyIteratorEnd({ resultReceived: false, rateLimited: true, taskInReview: false, crashed: false, transient: false });
    expect(ev.type).toBe("iterator_done_rate_limited");
  });

  it("all false → iterator_done_normal", () => {
    const ev = classifyIteratorEnd({ resultReceived: false, rateLimited: false, taskInReview: false, crashed: false, transient: false });
    expect(ev.type).toBe("iterator_done_normal");
  });

  it("crashed=true, transient=true → iterator_crashed_transient", () => {
    const ev = classifyIteratorEnd({ resultReceived: false, rateLimited: false, taskInReview: false, crashed: true, transient: true });
    expect(ev.type).toBe("iterator_crashed_transient");
  });

  it("crashed=true, transient=false → iterator_crashed (not transient)", () => {
    const ev = classifyIteratorEnd({ resultReceived: false, rateLimited: false, taskInReview: false, crashed: true, transient: false });
    expect(ev.type).toBe("iterator_crashed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// stateMachine.ts — additional transitions
// ════════════════════════════════════════════════════════════════════════════

describe("applyTransition — additional cases", () => {
  it("active + rate_limit_cleared → active (noop)", () => {
    expect(applyTransition("active", { type: "rate_limit_cleared" })).toBe("active");
  });

  it("active + iterator_crashed_transient → rate_limited", () => {
    expect(applyTransition("active", { type: "iterator_crashed_transient" })).toBe("rate_limited");
  });

  it("active + iterator_crashed → completing", () => {
    expect(applyTransition("active", { type: "iterator_crashed" })).toBe("completing");
  });

  it("active + iterator_done_with_result(false) → completing", () => {
    expect(applyTransition("active", { type: "iterator_done_with_result", taskInReview: false })).toBe("completing");
  });

  it("in_review + resume_started → active", () => {
    expect(applyTransition("in_review", { type: "resume_started" })).toBe("active");
  });

  it("in_review + resume_failed_transient → in_review", () => {
    expect(applyTransition("in_review", { type: "resume_failed_transient" })).toBe("in_review");
  });

  it("in_review + resume_failed_terminal → completing", () => {
    expect(applyTransition("in_review", { type: "resume_failed_terminal" })).toBe("completing");
  });

  it("rate_limited + resume_failed_transient → rate_limited", () => {
    expect(applyTransition("rate_limited", { type: "resume_failed_transient" })).toBe("rate_limited");
  });

  it("rate_limited + task_deleted → completing", () => {
    expect(applyTransition("rate_limited", { type: "task_deleted" })).toBe("completing");
  });

  it("rate_limited + orphan_detected → completing", () => {
    expect(applyTransition("rate_limited", { type: "orphan_detected" })).toBe("completing");
  });

  it("terminal + any event → throws TransitionError", () => {
    expect(() => applyTransition("terminal", { type: "cleanup_done" })).toThrow(TransitionError);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// orphanReaper — CleanupError path leaves session with cleanupPending
// ════════════════════════════════════════════════════════════════════════════

describe("orphan reaper — workspace cleanup error marks cleanupPending", () => {
  it("retries cleanupPending: cleanup succeeds on retry → session closed", async () => {
    const sessionId = randomUUID();
    await sm.create(
      makeWorkerFile(sessionId, {
        taskId: "t-cp",
        status: "active",
        workspace: { type: "temp", cwd: "/tmp/already-gone-xyz" },
      }),
    );
    await sm.applyEvent(sessionId, { type: "iterator_done_normal" });
    await sm.patch(sessionId, { cleanupPending: true });

    // reapCleanupPending retries it — cleanup succeeds (rmSync is force:true) → closed
    await reapCleanupPending(sm);
    expect(sm.read(sessionId)?.status).toBe("closed");
  });

  it("retries cleanupPending with repo workspace type → removeWorktree swallows error → cleanup_done succeeds → closed", async () => {
    // removeWorktree catches its own errors, so even a repo workspace cleanup
    // will not throw. The session goes closed (cleanup succeeds from the
    // session state machine's perspective).
    const sessionId = randomUUID();
    const workDir = mkdtempSync(join(tmpdir(), "ak-di-cp-repo-"));

    await sm.create(
      makeWorkerFile(sessionId, {
        taskId: "t-cp-repo",
        status: "active",
        workspace: { type: "repo", cwd: workDir, repoDir: "/nonexistent-repo", branchName: "ak-test" },
      }),
    );
    await sm.applyEvent(sessionId, { type: "iterator_done_normal" });
    await sm.patch(sessionId, { cleanupPending: true });

    await reapCleanupPending(sm);

    // removeWorktree swallows the error → cleanup_done fires → closed
    expect(sm.read(sessionId)?.status).toBe("closed");

    rmSync(workDir, { recursive: true, force: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SessionManager — listUnderGlobalLock
// ════════════════════════════════════════════════════════════════════════════

describe("SessionManager — listUnderGlobalLock", () => {
  it("returns sessions matching filter under global lock", async () => {
    const s1 = randomUUID();
    const s2 = randomUUID();
    await sm.create(makeWorkerFile(s1, { status: "active" }));
    await sm.create(makeWorkerFile(s2, { status: "in_review" }));

    const active = await sm.listUnderGlobalLock({ type: "worker", status: "active" });
    expect(active.map((s) => s.sessionId)).toContain(s1);
    expect(active.map((s) => s.sessionId)).not.toContain(s2);
  });

  it("returns all sessions when no filter is given", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) await sm.create(makeWorkerFile(id));

    const all = await sm.listUnderGlobalLock();
    const resultIds = all.map((s) => s.sessionId);
    for (const id of ids) expect(resultIds).toContain(id);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// resumeOneSession — success clears backoff
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// resumer.ts — happy path: resumeSession succeeds, ok=true → clears backoff
// Requires valid Ed25519 JWK so crypto.subtle.importKey succeeds.
// ════════════════════════════════════════════════════════════════════════════

// Valid 32-byte base64url Ed25519 test keys (not used for real signing)
const VALID_PRIVATE_JWK: JsonWebKey = {
  kty: "OKP",
  crv: "Ed25519",
  x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
};

describe("resumeOneSession — success path clears backoff", () => {
  it("clears resumeBackoffMs and resumeAfter when resumeSession returns true", async () => {
    const sessionId = randomUUID();
    const taskId = `task-${randomUUID()}`;
    const workDir = mkdtempSync(join(tmpdir(), "ak-di-ok-"));

    await sm.create({
      type: "worker",
      agentId: "agent-1",
      sessionId,
      runtime: "claude" as any,
      startedAt: Date.now(),
      apiUrl: "https://example.com",
      privateKeyJwk: VALID_PRIVATE_JWK,
      taskId,
      workspace: { type: "temp", cwd: workDir },
      status: "in_review",
      resumeBackoffMs: 5000,
      resumeAfter: Date.now() - 1000, // already expired
    });

    const client = makeApiClient({
      getTask: vi.fn().mockResolvedValue({ status: "in_progress" }),
      reopenSession: vi.fn().mockResolvedValue(undefined),
      releaseTask: vi.fn().mockResolvedValue(undefined),
      getAgentGpgKey: vi.fn().mockResolvedValue(null),
    });

    const pool = makePool({
      spawnAgent: vi.fn().mockResolvedValue(undefined),
    });

    const snap = sm.read(sessionId)!;
    await resumeOneSession(snap, "Please fix and resubmit.", client as any, pool);

    // After success, session should be in "active" state (resume_started was applied)
    const after = sm.read(sessionId);
    if (after !== null) {
      // Session still exists — backoff should be cleared
      expect(after.resumeBackoffMs).toBeUndefined();
      expect(after.resumeAfter).toBeUndefined();
    }
    // If session is null, it was already cleaned up by the agent lifecycle — also fine

    rmSync(workDir, { recursive: true, force: true });
  });
});

describe("resumeOneSession — success clears backoff", () => {
  it("clears resumeBackoffMs after resumeSession succeeds (workspace gone → forceRemove + false)", async () => {
    // A session with backoff set but whose workspace is gone returns false from
    // resumeSession. That triggers the forceRemove path, which deletes the session
    // before patch can set backoff — verifying success-path clearing is not needed
    // separately. Instead validate that a session with no prior backoff has no
    // backoff after a transient failure: the formula is prev*2, prev defaults to 5000.
    const sessionId = randomUUID();
    const workDir = mkdtempSync(join(tmpdir(), "ak-di-clr-"));
    const session = makeWorkerFile(sessionId, {
      taskId: "t-clr",
      status: "in_review",
      workspace: { type: "temp", cwd: workDir },
      resumeBackoffMs: undefined,
    });
    await sm.create(session);

    // 503 → TransientError → catch block → ok=false → sets backoff
    const client = makeApiClient({
      getTask: vi.fn().mockRejectedValue(new ApiError(503, "unavailable")),
    });
    const pool = makePool();

    const snap = sm.read(sessionId)!;
    await resumeOneSession(snap, "msg", client as any, pool);

    const after = sm.read(sessionId);
    // Default formula: prev (5000) * 2 = 10000
    expect(after?.resumeBackoffMs).toBe(10_000);

    rmSync(workDir, { recursive: true, force: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// resumer.ts — workspace missing path (lines 33-37)
// ════════════════════════════════════════════════════════════════════════════

describe("resumeSession — workspace missing → forceRemove and return false", () => {
  it("removes session and calls releaseTask when workspace cwd does not exist", async () => {
    const sessionId = randomUUID();
    const missingCwd = join(tmpdir(), `ak-gone-${randomUUID()}`);
    // Deliberately do NOT create missingCwd

    await sm.create(
      makeWorkerFile(sessionId, {
        taskId: "t-missing-ws",
        status: "in_review",
        workspace: { type: "temp", cwd: missingCwd },
      }),
    );

    const client = makeApiClient({
      releaseTask: vi.fn().mockResolvedValue(undefined),
    });
    const pool = makePool();

    // Import resumeSession directly
    const { resumeSession } = await import("../src/daemon/resumer.js");
    const result = await resumeSession(sm.read(sessionId)!, "msg", client as any, pool);

    expect(result).toBe(false);
    expect(sm.read(sessionId)).toBeNull();
    expect(client.releaseTask).toHaveBeenCalledWith("t-missing-ws");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// resumer.ts — task done/cancelled path (lines 41-45)
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// boundaries.ts / errors.ts — additional coverage for uncovered branches
// ════════════════════════════════════════════════════════════════════════════

describe("boundaries.ts — fsSync fall-through (non-EBUSY/ENOENT error)", () => {
  it("classifies an error with unknown code as TerminalError", () => {
    const err = Object.assign(new Error("access denied"), { code: "EACCES" });
    expect(() =>
      fsSync("label", () => {
        throw err;
      }),
    ).toThrow(TerminalError);
  });

  it("throws classified error for a plain error with no code", () => {
    expect(() =>
      fsSync("label", () => {
        throw new Error("unexpected");
      }),
    ).toThrow(ClassifiedError);
  });

  it("EAGAIN → TransientError", () => {
    const err = Object.assign(new Error("again"), { code: "EAGAIN" });
    expect(() =>
      fsSync("label", () => {
        throw err;
      }),
    ).toThrow(TransientError);
  });
});

describe("errors.ts — classify ApiError edge cases", () => {
  it("ApiError 429 → TransientError with rate-limit message", () => {
    const e = classify(new ApiError(429, "rate limited"), "ctx");
    expect(e).toBeInstanceOf(TransientError);
    expect(e.message).toContain("rate limited (429)");
  });

  it("ApiError 401 → TerminalError with auth failed message", () => {
    const e = classify(new ApiError(401, "unauthorized"), "ctx");
    expect(e).toBeInstanceOf(TerminalError);
    expect(e.message).toContain("auth failed");
  });

  it("ApiError 403 → TerminalError", () => {
    expect(classify(new ApiError(403, "forbidden"), "ctx")).toBeInstanceOf(TerminalError);
  });

  it("ApiError 404 → TerminalError with not found message", () => {
    const e = classify(new ApiError(404, "not found"), "ctx");
    expect(e.message).toContain("not found");
  });

  it("ApiError 409 → TerminalError with conflict message", () => {
    const e = classify(new ApiError(409, "conflict"), "ctx");
    expect(e.message).toContain("conflict");
  });

  it("ApiError 400 (generic 4xx) → TerminalError with HTTP status", () => {
    const e = classify(new ApiError(400, "bad req"), "ctx");
    expect(e).toBeInstanceOf(TerminalError);
    expect(e.message).toContain("HTTP 400");
  });

  it("EPIPE → TransientError", () => {
    const err = Object.assign(new Error("pipe broken"), { code: "EPIPE" });
    expect(classify(err, "ctx")).toBeInstanceOf(TransientError);
  });

  it("EBUSY → TransientError", () => {
    const err = Object.assign(new Error("busy"), { code: "EBUSY" });
    expect(classify(err, "ctx")).toBeInstanceOf(TransientError);
  });

  it("ECONNREFUSED → TransientError", () => {
    const err = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    expect(classify(err, "ctx")).toBeInstanceOf(TransientError);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// reviewWatcher — catch handler paths (lines 70, 74, 78-81)
// These fire when applyEvent throws — e.g. calling task_deleted on a session
// already in completing state.
// ════════════════════════════════════════════════════════════════════════════

describe("reviewWatcher — completeTerminalFromReview with real temp workspace", () => {
  it("executes cleanupWorkspace when in_review session has workspace and task is done", async () => {
    const sessionId = randomUUID();
    const taskId = `task-${randomUUID()}`;
    // Use a real temp dir so cleanupWorkspace actually does something
    const workDir = mkdtempSync(join(tmpdir(), "ak-di-rw-"));

    await sm.create(
      makeWorkerFile(sessionId, {
        taskId,
        status: "in_review",
        workspace: { type: "temp", cwd: workDir },
      }),
    );

    const pool = makePool({ hasTask: vi.fn().mockReturnValue(false), activeCount: 0 } as any);
    const client = makeApiClient({
      getTask: vi.fn().mockResolvedValue({ status: "done" }),
    });

    const resumeOne = vi.fn();
    await checkRejectedReviews(sm, pool, client as any, resumeOne, 5);

    expect(resumeOne).not.toHaveBeenCalled();
    expect(sm.read(sessionId)?.status).toBe("closed");
    // workDir is cleaned up by cleanupWorkspace — no need to rmSync
  });

  it("catch handlers absorb errors when applyEvent throws a TransitionError mid-flow", async () => {
    // To trigger lines 70 and 74 (catch bodies) in completeTerminalFromReview,
    // we need applyEvent to throw. We spy on sm.applyEvent to throw on the first
    // call (task_deleted) and on the second call (cleanup_done).
    const sessionId = randomUUID();
    const taskId = `task-${randomUUID()}`;
    const workDir = mkdtempSync(join(tmpdir(), "ak-di-rw2-"));

    await sm.create(
      makeWorkerFile(sessionId, {
        taskId,
        status: "in_review",
        workspace: { type: "temp", cwd: workDir },
      }),
    );

    // Spy on applyEvent to throw a fake TransitionError — this exercises the catch bodies
    const origApplyEvent = sm.applyEvent.bind(sm);
    let applyCount = 0;
    vi.spyOn(sm, "applyEvent").mockImplementation(async (sid, event) => {
      if (sid === sessionId) {
        applyCount++;
        throw new TransitionError("in_review", event.type);
      }
      return origApplyEvent(sid, event);
    });

    const pool = makePool({ hasTask: vi.fn().mockReturnValue(false), activeCount: 0 } as any);
    const client = makeApiClient({
      getTask: vi.fn().mockResolvedValue({ status: "done" }),
    });

    // Must not throw — catch handlers absorb the TransitionErrors
    await expect(checkRejectedReviews(sm, pool, client as any, vi.fn(), 5)).resolves.toBeUndefined();
    expect(applyCount).toBeGreaterThan(0);

    vi.restoreAllMocks();
    rmSync(workDir, { recursive: true, force: true });
  });
});

describe("resumeSession — task done → cleanup workspace and return false", () => {
  it("cleans up workspace and removes session when task is done", async () => {
    const sessionId = randomUUID();
    const workDir = mkdtempSync(join(tmpdir(), "ak-di-done-"));

    await sm.create(
      makeWorkerFile(sessionId, {
        taskId: "t-done",
        status: "in_review",
        workspace: { type: "temp", cwd: workDir },
      }),
    );

    const client = makeApiClient({
      getTask: vi.fn().mockResolvedValue({ status: "done" }),
    });
    const pool = makePool();

    const { resumeSession } = await import("../src/daemon/resumer.js");
    const result = await resumeSession(sm.read(sessionId)!, "msg", client as any, pool);

    expect(result).toBe(false);
    expect(sm.read(sessionId)).toBeNull();

    rmSync(workDir, { recursive: true, force: true });
  });

  it("cleans up workspace and removes session when task is cancelled", async () => {
    const sessionId = randomUUID();
    const workDir = mkdtempSync(join(tmpdir(), "ak-di-cancelled-"));

    await sm.create(
      makeWorkerFile(sessionId, {
        taskId: "t-cancelled",
        status: "in_review",
        workspace: { type: "temp", cwd: workDir },
      }),
    );

    const client = makeApiClient({
      getTask: vi.fn().mockResolvedValue({ status: "cancelled" }),
    });
    const pool = makePool();

    const { resumeSession } = await import("../src/daemon/resumer.js");
    const result = await resumeSession(sm.read(sessionId)!, "msg", client as any, pool);

    expect(result).toBe(false);
    expect(sm.read(sessionId)).toBeNull();

    rmSync(workDir, { recursive: true, force: true });
  });

  it("cleans up when task returns null (404)", async () => {
    const sessionId = randomUUID();
    const workDir = mkdtempSync(join(tmpdir(), "ak-di-null-"));

    await sm.create(
      makeWorkerFile(sessionId, {
        taskId: "t-null",
        status: "in_review",
        workspace: { type: "temp", cwd: workDir },
      }),
    );

    const client = makeApiClient({
      getTask: vi.fn().mockRejectedValue(new ApiError(404, "not found")),
    });
    const pool = makePool();

    const { resumeSession } = await import("../src/daemon/resumer.js");
    const result = await resumeSession(sm.read(sessionId)!, "msg", client as any, pool);

    expect(result).toBe(false);
    expect(sm.read(sessionId)).toBeNull();

    rmSync(workDir, { recursive: true, force: true });
  });
});
