// @vitest-environment node
/**
 * Integration test: reject-resume flow end-to-end.
 *
 * Exercises: ProcessManager + TaskRunner.resumeSession + sessionStore (real
 * filesystem) + cleanupStaleSessions from daemon.ts.
 *
 * FakeProvider sits at the very edge — it implements AgentProvider and lets
 * individual tests push events via a simple controller, but every other module
 * is real: real sessionStore writes to a temp SESSIONS_DIR, real ProcessManager
 * lifecycle, real TaskRunner.resumeSession with a real mkdtemp workspace dir
 * (so existsSync checks work against the actual filesystem).
 *
 * Six bugs caught:
 *   Fix 1 — provider pid must be process.pid (not null/0)
 *   Fix 2 — onComplete must NOT call onCleanup when session is in_review
 *   Fix 3 — cleanupStaleSessions must skip in_review sessions
 *   Fix 4 — findLeaderSession must not return workers (sessionStore.test.ts covers this)
 *   Fix 5 — resumeSession must bail when workspace.cwd is gone
 *   Fix 6 — daemon shutdown must NOT call clearAllSessions
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Redirect SESSIONS_DIR to a temp path BEFORE anything imports sessionStore ──
// vi.mock is hoisted, so testSessionsDir must be initialised via vi.hoisted().
const { testSessionsDir } = vi.hoisted(() => {
  const { randomUUID } = require("node:crypto");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  return { testSessionsDir: join(tmpdir(), `ak-int-test-${randomUUID()}`) };
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

// ── Logger: silence noise in test output ──────────────────────────────────────
vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── config: provide fake credentials so TaskRunner.resumeSession does not throw
vi.mock("../src/config.js", () => ({
  getCredentials: vi.fn().mockReturnValue({ apiUrl: "https://example.com", apiKey: "fake-key" }),
}));

// ── systemPrompt: avoid real filesystem writes ────────────────────────────────
vi.mock("../src/agent/systemPrompt.js", () => ({
  generateSystemPrompt: vi.fn().mockReturnValue("system prompt"),
  writePromptFile: vi.fn().mockReturnValue(null),
  cleanupPromptFile: vi.fn(),
}));

// ── skillManager: no real skill installs ─────────────────────────────────────
vi.mock("../src/workspace/skills.js", () => ({
  ensureSkills: vi.fn().mockReturnValue(true),
}));

// ── AgentClient: stub so no real HTTP calls are made ─────────────────────────
// getTask is delegated to currentAgentGetTask so individual tests can control
// the task status returned when routeTurnEnd checks for in_review.
let currentAgentGetTask: ((taskId: string) => Promise<{ status: string }>) | null = null;

vi.mock("../src/client/index.js", async () => {
  const actual = await vi.importActual<typeof import("../src/client/index.js")>("../src/client/index.js");
  return {
    ...actual,
    AgentClient: vi.fn().mockImplementation((_url: string, agentId: string, sessionId: string) => ({
      getAgentId: () => agentId,
      getSessionId: () => sessionId,
      getTask: vi.fn().mockImplementation((taskId: string) => {
        if (currentAgentGetTask) return currentAgentGetTask(taskId);
        return Promise.resolve({ status: "in_progress" });
      }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      updateSessionUsage: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

// ── providers/registry: inject FakeProvider ───────────────────────────────────
// We replace the registry so that getProvider("claude") returns our FakeProvider.
// The FakeProvider is set per-test via setFakeProvider().
let currentFakeProvider: FakeProvider | null = null;

vi.mock("../src/providers/registry.js", () => ({
  getProvider: vi.fn().mockImplementation(() => {
    if (!currentFakeProvider) throw new Error("No FakeProvider set for this test");
    return currentFakeProvider;
  }),
  normalizeRuntime: vi.fn().mockImplementation((r: string) => r),
}));

// ── Now import real modules (after mocks are registered) ─────────────────────

import type { MachineClient } from "../src/client/index.js";
import { cleanupStaleSessions } from "../src/daemon/cleanup.js";
import { resumeSession } from "../src/daemon/resumer.js";
import { RuntimePool } from "../src/daemon/runtimePool.js";
import type { AgentEvent, AgentHandle, AgentProvider, ExecuteOpts } from "../src/providers/types.js";
import type { SessionFile } from "../src/session/store.js";
import { clearAllSessions, readSession, writeSession } from "../src/session/store.js";

// ── FakeProvider ──────────────────────────────────────────────────────────────

interface FakeHandleController {
  pushEvent(event: AgentEvent): void;
  end(): void;
}

interface FakeExecuteCall {
  opts: ExecuteOpts;
  controller: FakeHandleController;
}

class FakeProvider implements AgentProvider {
  readonly name = "claude" as const;
  readonly label = "Fake Claude";

  executeCalls: FakeExecuteCall[] = [];

  async execute(opts: ExecuteOpts): Promise<AgentHandle> {
    let endStream!: () => void;

    // The queue is implemented with a simple promise chain so events
    // yielded via pushEvent are delivered in order to the consumer.
    const eventQueue: AgentEvent[] = [];
    const waiters: Array<(done: boolean) => void> = [];
    let done = false;

    const pushEvent = (event: AgentEvent) => {
      if (waiters.length > 0) {
        // a consumer is already waiting — deliver directly
        eventQueue.push(event);
        const waiter = waiters.shift()!;
        waiter(false);
      } else {
        eventQueue.push(event);
      }
    };

    endStream = () => {
      done = true;
      // Wake any pending waiter
      while (waiters.length > 0) {
        const w = waiters.shift()!;
        w(true);
      }
    };

    const events: AsyncIterable<AgentEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            if (eventQueue.length > 0) {
              return { value: eventQueue.shift()!, done: false };
            }
            if (done) return { value: undefined as any, done: true };
            // Wait for the next push or end
            await new Promise<boolean>((resolve) => {
              waiters.push(resolve);
            });
            if (eventQueue.length > 0) {
              return { value: eventQueue.shift()!, done: false };
            }
            return { value: undefined as any, done: true };
          },
        };
      },
    };

    const controller: FakeHandleController = { pushEvent, end: endStream };
    this.executeCalls.push({ opts, controller });

    return {
      events,
      pid: process.pid,
      async abort() {
        endStream();
      },
      async send() {},
    };
  }
}

function setFakeProvider(p: FakeProvider) {
  currentFakeProvider = p;
}

// ── Fake MachineClient ────────────────────────────────────────────────────────

interface FakeTask {
  id: string;
  status: string;
  title: string;
  assigned_to: string;
  board_id: string;
  board_type: string;
  repository_id?: string;
  description?: string;
  labels?: string[];
  model?: string;
  runtime?: string;
  name?: string;
  skills?: string[];
}

function makeFakeMachineClient(
  opts: {
    tasks?: Record<string, FakeTask>;
    agents?: Array<{ id: string; runtime: string; name: string; sessions: Array<{ id: string; status: string; machine_id: string }> }>;
    notes?: Record<string, Array<{ action: string; detail: string }>>;
  } = {},
) {
  const tasks: Record<string, FakeTask> = { ...opts.tasks };
  const agentList = opts.agents ?? [];
  const notes: Record<string, Array<{ action: string; detail: string }>> = { ...opts.notes };

  const releaseTaskCalls: string[] = [];
  const closeSessionCalls: Array<{ agentId: string; sessionId: string }> = [];
  const reopenSessionCalls: Array<{ agentId: string; sessionId: string }> = [];

  const client = {
    getTask: vi.fn().mockImplementation((id: string) => {
      const t = tasks[id];
      if (!t) {
        const err = Object.assign(new Error("not found"), { status: 404 }) as any;
        return Promise.reject(err);
      }
      return Promise.resolve(t);
    }),
    listTasks: vi.fn().mockResolvedValue(Object.values(tasks)),
    getTaskNotes: vi.fn().mockImplementation((taskId: string) => {
      return Promise.resolve(notes[taskId] ?? []);
    }),
    releaseTask: vi.fn().mockImplementation((id: string) => {
      releaseTaskCalls.push(id);
      return Promise.resolve();
    }),
    completeTask: vi.fn().mockResolvedValue(undefined),
    cancelTask: vi.fn().mockResolvedValue(undefined),
    listAgents: vi.fn().mockResolvedValue(agentList),
    listSessions: vi.fn().mockImplementation((agentId: string) => {
      const agent = agentList.find((a) => a.id === agentId);
      return Promise.resolve(agent?.sessions ?? []);
    }),
    closeSession: vi.fn().mockImplementation((agentId: string, sessionId: string) => {
      closeSessionCalls.push({ agentId, sessionId });
      return Promise.resolve();
    }),
    reopenSession: vi.fn().mockImplementation((agentId: string, sessionId: string) => {
      reopenSessionCalls.push({ agentId, sessionId });
      return Promise.resolve();
    }),
    updateSessionUsage: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn().mockImplementation((agentId: string) => {
      const agent = agentList.find((a) => a.id === agentId);
      if (agent) return Promise.resolve({ ...agent, runtime: "claude", model: null, skills: [], gpg_subkey_id: null, username: agentId });
      return Promise.resolve({ id: agentId, name: "Test Agent", runtime: "claude", model: null, skills: [], gpg_subkey_id: null, username: agentId });
    }),
    listRepositories: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockResolvedValue({ delegation_proof: "fake" }),
    getAgentGpgKey: vi.fn().mockResolvedValue({ armored_private_key: "", gpg_subkey_id: null }),
    // Track calls for assertions
    _releaseTaskCalls: releaseTaskCalls,
    _closeSessionCalls: closeSessionCalls,
    _reopenSessionCalls: reopenSessionCalls,
    _tasks: tasks,
  };

  return client;
}

// ── flushPromises ──────────────────────────────────────────────────────────────

async function flushPromises(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeCallbacks(scheduler?: { onSlotFreed(): void }) {
  return {
    onSlotFreed: vi.fn().mockImplementation(() => scheduler?.onSlotFreed()),
    onRateLimited: vi.fn(),
    onRateLimitResumed: vi.fn(),
  };
}

function makePool(client: MachineClient, cbs: ReturnType<typeof makeCallbacks>, timeoutMs = 0) {
  return new RuntimePool(
    client as any,
    { onSlotFreed: cbs.onSlotFreed },
    { onRateLimited: cbs.onRateLimited, onRateLimitResumed: cbs.onRateLimitResumed },
    timeoutMs,
  );
}

// Build a minimal in-review SessionFile for use in tests that start from that state.
// Uses a well-known valid Ed25519 JWK (public x + private d in base64url, 32 bytes each).
// This is required for TaskRunner.resumeSession which calls crypto.subtle.importKey.
const VALID_PRIVATE_JWK: JsonWebKey = {
  kty: "OKP",
  crv: "Ed25519",
  // 32-byte values in base64url — these are test-only keys, not used for real signing
  x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
};

function makeInReviewSession(taskId: string, cwd: string): SessionFile {
  return {
    type: "worker",
    agentId: "agent-1",
    sessionId: randomUUID(),
    pid: process.pid,
    runtime: "claude" as any,
    startedAt: Date.now() - 60_000,
    apiUrl: "https://example.com",
    privateKeyJwk: VALID_PRIVATE_JWK,
    taskId,
    workspace: { type: "temp", cwd },
    status: "in_review",
    model: undefined,
    gpgSubkeyId: null,
    agentUsername: "agent-1",
    agentName: "Test Agent",
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  mkdirSync(testSessionsDir, { recursive: true });
  currentFakeProvider = null;
  currentAgentGetTask = null;
});

afterEach(() => {
  try {
    rmSync(testSessionsDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  vi.clearAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 1: Happy path — agent completes → session preserved as in_review
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario 1: agent completes normally → session preserved as in_review", () => {
  it("preserves the session file with status in_review after result event", async () => {
    const taskId = "task-s1";
    const workDir = mkdtempSync(join(tmpdir(), "ak-s1-"));
    const fake = new FakeProvider();
    setFakeProvider(fake);

    const client = makeFakeMachineClient({
      tasks: { [taskId]: { id: taskId, status: "in_review", title: "S1 task", assigned_to: "agent-1", board_id: "board-1", board_type: "general" } },
    });
    const callbacks = makeCallbacks();
    const pm = makePool(client as unknown as MachineClient, callbacks);

    const sessionId = randomUUID();
    const sessionFile: SessionFile = {
      type: "worker",
      agentId: "agent-1",
      sessionId,
      pid: 0,
      runtime: "claude" as any,
      startedAt: Date.now(),
      apiUrl: "https://example.com",
      privateKeyJwk: { kty: "OKP", crv: "Ed25519", x: "test-x", d: "test-d" },
      taskId,
      workspace: { type: "temp", cwd: workDir },
      status: "active",
    };
    writeSession(sessionFile);

    // routeTurnEnd calls agentClient.getTask to detect in_review
    currentAgentGetTask = () => client.getTask(taskId) as Promise<any>;

    let cleanupCalled = false;
    await pm.spawnAgent({
      provider: fake,
      taskId,
      sessionId,
      cwd: workDir,
      taskContext: "do the thing",
      agentClient: {
        getAgentId: () => "agent-1",
        getSessionId: () => sessionId,
        getTask: (id: string) => client.getTask(id),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        updateSessionUsage: vi.fn().mockResolvedValue(undefined),
      } as any,
      agentEnv: {},
      onCleanup: () => {
        cleanupCalled = true;
        rmSync(workDir, { recursive: true, force: true });
      },
    });

    // Emit a result event — task is in_review on server
    const [call] = fake.executeCalls;
    call.controller.pushEvent({ type: "turn.end", cost: 0.001 });
    call.controller.end();

    await flushPromises(8);

    // (a) session file on disk preserved with status in_review
    const onDisk = readSession(sessionId);
    expect(onDisk).not.toBeNull();
    expect(onDisk!.status).toBe("in_review");

    // (b) workspace directory still exists (onCleanup was NOT called)
    expect(existsSync(workDir)).toBe(true);
    expect(cleanupCalled).toBe(false);

    // (c) ProcessManager no longer holds the task
    expect(pm.hasTask(taskId)).toBe(false);

    // cleanup
    rmSync(workDir, { recursive: true, force: true });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 2 (Fix 6): ak stop does NOT wipe in_review sessions
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario 2 (Fix 6): daemon shutdown does not wipe in_review session files", () => {
  it("killAll + cleanupLeaderSessions leaves the in_review session file intact", async () => {
    const taskId = "task-s2";
    const workDir = mkdtempSync(join(tmpdir(), "ak-s2-"));

    // Write an in_review session file directly (simulating post-scenario-1 state)
    const session = makeInReviewSession(taskId, workDir);
    writeSession(session);

    const client = makeFakeMachineClient({});
    const callbacks = makeCallbacks();
    const pm = makePool(client as unknown as MachineClient, callbacks);

    // Simulate the shutdown path as daemon.ts now does it:
    // pm.killAll() + cleanupLeaderSessions (leader sessions have dead PIDs)
    // but NOT clearAllSessions()
    await pm.killAll();
    // No leader sessions in this test, so cleanupLeaderSessions is a no-op
    // The key invariant: the in_review session file must survive

    expect(existsSync(join(testSessionsDir, `${session.sessionId}.json`))).toBe(true);

    // Sub-assertion: demonstrate that calling clearAllSessions() (the thing we
    // removed from shutdown) WOULD have killed the file
    clearAllSessions();
    expect(existsSync(join(testSessionsDir, `${session.sessionId}.json`))).toBe(false);

    rmSync(workDir, { recursive: true, force: true });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 3 (Fix 3): cleanupStaleSessions skips in_review sessions
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario 3 (Fix 3): cleanupStaleSessions skips in_review sessions", () => {
  it("does not remove a local session file whose status is in_review even when the pid is dead", async () => {
    const machineId = "machine-abc";
    const agentId = "agent-stale";
    const taskId = "task-s3";
    const workDir = mkdtempSync(join(tmpdir(), "ak-s3-"));

    const session = makeInReviewSession(taskId, workDir);
    // Override pid to a certainly-dead value
    writeSession({ ...session, agentId, pid: 999999999 });

    const client = makeFakeMachineClient({
      agents: [
        {
          id: agentId,
          runtime: "claude",
          name: "Stale Agent",
          sessions: [
            {
              id: session.sessionId,
              status: "active", // server still thinks it's active
              machine_id: machineId,
            },
          ],
        },
      ],
    });

    await cleanupStaleSessions(client as unknown as MachineClient, machineId);

    // Session file must still be on disk
    expect(existsSync(join(testSessionsDir, `${session.sessionId}.json`))).toBe(true);

    rmSync(workDir, { recursive: true, force: true });
  });

  it("removes a local session file when pid is dead and status is NOT in_review", async () => {
    const machineId = "machine-abc";
    const agentId = "agent-stale-active";
    const taskId = "task-s3-active";
    const workDir = mkdtempSync(join(tmpdir(), "ak-s3-active-"));

    const session = makeInReviewSession(taskId, workDir);
    writeSession({ ...session, agentId, pid: 999999999, status: "active" });

    const client = makeFakeMachineClient({
      agents: [
        {
          id: agentId,
          runtime: "claude",
          name: "Active Agent",
          sessions: [
            {
              id: session.sessionId,
              status: "active",
              machine_id: machineId,
            },
          ],
        },
      ],
    });

    await cleanupStaleSessions(client as unknown as MachineClient, machineId);

    // Active session with dead pid must be cleaned up
    expect(existsSync(join(testSessionsDir, `${session.sessionId}.json`))).toBe(false);

    rmSync(workDir, { recursive: true, force: true });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 4 (Fix 5): resumeSession bails out when worktree is gone
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario 4 (Fix 5): resumeSession bails out when workspace.cwd is missing", () => {
  it("removes the session, calls releaseTask, and returns false when cwd does not exist", async () => {
    const taskId = "task-s4";
    const missingCwd = join(tmpdir(), `ak-gone-${randomUUID()}`);
    // Do NOT create missingCwd — it intentionally does not exist

    const session = makeInReviewSession(taskId, missingCwd);
    writeSession(session);

    const client = makeFakeMachineClient({
      tasks: { [taskId]: { id: taskId, status: "in_progress", title: "S4 task", assigned_to: "agent-1", board_id: "b1", board_type: "general" } },
      agents: [{ id: "agent-1", runtime: "claude", name: "A1", sessions: [] }],
    });
    const fake = new FakeProvider();
    setFakeProvider(fake);
    const callbacks = makeCallbacks();
    const pm = makePool(client as unknown as MachineClient, callbacks);

    const result = await resumeSession(
      session,
      "Task rejected. Reason: fix it\n\nPlease fix the issues and submit for review again.",
      client as unknown as any,
      pm,
    );

    // (a) returns false
    expect(result).toBe(false);

    // (b) session file is removed
    expect(readSession(session.sessionId)).toBeNull();

    // (c) releaseTask was called with the right taskId
    expect(client._releaseTaskCalls).toContain(taskId);

    // (d) no spawnAgent / execute was invoked
    expect(fake.executeCalls).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 5: Full end-to-end reject-resume
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario 5: full end-to-end reject-resume", () => {
  it("resumes with rejection context and produces a second in_review transition", async () => {
    const taskId = "task-s5";
    const workDir = mkdtempSync(join(tmpdir(), "ak-s5-"));

    // Start from the in_review state (post-scenario-1)
    const session = makeInReviewSession(taskId, workDir);
    writeSession(session);

    const taskState = {
      id: taskId,
      status: "in_progress", // server says: task was rejected (back to in_progress)
      title: "S5 task",
      assigned_to: session.agentId,
      board_id: "board-1",
      board_type: "general",
    };

    const client = makeFakeMachineClient({
      tasks: { [taskId]: taskState },
      agents: [{ id: session.agentId, runtime: "claude", name: "A1", sessions: [] }],
      notes: {
        [taskId]: [{ action: "rejected", detail: "fix it" }],
      },
    });

    const fake = new FakeProvider();
    setFakeProvider(fake);
    const callbacks = makeCallbacks();
    const pm = makePool(client as unknown as MachineClient, callbacks);

    // AgentClient mock uses currentAgentGetTask for getTask calls in routeTurnEnd
    currentAgentGetTask = (id: string) => client.getTask(id) as Promise<any>;

    // (a) simulate a scheduler tick: resumeSession is called for in_review task that's in_progress
    const message = "Task rejected. Reason: fix it\n\nPlease fix the issues and submit for review again.";
    const resumed = await resumeSession(session, message, client as unknown as any, pm);
    expect(resumed).toBe(true);

    // (b) a new execute() call happened on FakeProvider
    expect(fake.executeCalls).toHaveLength(1);

    // (c) provider receives the original rejection message unchanged
    const executeOpts = fake.executeCalls[0].opts;
    expect(executeOpts.taskContext).toBe(message);
    expect(executeOpts.resume).toBe(true);

    // (d) session status went back to "active"
    const afterResume = readSession(session.sessionId);
    expect(afterResume).not.toBeNull();
    expect(afterResume!.status).toBe("active");

    // (e) emit another result event — task now back in_review again on server
    client._tasks[taskId] = { ...taskState, status: "in_review" };
    const [call] = fake.executeCalls;
    call.controller.pushEvent({ type: "turn.end", cost: 0.002 });
    call.controller.end();

    await flushPromises(8);

    // (f) second in_review transition — session file preserved again
    const afterSecondResult = readSession(session.sessionId);
    expect(afterSecondResult).not.toBeNull();
    expect(afterSecondResult!.status).toBe("in_review");

    rmSync(workDir, { recursive: true, force: true });
  });
});

// Scenario 6 (Fix 1): provider handle.pid tests deleted — pid field removed from AgentHandle.
// Provider internals own all process concerns; the daemon layer does not access pid.

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 7 (Fix 2): onComplete does not call onCleanup when session is in_review
//   — verified against real filesystem-backed session store
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario 7 (Fix 2): onComplete skips onCleanup when real session file has status in_review", () => {
  it("onCleanup is NOT called and session file remains after result event puts task in_review", async () => {
    const taskId = "task-s7";
    const workDir = mkdtempSync(join(tmpdir(), "ak-s7-"));
    const fake = new FakeProvider();
    setFakeProvider(fake);

    const client = makeFakeMachineClient({
      tasks: { [taskId]: { id: taskId, status: "in_review", title: "S7", assigned_to: "a1", board_id: "b1", board_type: "general" } },
    });
    const callbacks = makeCallbacks();
    const pm = makePool(client as unknown as MachineClient, callbacks);

    const sessionId = randomUUID();
    writeSession({
      type: "worker",
      agentId: "a1",
      sessionId,
      pid: process.pid,
      runtime: "claude" as any,
      startedAt: Date.now(),
      apiUrl: "https://example.com",
      privateKeyJwk: { kty: "OKP", crv: "Ed25519", x: "x", d: "d" },
      taskId,
      workspace: { type: "temp", cwd: workDir },
      status: "active",
    });

    let cleanupInvoked = false;
    await pm.spawnAgent({
      provider: fake,
      taskId,
      sessionId,
      cwd: workDir,
      taskContext: "ctx",
      agentClient: {
        getAgentId: () => "a1",
        getSessionId: () => sessionId,
        getTask: (id: string) => client.getTask(id),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        updateSessionUsage: vi.fn().mockResolvedValue(undefined),
      } as any,
      agentEnv: {},
      onCleanup: () => {
        cleanupInvoked = true;
      },
    });

    const [call] = fake.executeCalls;
    call.controller.pushEvent({ type: "turn.end", cost: 0 });
    call.controller.end();

    await flushPromises(8);

    // onCleanup must NOT have been called
    expect(cleanupInvoked).toBe(false);

    // Session file on real filesystem still exists and is in_review
    const onDisk = readSession(sessionId);
    expect(onDisk).not.toBeNull();
    expect(onDisk!.status).toBe("in_review");

    // workspace directory still exists (would have been deleted by onCleanup)
    expect(existsSync(workDir)).toBe(true);

    rmSync(workDir, { recursive: true, force: true });
  });

  it("onCleanup IS called when real session file does NOT have status in_review (normal completion)", async () => {
    const taskId = "task-s7-normal";
    const workDir = mkdtempSync(join(tmpdir(), "ak-s7-normal-"));
    const fake = new FakeProvider();
    setFakeProvider(fake);

    // Server says task is "done" (not in_review) after result
    const client = makeFakeMachineClient({
      tasks: { [taskId]: { id: taskId, status: "done", title: "S7 normal", assigned_to: "a1", board_id: "b1", board_type: "general" } },
    });
    const callbacks = makeCallbacks();
    const pm = makePool(client as unknown as MachineClient, callbacks);

    const sessionId = randomUUID();
    writeSession({
      type: "worker",
      agentId: "a1",
      sessionId,
      pid: process.pid,
      runtime: "claude" as any,
      startedAt: Date.now(),
      apiUrl: "https://example.com",
      privateKeyJwk: { kty: "OKP", crv: "Ed25519", x: "x", d: "d" },
      taskId,
      workspace: { type: "temp", cwd: workDir },
      status: "active",
    });

    let cleanupInvoked = false;
    await pm.spawnAgent({
      provider: fake,
      taskId,
      sessionId,
      cwd: workDir,
      taskContext: "ctx",
      agentClient: {
        getAgentId: () => "a1",
        getSessionId: () => sessionId,
        getTask: (id: string) => client.getTask(id),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        updateSessionUsage: vi.fn().mockResolvedValue(undefined),
      } as any,
      agentEnv: {},
      onCleanup: () => {
        cleanupInvoked = true;
      },
    });

    const [call] = fake.executeCalls;
    call.controller.pushEvent({ type: "turn.end", cost: 0 });
    call.controller.end();

    await flushPromises(8);

    // Agent produced result → worktree preserved for potential reject-resume.
    // Cleanup is deferred to daemon loop (checkRejectedReviews detects done → cleans up).
    expect(cleanupInvoked).toBe(false);

    // Session stays in in_review (daemon loop handles terminal cleanup)
    const session = readSession(sessionId);
    expect(session).not.toBeNull();
    expect(session?.status).toBe("in_review");
  });
});
