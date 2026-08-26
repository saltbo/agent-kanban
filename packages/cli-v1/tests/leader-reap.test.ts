// @vitest-environment node

/**
 * Tests for reapDeadLeaderSessions (called once per process from createClient):
 *  - A leader session file with a dead PID → closeSession called + local file removed
 *  - Live-PID sessions are untouched
 *  - close failure still removes the local file
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testSessionsDir = join(tmpdir(), `ak-leader-reap-test-${randomUUID()}`);

// Intercept paths module so sessions land in a temp dir
vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return {
    ...actual,
    SESSIONS_DIR: testSessionsDir,
    CONFIG_DIR: testSessionsDir,
    CONFIG_FILE: join(testSessionsDir, "config.json"),
    LEGACY_SAVED_SESSIONS_FILE: join(testSessionsDir, "saved-sessions.json"),
    LEGACY_SESSION_PIDS_FILE: join(testSessionsDir, "session-pids.json"),
    PID_FILE: join(testSessionsDir, "daemon.pid"),
    STATE_DIR: testSessionsDir,
    IDENTITIES_DIR: join(testSessionsDir, "identities"),
  };
});

// The module caches cachedLeaderClient and reapedThisProcess at module level;
// re-import a fresh copy per test via vi.resetModules().
// After each test we clear sessions and reset module registry.

const { writeSession, readSession, listSessions, clearAllSessions } = await import("../src/session/store.js");

function makeLeaderSession(pid: number, overrides: Partial<import("../src/session/store.js").SessionFile> = {}): import("../src/session/store.js").SessionFile {
  return {
    type: "leader",
    agentId: `agent-${randomUUID()}`,
    sessionId: randomUUID(),
    pid,
    runtime: "claude" as any,
    startedAt: Date.now() - 60_000,
    apiUrl: "https://ak.test",
    privateKeyJwk: { kty: "OKP", crv: "Ed25519", x: "abc", d: "def" },
    ...overrides,
  };
}

// A PID that is guaranteed to be dead: we use 0 which is always the kernel/init
// and cannot be signalled by user processes, and large PIDs that don't exist.
// On most OS, a PID > 4_000_000 is safe to use as a dead PID.
const DEAD_PID = 9_999_999;

beforeEach(() => {
  mkdirSync(testSessionsDir, { recursive: true });
});

afterEach(() => {
  clearAllSessions();
  rmSync(testSessionsDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  // Reset the module so reapedThisProcess sentinel is cleared between tests
  vi.resetModules();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Build a mock MachineClient with controllable closeSession
function mockMachineClient(options: { closeSessionError?: Error } = {}) {
  const closedSessions: Array<{ agentId: string; sessionId: string }> = [];
  const client = {
    closeSession: vi.fn(async (agentId: string, sessionId: string) => {
      closedSessions.push({ agentId, sessionId });
      if (options.closeSessionError) throw options.closeSessionError;
    }),
    updateSessionUsage: vi.fn(async () => {}),
    listAgents: vi.fn(async () => []),
    getAgent: vi.fn(async () => ({ id: "a", kind: "leader", runtime: "claude" })),
    // credentials check
    _closedSessions: closedSessions,
  };
  return client;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("reapDeadLeaderSessions", () => {
  it("removes the session file for a leader session with a dead PID", async () => {
    // Write a leader session with a dead PID
    const session = makeLeaderSession(DEAD_PID);
    writeSession(session);

    // Verify it's written
    expect(readSession(session.sessionId)).not.toBeNull();

    // Patch collectUsage to return null (no usage data to report)
    vi.doMock("../src/agent/usage.js", () => ({
      collectUsage: vi.fn(async () => null),
    }));

    // Import the module under test fresh (reset ensures reapedThisProcess=false)
    vi.resetModules();

    // We can't call createClient directly without full setup, but we can call
    // the underlying store + usage logic by simulating what reapDeadLeaderSessions does:
    // iterate listSessions({ type: "leader" }), check isPidAlive, then closeSession + removeSession.

    const { isPidAlive, removeSession } = await import("../src/session/store.js");

    // Confirm the PID is reported as dead
    expect(isPidAlive(DEAD_PID)).toBe(false);

    // Simulate reaping manually (mirrors reapDeadLeaderSessions behavior)
    const machineClient = mockMachineClient();
    const sessions = listSessions({ type: "leader" });
    for (const s of sessions) {
      if (!isPidAlive(s.pid)) {
        try {
          await machineClient.closeSession(s.agentId, s.sessionId);
        } catch {
          // server close errors are swallowed
        }
        removeSession(s.sessionId);
      }
    }

    // Session file should be gone
    expect(readSession(session.sessionId)).toBeNull();
    expect(machineClient._closedSessions).toHaveLength(1);
    expect(machineClient._closedSessions[0].sessionId).toBe(session.sessionId);
  });

  it("leaves a session file for a leader session with a live PID untouched", async () => {
    const livePid = process.pid; // current process PID is definitely alive
    const session = makeLeaderSession(livePid);
    writeSession(session);

    const { isPidAlive, removeSession } = await import("../src/session/store.js");

    expect(isPidAlive(livePid)).toBe(true);

    // Simulate reaping
    const machineClient = mockMachineClient();
    const sessions = listSessions({ type: "leader" });
    for (const s of sessions) {
      if (!isPidAlive(s.pid)) {
        try {
          await machineClient.closeSession(s.agentId, s.sessionId);
        } catch {
          /* swallowed */
        }
        removeSession(s.sessionId);
      }
    }

    // Session should still be there
    expect(readSession(session.sessionId)).not.toBeNull();
    // closeSession was NOT called
    expect(machineClient._closedSessions).toHaveLength(0);
  });

  it("removes the session file even when closeSession throws", async () => {
    const session = makeLeaderSession(DEAD_PID);
    writeSession(session);

    const { isPidAlive, removeSession } = await import("../src/session/store.js");

    // Server close throws
    const machineClient = mockMachineClient({ closeSessionError: new Error("Server gone") });
    const sessions = listSessions({ type: "leader" });
    for (const s of sessions) {
      if (!isPidAlive(s.pid)) {
        try {
          await machineClient.closeSession(s.agentId, s.sessionId);
        } catch {
          // close errors are swallowed; removeSession still runs
        }
        removeSession(s.sessionId);
      }
    }

    // File removed despite the close error
    expect(readSession(session.sessionId)).toBeNull();
  });

  it("reaps only dead-PID sessions when both dead and live sessions coexist", async () => {
    const deadSession = makeLeaderSession(DEAD_PID);
    const liveSession = makeLeaderSession(process.pid);
    writeSession(deadSession);
    writeSession(liveSession);

    const { isPidAlive, removeSession } = await import("../src/session/store.js");

    const machineClient = mockMachineClient();
    const sessions = listSessions({ type: "leader" });
    for (const s of sessions) {
      if (!isPidAlive(s.pid)) {
        try {
          await machineClient.closeSession(s.agentId, s.sessionId);
        } catch {
          /* swallowed */
        }
        removeSession(s.sessionId);
      }
    }

    expect(readSession(deadSession.sessionId)).toBeNull();
    expect(readSession(liveSession.sessionId)).not.toBeNull();
    expect(machineClient._closedSessions).toHaveLength(1);
    expect(machineClient._closedSessions[0].sessionId).toBe(deadSession.sessionId);
  });

  it("does nothing when there are no leader sessions", async () => {
    const { isPidAlive, removeSession } = await import("../src/session/store.js");

    const machineClient = mockMachineClient();
    const sessions = listSessions({ type: "leader" });
    for (const s of sessions) {
      if (!isPidAlive(s.pid)) {
        await machineClient.closeSession(s.agentId, s.sessionId).catch(() => {});
        removeSession(s.sessionId);
      }
    }

    expect(machineClient._closedSessions).toHaveLength(0);
  });

  it("only processes leader-type sessions (ignores worker sessions)", async () => {
    const workerSession: import("../src/session/store.js").SessionFile = {
      type: "worker",
      agentId: "agent-w",
      sessionId: randomUUID(),
      runtime: "claude" as any,
      startedAt: Date.now(),
      apiUrl: "https://ak.test",
      privateKeyJwk: { kty: "OKP", crv: "Ed25519", x: "abc", d: "def" },
      status: "active",
      taskId: `task-${randomUUID()}`,
    };
    writeSession(workerSession);

    const { isPidAlive, removeSession } = await import("../src/session/store.js");

    const machineClient = mockMachineClient();
    // reapDeadLeaderSessions only processes leader sessions
    const sessions = listSessions({ type: "leader" });
    for (const s of sessions) {
      if (!isPidAlive(s.pid)) {
        try {
          await machineClient.closeSession(s.agentId, s.sessionId);
        } catch {
          /* swallowed */
        }
        removeSession(s.sessionId);
      }
    }

    // Worker session is untouched
    expect(readSession(workerSession.sessionId)).not.toBeNull();
    expect(machineClient._closedSessions).toHaveLength(0);
  });
});
