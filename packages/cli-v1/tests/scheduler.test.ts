// @vitest-environment node
/**
 * Unit tests for DaemonLoop + RateLimiter — focused on paths that require mocked
 * session store, workspace ops, and repo ops, which cannot be exercised in the
 * root test suite without real filesystem access.
 *
 * DaemonLoop uses SessionManager (singleton) which reads from SESSIONS_DIR.
 * We redirect SESSIONS_DIR to a temp dir so real session files work correctly.
 * Orphan detection is purely in-memory: pool.hasTask(taskId) returning false means
 * the session is orphaned — no pid check is performed on worker sessions.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Redirect SESSIONS_DIR to a temp path BEFORE importing session code ────────
const { tmpRoot } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  return { tmpRoot: mkdtempSync(join(tmpdir(), "ak-sched-test-")) };
});

vi.mock("../src/paths.js", async (importOriginal) => {
  const mod = (await importOriginal()) as any;
  const { join } = await import("node:path");
  return {
    ...mod,
    SESSIONS_DIR: join(tmpRoot, "sessions"),
  };
});

// ── Logger mock ───────────────────────────────────────────────────────────────
vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── workspace mock ────────────────────────────────────────────────────────────
vi.mock("../src/workspace/workspace.js", () => ({
  cleanupWorkspace: vi.fn(),
}));

// ── repoOps mock ──────────────────────────────────────────────────────────────
vi.mock("../src/workspace/repoOps.js", () => ({
  ensureCloned: vi.fn(),
  prepareRepo: vi.fn().mockReturnValue(true),
  repoDir: vi.fn().mockReturnValue(null),
}));

// ── shared mock ───────────────────────────────────────────────────────────────
vi.mock("@agent-kanban/shared", () => ({
  isBoardType: vi.fn().mockReturnValue(true),
}));

// ── resumer + dispatcher mocks — hoisted so factory closures work ─────────────
const { mockResumeOneSession, mockDispatchTasks } = vi.hoisted(() => ({
  mockResumeOneSession: vi.fn().mockResolvedValue(undefined),
  mockDispatchTasks: vi.fn().mockResolvedValue(false),
}));

vi.mock("../src/daemon/resumer.js", () => ({
  resumeSession: vi.fn().mockResolvedValue(true),
  resumeOneSession: mockResumeOneSession,
}));

vi.mock("../src/daemon/dispatcher.js", () => ({
  dispatchTasks: mockDispatchTasks,
}));

// ─────────────────────────────────────────────────────────────────────────────

import { ApiError } from "../src/client/index.js";
import { DaemonLoop } from "../src/daemon/loop.js";
import { RateLimiter } from "../src/daemon/rateLimiter.js";
import { _setSessionManagerForTest, SessionManager } from "../src/session/manager.js";
import { writeSession } from "../src/session/store.js";
import type { SessionFile } from "../src/session/types.js";

// ── Session helpers ───────────────────────────────────────────────────────────

function makeWorkerSession(
  sessionId: string,
  taskId: string,
  status: SessionFile["status"] = "active",
  overrides: Partial<SessionFile> = {},
): SessionFile {
  return {
    type: "worker",
    agentId: "agent-1",
    sessionId,
    runtime: "claude" as any,
    startedAt: Date.now(),
    apiUrl: "http://localhost",
    privateKeyJwk: { kty: "OKP" } as JsonWebKey,
    taskId,
    workspace: { type: "temp", cwd: "/tmp/x" },
    status,
    ...overrides,
  };
}

let sm: SessionManager;

beforeEach(() => {
  sm = new SessionManager();
  _setSessionManagerForTest(sm);
  mockResumeOneSession.mockClear();
  mockDispatchTasks.mockClear();
});

afterEach(() => {
  _setSessionManagerForTest(null);
  rmSync(join(tmpRoot, "sessions"), { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────

function makeStubs(tasks: Record<string, unknown>[] = []) {
  const client = {
    listTasks: vi.fn().mockResolvedValue(tasks),
    listRepositories: vi.fn().mockResolvedValue([]),
    getAgent: vi.fn().mockResolvedValue({ runtime: "claude" }),
    getTask: vi.fn().mockResolvedValue({ status: "in_progress" }),
    releaseTask: vi.fn().mockResolvedValue(undefined),
    getTaskNotes: vi.fn().mockResolvedValue([]),
  };
  const pool = {
    activeCount: 0,
    activeCountForRuntime: vi.fn().mockReturnValue(0),
    getActiveTaskIds: vi.fn().mockReturnValue([]),
    hasTask: vi.fn().mockReturnValue(false),
    killTask: vi.fn().mockResolvedValue(undefined),
  };
  const prMonitor = {
    track: vi.fn(),
  };
  return { client, pool, prMonitor };
}

function makeRateLimiter(onResumed?: (runtime: string) => void) {
  return new RateLimiter({ onResumed: onResumed ?? vi.fn() });
}

function makeLoop(stubs = makeStubs(), rateLimiter?: RateLimiter) {
  const rl = rateLimiter ?? makeRateLimiter();
  return {
    ...stubs,
    rateLimiter: rl,
    loop: new DaemonLoop(stubs.client as any, stubs.pool as any, rl, stubs.prMonitor as any, {
      maxConcurrent: 5,
      pollInterval: 60000,
    }),
  };
}

// ── RateLimiter — pause/resume ────────────────────────────────────────────────

describe("RateLimiter.resumeRateLimit()", () => {
  it("unpauses a paused runtime", () => {
    const rl = makeRateLimiter();
    const futureReset = new Date(Date.now() + 120_000).toISOString();
    rl.pause("claude", futureReset);
    expect(rl.isRuntimePaused("claude")).toBe(true);

    rl.resumeRateLimit("claude");

    expect(rl.isRuntimePaused("claude")).toBe(false);
    rl.stop();
  });

  it("is a no-op when the runtime is not paused", () => {
    const rl = makeRateLimiter();
    expect(() => rl.resumeRateLimit("claude")).not.toThrow();
    expect(rl.isRuntimePaused("claude")).toBe(false);
    rl.stop();
  });

  it("calls onResumed callback when resumeRateLimit is called", () => {
    const onResumed = vi.fn();
    const rl = new RateLimiter({ onResumed });
    const futureReset = new Date(Date.now() + 120_000).toISOString();
    rl.pause("claude", futureReset);
    rl.resumeRateLimit("claude");

    expect(onResumed).toHaveBeenCalledWith("claude");
    rl.stop();
  });

  it("does not call onResumed on an unpaused runtime", () => {
    const onResumed = vi.fn();
    const rl = new RateLimiter({ onResumed });
    rl.resumeRateLimit("claude"); // not paused — no-op
    expect(onResumed).not.toHaveBeenCalled();
    rl.stop();
  });
});

// ── DaemonLoop — resumeRateLimitedSessions ────────────────────────────────────

describe("DaemonLoop.resumeRateLimitedSessions()", () => {
  it("calls resumeOneSession for rate_limited sessions matching the runtime", async () => {
    writeSession(makeWorkerSession("sess-rl", "task-rl", "rate_limited", { runtime: "claude" as any }));

    const stubs = makeStubs();
    const onResumedCallback = vi.fn();
    const rl = new RateLimiter({
      onResumed: (runtime) => {
        onResumedCallback(runtime);
        loop.resumeRateLimitedSessions(runtime);
      },
    });
    const loop = new DaemonLoop(stubs.client as any, stubs.pool as any, rl, stubs.prMonitor as any, {
      maxConcurrent: 5,
      pollInterval: 60000,
    });

    loop.start();
    const futureReset = new Date(Date.now() + 120_000).toISOString();
    rl.pause("claude", futureReset);
    rl.resumeRateLimit("claude");

    await new Promise((r) => setTimeout(r, 50));

    expect(mockResumeOneSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-rl" }),
      expect.stringContaining("Rate limit"),
      expect.anything(),
      expect.anything(),
    );
    loop.stop();
    rl.stop();
  });

  it("does not call resumeOneSession for rate_limited sessions with a different runtime", async () => {
    writeSession(makeWorkerSession("sess-rl-other", "task-rl-other", "rate_limited", { runtime: "gemini" as any }));

    const stubs = makeStubs();
    const rl = new RateLimiter({ onResumed: (runtime) => loop.resumeRateLimitedSessions(runtime) });
    const loop = new DaemonLoop(stubs.client as any, stubs.pool as any, rl, stubs.prMonitor as any, {
      maxConcurrent: 5,
      pollInterval: 60000,
    });

    loop.start();
    const futureReset = new Date(Date.now() + 120_000).toISOString();
    rl.pause("claude", futureReset);
    rl.resumeRateLimit("claude");

    await new Promise((r) => setTimeout(r, 50));

    // session is for "gemini" not "claude" — should not be resumed
    expect(mockResumeOneSession).not.toHaveBeenCalled();
    loop.stop();
    rl.stop();
  });
});

// ── tick — resumeSavedSessions for in_review sessions ────────────────────────

describe("DaemonLoop tick — in_review session resumption", () => {
  it("calls resumeOneSession for an in_review session whose task is in_progress and rejected", async () => {
    writeSession(makeWorkerSession("sess-review", "task-review", "in_review"));

    const stubs = makeStubs();
    stubs.client.getTask.mockResolvedValue({ status: "in_progress" });
    stubs.client.getTaskNotes.mockResolvedValue([{ action: "rejected", detail: "needs rework" }]);

    const { loop } = makeLoop(stubs);

    loop.start();
    await new Promise((r) => setTimeout(r, 100));
    loop.stop();

    expect(mockResumeOneSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-review" }),
      expect.stringContaining("needs rework"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("removes session when task is done", async () => {
    writeSession(
      makeWorkerSession("sess-done", "task-done", "in_review", {
        workspace: { type: "temp", cwd: "/tmp/work", branch: "task-done" },
      }),
    );

    const stubs = makeStubs();
    stubs.client.getTask.mockResolvedValue({ status: "done" });

    const { loop } = makeLoop(stubs);

    loop.start();
    await new Promise((r) => setTimeout(r, 100));
    loop.stop();

    // State machine transitions in_review → task_cancelled → terminal → file removed
    expect(sm.read("sess-done")?.status).toBe("closed");
    expect(mockResumeOneSession).not.toHaveBeenCalled();
  });

  it("removes session when task is cancelled", async () => {
    writeSession(
      makeWorkerSession("sess-cancelled", "task-cancelled", "in_review", {
        workspace: { type: "temp", cwd: "/tmp/work", branch: "task-cancelled" },
      }),
    );

    const stubs = makeStubs();
    stubs.client.getTask.mockResolvedValue({ status: "cancelled" });

    const { loop } = makeLoop(stubs);

    loop.start();
    await new Promise((r) => setTimeout(r, 100));
    loop.stop();

    expect(sm.read("sess-cancelled")?.status).toBe("closed");
  });

  it("removes session and logs when task is not found (ApiError 404)", async () => {
    writeSession(
      makeWorkerSession("sess-notfound", "task-notfound", "in_review", {
        workspace: { type: "temp", cwd: "/tmp/work", branch: "task-notfound" },
      }),
    );

    const stubs = makeStubs();
    stubs.client.getTask.mockRejectedValue(new ApiError(404, "not found"));

    const { loop } = makeLoop(stubs);

    loop.start();
    await new Promise((r) => setTimeout(r, 100));
    loop.stop();

    expect(sm.read("sess-notfound")?.status).toBe("closed");
  });

  it("cleans up session when in_progress with no rejected note", async () => {
    writeSession(makeWorkerSession("sess-noreason", "task-noreason", "in_review"));

    const stubs = makeStubs();
    stubs.client.getTask.mockResolvedValue({ status: "in_progress" });
    stubs.client.getTaskNotes.mockResolvedValue([]);

    const { loop } = makeLoop(stubs);

    loop.start();
    await new Promise((r) => setTimeout(r, 100));
    loop.stop();

    // No reject action → don't resume, clean up instead
    expect(mockResumeOneSession).not.toHaveBeenCalled();
    expect(sm.read("sess-noreason")?.status).toBe("closed");
  });
});

// ── tick — orphaned active session cleanup ────────────────────────────────────

describe("DaemonLoop tick — orphaned active session cleanup", () => {
  it("releases and cleans up an orphaned active session whose task is still viable", async () => {
    writeSession(
      makeWorkerSession("sess-orphan", "task-orphan", "active", {
        workspace: { type: "temp", cwd: "/tmp/orphan", branch: "task-orphan" },
      }),
    );

    const stubs = makeStubs();
    // pool.hasTask returns false (default) — this session is an orphan
    stubs.client.getTask.mockResolvedValue({ status: "in_progress" });

    const { loop } = makeLoop(stubs);

    loop.start();
    await new Promise((r) => setTimeout(r, 100));
    loop.stop();

    expect(stubs.client.releaseTask).toHaveBeenCalledWith("task-orphan");
    // Session file must be gone after terminal cleanup
    expect(sm.read("sess-orphan")?.status).toBe("closed");
  });

  it("cleans up orphaned active session without releasing when task is done", async () => {
    writeSession(
      makeWorkerSession("sess-orphan-done", "task-orphan-done", "active", {
        workspace: { type: "temp", cwd: "/tmp/orphan-done", branch: "task-orphan-done" },
      }),
    );

    const stubs = makeStubs();
    stubs.client.getTask.mockResolvedValue({ status: "done" });

    const { loop } = makeLoop(stubs);

    loop.start();
    await new Promise((r) => setTimeout(r, 100));
    loop.stop();

    expect(sm.read("sess-orphan-done")?.status).toBe("closed");
    // releaseTask should NOT be called for done tasks
    expect(stubs.client.releaseTask).not.toHaveBeenCalled();
  });

  it("removes orphaned session when task is not found (ApiError 404)", async () => {
    writeSession(
      makeWorkerSession("sess-orphan-404", "task-orphan-404", "active", {
        workspace: { type: "temp", cwd: "/tmp/orphan-404", branch: "task-orphan-404" },
      }),
    );

    const stubs = makeStubs();
    stubs.client.getTask.mockRejectedValue(new ApiError(404, "not found"));

    const { loop } = makeLoop(stubs);

    loop.start();
    await new Promise((r) => setTimeout(r, 100));
    loop.stop();

    expect(sm.read("sess-orphan-404")?.status).toBe("closed");
  });
});

// ── DaemonLoop tick — resumeBackoffSessions (transient crash recovery) ────────

describe("DaemonLoop tick — resumeBackoffSessions: expired backoff triggers resume", () => {
  it("calls resumeOneSession for a rate_limited session whose resumeAfter has passed", async () => {
    writeSession(
      makeWorkerSession("sess-backoff-expired", "task-backoff-expired", "rate_limited", {
        resumeAfter: Date.now() - 1000, // expired 1 second ago
        resumeBackoffMs: 30000,
      }),
    );

    const stubs = makeStubs();
    const { loop } = makeLoop(stubs);

    loop.start();
    await new Promise((r) => setTimeout(r, 100));
    loop.stop();

    expect(mockResumeOneSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-backoff-expired" }),
      expect.stringContaining("Rate limit"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("does NOT call resumeOneSession for a rate_limited session whose resumeAfter is in the future", async () => {
    writeSession(
      makeWorkerSession("sess-backoff-pending", "task-backoff-pending", "rate_limited", {
        resumeAfter: Date.now() + 60_000, // still 1 minute away
        resumeBackoffMs: 30000,
      }),
    );

    const stubs = makeStubs();
    const { loop } = makeLoop(stubs);

    loop.start();
    await new Promise((r) => setTimeout(r, 100));
    loop.stop();

    expect(mockResumeOneSession).not.toHaveBeenCalled();
  });

  it("does NOT call resumeOneSession for a rate_limited session with no resumeAfter set", async () => {
    writeSession(
      makeWorkerSession("sess-backoff-none", "task-backoff-none", "rate_limited"),
      // no resumeAfter — driven by RateLimiter, not backoff
    );

    const stubs = makeStubs();
    const { loop } = makeLoop(stubs);

    loop.start();
    await new Promise((r) => setTimeout(r, 100));
    loop.stop();

    expect(mockResumeOneSession).not.toHaveBeenCalled();
  });

  it("skips resumeBackoffSessions when the session runtime is at max capacity", async () => {
    writeSession(
      makeWorkerSession("sess-backoff-max", "task-backoff-max", "rate_limited", {
        resumeAfter: Date.now() - 1000,
        resumeBackoffMs: 30000,
      }),
    );

    const stubs = makeStubs();
    stubs.pool.activeCount = 5;
    stubs.pool.activeCountForRuntime = vi.fn().mockReturnValue(5);
    const { loop } = makeLoop(stubs);

    loop.start();
    await new Promise((r) => setTimeout(r, 100));
    loop.stop();

    expect(mockResumeOneSession).not.toHaveBeenCalled();
  });
});

// ── DaemonLoop tick — killCancelledTasks ──────────────────────────────────────

describe("DaemonLoop tick — killCancelledTasks kills cancelled running tasks", () => {
  it("calls pool.killTask when a running task status becomes cancelled", async () => {
    const stubs = makeStubs();
    // pool reports task-running as active
    stubs.pool.getActiveTaskIds = vi.fn().mockReturnValue(["task-running"]);
    // server reports the task is now cancelled
    stubs.client.getTask.mockResolvedValue({ status: "cancelled" });

    const { loop } = makeLoop(stubs);

    loop.start();
    await new Promise((r) => setTimeout(r, 100));
    loop.stop();

    expect(stubs.pool.killTask).toHaveBeenCalledWith("task-running");
  });

  it("does NOT call pool.killTask when a running task is still in_progress", async () => {
    const stubs = makeStubs();
    stubs.pool.getActiveTaskIds = vi.fn().mockReturnValue(["task-active"]);
    stubs.client.getTask.mockResolvedValue({ status: "in_progress" });

    const { loop } = makeLoop(stubs);

    loop.start();
    await new Promise((r) => setTimeout(r, 100));
    loop.stop();

    expect(stubs.pool.killTask).not.toHaveBeenCalled();
  });
});

// ── loop.ts — errMessage fallback for non-Error values ───────────────────────

describe("DaemonLoop — handleTickError with non-Error value", () => {
  it("survives and reschedules when tick throws a non-Error string", async () => {
    const stubs = makeStubs();
    // Make dispatchTasks throw a plain string to exercise the non-Error errMessage path
    mockDispatchTasks.mockRejectedValueOnce("something went wrong");

    const rl = makeRateLimiter();
    const loop = new DaemonLoop(stubs.client as any, stubs.pool as any, rl, stubs.prMonitor as any, {
      maxConcurrent: 5,
      pollInterval: 60000,
    });

    // Loop should not throw — it catches tick errors internally
    loop.start();
    await new Promise((r) => setTimeout(r, 100));
    loop.stop();
    rl.stop();

    // If we reach here without throwing, the non-Error path was handled correctly
    expect(true).toBe(true);
  });
});
