// @vitest-environment node

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Intercept the paths module before the module under test is imported ──────
// We point SESSIONS_DIR at a temp directory to avoid touching real state.
const testSessionsDir = join(tmpdir(), `ak-sessions-test-${randomUUID()}`);

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return {
    ...actual,
    SESSIONS_DIR: testSessionsDir,
    LEGACY_SAVED_SESSIONS_FILE: join(testSessionsDir, "saved-sessions.json"),
    LEGACY_SESSION_PIDS_FILE: join(testSessionsDir, "session-pids.json"),
  };
});

// Now import after the mock is registered
const {
  writeSession,
  readSession,
  findLeaderSession,
  removeSession,
  listSessions,
  updateSession,
  isPidAlive,
  clearAllSessions,
  migrateLegacySessions,
} = await import("../src/session/store.js");

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<import("../src/session/store.js").SessionFile> = {}): import("../src/session/store.js").SessionFile {
  return {
    type: "worker",
    agentId: randomUUID(),
    sessionId: randomUUID(),
    pid: process.pid,
    runtime: "claude" as any,
    startedAt: Date.now(),
    apiUrl: "https://example.com",
    privateKeyJwk: { kty: "OKP", crv: "Ed25519", x: "abc", d: "def" },
    ...overrides,
  };
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  mkdirSync(testSessionsDir, { recursive: true });
});

afterEach(() => {
  clearAllSessions();
});

// ── writeSession / readSession ───────────────────────────────────────────────

describe("writeSession / readSession", () => {
  it("persists a session that can be read back by ID", () => {
    const s = makeSession();
    writeSession(s);
    const read = readSession(s.sessionId);
    expect(read).not.toBeNull();
    expect(read!.sessionId).toBe(s.sessionId);
  });

  it("round-trips all fields without data loss", () => {
    const s = makeSession({ type: "leader", taskId: "task-abc", status: "active", model: "claude-opus" });
    writeSession(s);
    expect(readSession(s.sessionId)).toEqual(s);
  });

  it("overwrites an existing session file when called again with the same ID", () => {
    const s = makeSession({ status: "active" });
    writeSession(s);
    writeSession({ ...s, status: "in_review" });
    expect(readSession(s.sessionId)!.status).toBe("in_review");
  });

  it("creates the sessions directory if it does not exist", () => {
    clearAllSessions(); // removes the dir
    const s = makeSession();
    writeSession(s); // must not throw
    expect(readSession(s.sessionId)).not.toBeNull();
  });

  it("stores private session state with owner-only directory and file permissions", () => {
    chmodSync(testSessionsDir, 0o777);
    const session = makeSession();

    writeSession(session);

    expectPosixMode(testSessionsDir, 0o700);
    expectPosixMode(join(testSessionsDir, `${session.sessionId}.json`), 0o600);
  });

  it("repairs broad permissions on an existing sessions directory and file", () => {
    const session = makeSession();
    writeSession(session);
    const path = join(testSessionsDir, `${session.sessionId}.json`);
    chmodSync(testSessionsDir, 0o777);
    chmodSync(path, 0o666);

    writeSession({ ...session, status: "in_review" });

    expectPosixMode(testSessionsDir, 0o700);
    expectPosixMode(path, 0o600);
  });
});

function expectPosixMode(path: string, expected: number): void {
  const stats = statSync(path);
  if (process.platform !== "win32") expect(stats.mode & 0o777).toBe(expected);
}

describe("readSession", () => {
  it("returns null for an unknown session ID", () => {
    expect(readSession("no-such-id")).toBeNull();
  });

  it("returns null when the file is corrupt JSON", () => {
    mkdirSync(testSessionsDir, { recursive: true });
    writeFileSync(join(testSessionsDir, "corrupt.json"), "{ bad json }");
    expect(readSession("corrupt")).toBeNull();
  });
});

// ── findLeaderSession ─────────────────────────────────────────────────────────

describe("findLeaderSession", () => {
  it("returns the leader session whose pid matches", () => {
    const s = makeSession({ type: "leader", pid: 99991 });
    writeSession(s);
    const found = findLeaderSession(99991);
    expect(found).not.toBeNull();
    expect(found!.sessionId).toBe(s.sessionId);
  });

  it("returns null when only a worker session has that pid (does NOT return the worker)", () => {
    const worker = makeSession({ type: "worker", pid: 88881 });
    writeSession(worker);
    expect(findLeaderSession(88881)).toBeNull();
  });

  it("returns null when no session matches the given pid", () => {
    writeSession(makeSession({ type: "leader", pid: 11111 }));
    expect(findLeaderSession(99999)).toBeNull();
  });

  it("returns null when there are no sessions at all", () => {
    expect(findLeaderSession(process.pid)).toBeNull();
  });

  it("returns the leader session even when a worker with the same pid also exists", () => {
    const sharedPid = 77771;
    const worker = makeSession({ type: "worker", pid: sharedPid });
    const leader = makeSession({ type: "leader", pid: sharedPid });
    writeSession(worker);
    writeSession(leader);
    const found = findLeaderSession(sharedPid);
    expect(found).not.toBeNull();
    expect(found!.type).toBe("leader");
    expect(found!.sessionId).toBe(leader.sessionId);
  });
});

// ── removeSession ────────────────────────────────────────────────────────────

describe("removeSession", () => {
  it("removes the session so it can no longer be read", () => {
    const s = makeSession();
    writeSession(s);
    removeSession(s.sessionId);
    expect(readSession(s.sessionId)).toBeNull();
  });

  it("does not throw when the session does not exist", () => {
    expect(() => removeSession("ghost-id")).not.toThrow();
  });
});

// ── listSessions ─────────────────────────────────────────────────────────────

describe("listSessions — no filter", () => {
  it("returns an empty array when no sessions exist", () => {
    expect(listSessions()).toEqual([]);
  });

  it("returns all written sessions", () => {
    writeSession(makeSession());
    writeSession(makeSession());
    expect(listSessions()).toHaveLength(2);
  });

  it("creates the sessions directory if it does not exist", () => {
    clearAllSessions();
    expect(() => listSessions()).not.toThrow();
    expect(listSessions()).toEqual([]);
  });

  it("skips non-.json files", () => {
    mkdirSync(testSessionsDir, { recursive: true });
    writeFileSync(join(testSessionsDir, "README.txt"), "ignore me");
    writeSession(makeSession());
    expect(listSessions()).toHaveLength(1);
  });

  it("skips corrupt JSON files without throwing", () => {
    mkdirSync(testSessionsDir, { recursive: true });
    writeFileSync(join(testSessionsDir, "bad.json"), "{ not valid }");
    const s = makeSession();
    writeSession(s);
    const list = listSessions();
    expect(list).toHaveLength(1);
    expect(list[0].sessionId).toBe(s.sessionId);
  });
});

describe("listSessions — type filter", () => {
  it("returns only worker sessions when filter.type is worker", () => {
    writeSession(makeSession({ type: "worker" }));
    writeSession(makeSession({ type: "leader" }));
    const workers = listSessions({ type: "worker" });
    expect(workers).toHaveLength(1);
    expect(workers[0].type).toBe("worker");
  });

  it("returns only leader sessions when filter.type is leader", () => {
    writeSession(makeSession({ type: "worker" }));
    writeSession(makeSession({ type: "leader" }));
    const leaders = listSessions({ type: "leader" });
    expect(leaders).toHaveLength(1);
    expect(leaders[0].type).toBe("leader");
  });
});

describe("listSessions — status filter", () => {
  it("returns only sessions with the matching status", () => {
    writeSession(makeSession({ status: "active" }));
    writeSession(makeSession({ status: "rate_limited" }));
    const rateLimited = listSessions({ status: "rate_limited" });
    expect(rateLimited).toHaveLength(1);
    expect(rateLimited[0].status).toBe("rate_limited");
  });

  it("returns empty array when no session matches the filter status", () => {
    writeSession(makeSession({ status: "active" }));
    expect(listSessions({ status: "in_review" })).toHaveLength(0);
  });
});

describe("listSessions — combined filter", () => {
  it("filters by both type and status simultaneously", () => {
    writeSession(makeSession({ type: "worker", status: "active" }));
    writeSession(makeSession({ type: "worker", status: "in_review" }));
    writeSession(makeSession({ type: "leader", status: "active" }));
    const results = listSessions({ type: "worker", status: "active" });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("worker");
    expect(results[0].status).toBe("active");
  });
});

// ── updateSession ────────────────────────────────────────────────────────────

describe("updateSession", () => {
  it("merges the given fields into the existing session", () => {
    const s = makeSession({ status: "active", model: "claude-3" });
    writeSession(s);
    const result = updateSession(s.sessionId, { status: "in_review" });
    expect(result).toBe(true);
    expect(readSession(s.sessionId)!.status).toBe("in_review");
    expect(readSession(s.sessionId)!.model).toBe("claude-3");
  });

  it("does nothing when the session does not exist", () => {
    expect(() => updateSession("nonexistent", { status: "active" })).not.toThrow();
  });

  it("returns false when the session does not exist", () => {
    expect(updateSession("nonexistent", { status: "active" })).toBe(false);
  });

  it("preserves fields that are not part of the update", () => {
    const s = makeSession({ agentId: "agent-xyz", taskId: "task-abc" });
    writeSession(s);
    updateSession(s.sessionId, { status: "rate_limited" });
    const updated = readSession(s.sessionId)!;
    expect(updated.agentId).toBe("agent-xyz");
    expect(updated.taskId).toBe("task-abc");
  });
});

// ── isPidAlive ───────────────────────────────────────────────────────────────

describe("isPidAlive", () => {
  it("returns true for the current process PID", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for PID 0 (guard for invalid pid)", () => {
    expect(isPidAlive(0)).toBe(false);
  });

  it("returns false for a PID that is certainly not alive (very large number)", () => {
    // PID 4194304 is beyond the Linux kernel's pid_max and will always be dead.
    expect(isPidAlive(4194304)).toBe(false);
  });

  it("treats EPERM as an existing process", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    expect(isPidAlive(12345)).toBe(true);
  });
});

// ── clearAllSessions ─────────────────────────────────────────────────────────

describe("clearAllSessions", () => {
  it("removes all session files so listSessions returns empty", () => {
    writeSession(makeSession());
    writeSession(makeSession());
    clearAllSessions();
    expect(listSessions()).toHaveLength(0);
  });

  it("does not throw when the sessions directory does not exist", () => {
    clearAllSessions(); // remove dir
    expect(() => clearAllSessions()).not.toThrow();
  });
});

// ── migrateLegacySessions ────────────────────────────────────────────────────

describe("migrateLegacySessions", () => {
  // Helper to write legacy files into the mocked paths
  function writeLegacyFiles(sessions: any[], pids: Record<string, number> = {}): void {
    mkdirSync(testSessionsDir, { recursive: true });
    writeFileSync(join(testSessionsDir, "saved-sessions.json"), JSON.stringify(sessions));
    writeFileSync(join(testSessionsDir, "session-pids.json"), JSON.stringify(pids));
  }

  it("does nothing when no legacy sessions file exists", () => {
    migrateLegacySessions();
    expect(listSessions()).toHaveLength(0);
  });

  it("creates one session file per legacy session entry", () => {
    const id = randomUUID();
    writeLegacyFiles([
      {
        agentId: randomUUID(),
        sessionId: id,
        runtime: "claude",
        privateKeyJwk: {},
        taskId: "task-1",
        workspace: null,
        status: "active",
        model: "claude-opus",
        gpgSubkeyId: null,
        agentUsername: "bot",
        agentName: "Bot",
      },
    ]);
    migrateLegacySessions();
    const sessions = listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(id);
  });

  it("does not populate worker pid field after migration (obsolete)", () => {
    // Worker sessions no longer carry pid — liveness is tracked in-memory
    // by AgentRuntimePool. The legacy pids file is consumed (and deleted) but
    // its values are discarded.
    const id = randomUUID();
    writeLegacyFiles([{ agentId: randomUUID(), sessionId: id, runtime: "claude", privateKeyJwk: {} }], { [id]: 12345 });
    migrateLegacySessions();
    const s = readSession(id);
    expect(s).not.toBeNull();
    expect(s!.pid).toBeUndefined();
  });

  it("defaults status to active when the legacy entry has no status field", () => {
    const id = randomUUID();
    writeLegacyFiles([{ agentId: randomUUID(), sessionId: id, runtime: "claude", privateKeyJwk: {} }]);
    migrateLegacySessions();
    expect(readSession(id)!.status).toBe("active");
  });

  it("sets type to worker for all migrated entries", () => {
    const id = randomUUID();
    writeLegacyFiles([{ agentId: randomUUID(), sessionId: id, runtime: "claude", privateKeyJwk: {} }]);
    migrateLegacySessions();
    expect(readSession(id)!.type).toBe("worker");
  });

  it("removes the legacy sessions file after migration", () => {
    const id = randomUUID();
    writeLegacyFiles([{ agentId: randomUUID(), sessionId: id, runtime: "claude", privateKeyJwk: {} }]);
    migrateLegacySessions();
    expect(existsSync(join(testSessionsDir, "saved-sessions.json"))).toBe(false);
  });

  it("removes the legacy pids file after migration", () => {
    const id = randomUUID();
    writeLegacyFiles([{ agentId: randomUUID(), sessionId: id, runtime: "claude", privateKeyJwk: {} }]);
    migrateLegacySessions();
    expect(existsSync(join(testSessionsDir, "session-pids.json"))).toBe(false);
  });

  it("migrates multiple legacy sessions", () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    writeLegacyFiles(ids.map((id) => ({ agentId: randomUUID(), sessionId: id, runtime: "claude", privateKeyJwk: {} })));
    migrateLegacySessions();
    expect(listSessions()).toHaveLength(3);
  });
});
