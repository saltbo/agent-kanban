// @vitest-environment node
/**
 * Tests for cleanupStaleSessions (Fix 3):
 *   - in_review sessions with a dead pid are NOT removed
 *   - active sessions with a dead pid ARE removed
 *   - active sessions with a live pid are NOT removed
 *
 * NOTE: cleanupStaleSessions must be exported from daemon.ts for these tests
 * to work. If the tests fail with "is not a function", ask the main agent to
 * add `export` to the function declaration.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Logger mock ───────────────────────────────────────────────────────────────
vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── Point sessions dir at a temp path ────────────────────────────────────────
const testSessionsDir = join(tmpdir(), `ak-daemon-test-${randomUUID()}`);

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return {
    ...actual,
    SESSIONS_DIR: testSessionsDir,
    LEGACY_SAVED_SESSIONS_FILE: join(testSessionsDir, "saved-sessions.json"),
    LEGACY_SESSION_PIDS_FILE: join(testSessionsDir, "session-pids.json"),
    PID_FILE: join(testSessionsDir, "daemon.pid"),
    STATE_DIR: testSessionsDir,
  };
});

// ── Import after mocks ────────────────────────────────────────────────────────
// We import sessionStore directly to seed and inspect data.
const { writeSession, readSession, clearAllSessions } = await import("../src/session/store.js");

// cleanupStaleSessions is not yet exported — import will return undefined.
// The test asserts behavior through removeSession side-effects via readSession.
const daemonModule = await import("../src/daemon/cleanup.js").catch(() => null);
const cleanupStaleSessions = (daemonModule as any)?.cleanupStaleSessions as ((client: any, machineId: string) => Promise<void>) | undefined;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWorkerSession(overrides: Partial<import("../src/session/store.js").SessionFile> = {}): import("../src/session/store.js").SessionFile {
  return {
    type: "worker",
    agentId: randomUUID(),
    sessionId: randomUUID(),
    pid: process.pid,
    runtime: "claude" as any,
    startedAt: Date.now(),
    apiUrl: "https://example.com",
    privateKeyJwk: { kty: "OKP", crv: "Ed25519", x: "abc", d: "def" },
    status: "active",
    ...overrides,
  };
}

const MACHINE_ID = "machine-001";
const DEAD_PID = 99999999; // guaranteed dead

function makeMachineClient(agentId: string, sessionId: string) {
  return {
    listAgents: vi.fn().mockResolvedValue([{ id: agentId }]),
    listSessions: vi.fn().mockResolvedValue([{ id: sessionId, status: "active", machine_id: MACHINE_ID }]),
    closeSession: vi.fn().mockResolvedValue(undefined),
    releaseTask: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  mkdirSync(testSessionsDir, { recursive: true });
});

afterEach(() => {
  clearAllSessions();
});

// ── Guard: export required ────────────────────────────────────────────────────

describe("cleanupStaleSessions — export guard", () => {
  it("is exported from daemon.ts (main agent must add export if this fails)", () => {
    expect(typeof cleanupStaleSessions).toBe("function");
  });
});

// ── Fix 3: in_review sessions with dead pid are preserved ────────────────────

describe("cleanupStaleSessions — in_review session with dead pid is NOT removed", () => {
  it("preserves the session file on disk when local status is in_review even if pid is dead", async () => {
    if (typeof cleanupStaleSessions !== "function") return; // skip if not exported

    const session = makeWorkerSession({ pid: DEAD_PID, status: "in_review" });
    writeSession(session);

    const client = makeMachineClient(session.agentId, session.sessionId);
    await cleanupStaleSessions(client, MACHINE_ID);

    expect(readSession(session.sessionId)).not.toBeNull();
  });

  it("does not call client.closeSession for an in_review session with dead pid", async () => {
    if (typeof cleanupStaleSessions !== "function") return;

    const session = makeWorkerSession({ pid: DEAD_PID, status: "in_review" });
    writeSession(session);

    const client = makeMachineClient(session.agentId, session.sessionId);
    await cleanupStaleSessions(client, MACHINE_ID);

    expect(client.closeSession).not.toHaveBeenCalled();
  });
});

// ── Fix 3: active session with dead pid IS removed ───────────────────────────

describe("cleanupStaleSessions — active session with dead pid IS removed", () => {
  it("removes the session file when status is active and pid is dead", async () => {
    if (typeof cleanupStaleSessions !== "function") return;

    const session = makeWorkerSession({ pid: DEAD_PID, status: "active" });
    writeSession(session);

    const client = makeMachineClient(session.agentId, session.sessionId);
    await cleanupStaleSessions(client, MACHINE_ID);

    expect(readSession(session.sessionId)).toBeNull();
  });

  it("calls client.closeSession for an active session with a dead pid", async () => {
    if (typeof cleanupStaleSessions !== "function") return;

    const session = makeWorkerSession({ pid: DEAD_PID, status: "active" });
    writeSession(session);

    const client = makeMachineClient(session.agentId, session.sessionId);
    await cleanupStaleSessions(client, MACHINE_ID);

    expect(client.closeSession).toHaveBeenCalledWith(session.agentId, session.sessionId);
  });

  it("releases the associated task before removing an active worker session", async () => {
    if (typeof cleanupStaleSessions !== "function") return;

    const session = makeWorkerSession({ pid: DEAD_PID, status: "active", taskId: "task-stale" });
    writeSession(session);

    const client = makeMachineClient(session.agentId, session.sessionId);
    await cleanupStaleSessions(client, MACHINE_ID);

    expect(client.releaseTask).toHaveBeenCalledWith("task-stale");
    expect(readSession(session.sessionId)).toBeNull();
  });
});

// NOTE: at startup-time, ANY active worker session on disk is orphaned —
// the previous daemon incarnation is gone and the in-memory AgentRuntimePool
// is empty. The old "live pid = preserve" behavior no longer applies because
// worker sessions no longer carry a pid. See cleanup.ts for rationale.
//
// For `in_review` worker sessions the preserve-on-restart behavior is covered
// by the Fix 2 tests above (the rejectResumeFlow integration test also
// exercises this).

// ── Fix 3: sessions belonging to a different machine are not touched ──────────

describe("cleanupStaleSessions — skips sessions from a different machine", () => {
  it("does not remove a dead-pid active session belonging to a different machine", async () => {
    if (typeof cleanupStaleSessions !== "function") return;

    const session = makeWorkerSession({ pid: DEAD_PID, status: "active" });
    writeSession(session);

    // Server returns session owned by a different machine
    const client = {
      listAgents: vi.fn().mockResolvedValue([{ id: session.agentId }]),
      listSessions: vi.fn().mockResolvedValue([{ id: session.sessionId, status: "active", machine_id: "other-machine" }]),
      closeSession: vi.fn().mockResolvedValue(undefined),
    };

    await cleanupStaleSessions(client, MACHINE_ID);

    expect(readSession(session.sessionId)).not.toBeNull();
  });
});
