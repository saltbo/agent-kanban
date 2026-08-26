// @vitest-environment node
/**
 * Tests for resumeSession() from resumer.ts — focused on Fix 5:
 *   resumeSession() bails out cleanly when workspace.cwd does not exist,
 *   calling forceRemove (via SessionManager) + releaseTask and returning false.
 *
 * The function signature changed from the old TaskRunner class:
 *   old: new TaskRunner(client, pm).resumeSession(session, msg)
 *   new: resumeSession(session, msg, client, pool)  — free function from resumer.ts
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// ── Logger mock ───────────────────────────────────────────────────────────────
vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── sessionStore mock — raw store functions ───────────────────────────────────
// SessionManager uses these internally via rawRemoveSession alias.
const { mockRemoveSession } = vi.hoisted(() => ({ mockRemoveSession: vi.fn() }));
vi.mock("../src/session/store.js", () => ({
  removeSession: mockRemoveSession,
  writeSession: vi.fn(),
  updateSession: vi.fn(),
  readSession: vi.fn().mockReturnValue(null),
  listSessions: vi.fn().mockReturnValue([]),
}));

// ── config mock ───────────────────────────────────────────────────────────────
vi.mock("../src/config.js", () => ({
  getCredentials: vi.fn().mockReturnValue({ apiUrl: "https://example.com" }),
}));

// ── providers/registry mock ───────────────────────────────────────────────────
vi.mock("../src/providers/registry.js", () => ({
  getProvider: vi.fn().mockReturnValue({
    name: "claude",
    label: "Claude Code",
    execute: vi.fn(),
  }),
  normalizeRuntime: vi.fn().mockImplementation((r: string) => r),
}));

// ── systemPrompt mock ─────────────────────────────────────────────────────────
vi.mock("../src/agent/systemPrompt.js", () => ({
  generateSystemPrompt: vi.fn().mockResolvedValue("system prompt"),
  writePromptFile: vi.fn().mockReturnValue("/tmp/prompt.txt"),
  cleanupPromptFile: vi.fn(),
}));

// ── skillManager mock ─────────────────────────────────────────────────────────
vi.mock("../src/workspace/skills.js", () => ({
  ensureSkills: vi.fn().mockResolvedValue(undefined),
}));

// ── workspace mock ────────────────────────────────────────────────────────────
vi.mock("../src/workspace/workspace.js", () => ({
  restoreWorkspace: vi.fn().mockImplementation((info: any) => ({
    cwd: info?.cwd ?? "/tmp/test",
    cleanup: vi.fn(),
  })),
  cleanupWorkspace: vi.fn(),
}));

// ── pool mock ─────────────────────────────────────────────────────────────────
const mockSpawnAgent = vi.fn().mockResolvedValue(undefined);
const mockPool = {
  spawnAgent: mockSpawnAgent,
  hasTask: vi.fn().mockReturnValue(false),
  activeCount: 0,
  activeCountForRuntime: vi.fn().mockReturnValue(0),
  getActiveTaskIds: vi.fn().mockReturnValue([]),
  killTask: vi.fn().mockResolvedValue(undefined),
  killAll: vi.fn().mockResolvedValue(undefined),
  sendToAgent: vi.fn().mockResolvedValue(undefined),
  sendToSession: vi.fn().mockResolvedValue(false),
} as any;

// ── AgentClient mock ──────────────────────────────────────────────────────────
vi.mock("../src/client/index.js", async () => {
  const actual = await vi.importActual<typeof import("../src/client/index.js")>("../src/client/index.js");
  return {
    ...actual,
    AgentClient: vi.fn().mockImplementation(() => ({
      getAgentId: () => "agent-mock",
      getSessionId: () => "session-mock",
      sendMessage: vi.fn(),
      updateSessionUsage: vi.fn(),
    })),
  };
});

import type { ApiClient } from "../src/client/index.js";
import { resumeSession } from "../src/daemon/resumer.js";
import type { SessionFile } from "../src/session/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    releaseTask: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue({ status: "in_review" }),
    reopenSession: vi.fn().mockResolvedValue(undefined),
    getAgentGpgKey: vi.fn().mockResolvedValue({ armored_private_key: "", gpg_subkey_id: null }),
    ...overrides,
  } as unknown as ApiClient;
}

function makeSession(cwdOverride: string, overrides: Partial<SessionFile> = {}): SessionFile {
  return {
    type: "worker",
    agentId: randomUUID(),
    sessionId: randomUUID(),
    runtime: "claude" as any,
    startedAt: Date.now(),
    apiUrl: "https://example.com",
    privateKeyJwk: { kty: "OKP", crv: "Ed25519", x: "abc", d: "def" },
    taskId: randomUUID(),
    status: "in_review",
    workspace: { type: "temp", cwd: cwdOverride },
    ...overrides,
  };
}

// ── Fix 5: resumeSession() cwd guard ─────────────────────────────────────────

describe("resumeSession — missing workspace.cwd", () => {
  it("returns false when workspace.cwd does not exist", async () => {
    const missingCwd = join(tmpdir(), `ak-nonexistent-${randomUUID()}`);
    const session = makeSession(missingCwd);
    const client = makeApiClient();

    const result = await resumeSession(session, "retry after rejection", client, mockPool);

    expect(result).toBe(false);
  });

  it("calls releaseTask with the task ID when workspace.cwd is missing", async () => {
    const missingCwd = join(tmpdir(), `ak-nonexistent-${randomUUID()}`);
    const session = makeSession(missingCwd);
    const client = makeApiClient();

    await resumeSession(session, "retry", client, mockPool);

    expect(client.releaseTask).toHaveBeenCalledWith(session.taskId);
  });

  it("calls forceRemove (removeSession) with the session ID when workspace.cwd is missing", async () => {
    const missingCwd = join(tmpdir(), `ak-nonexistent-${randomUUID()}`);
    const session = makeSession(missingCwd);
    const client = makeApiClient();
    mockRemoveSession.mockClear();

    await resumeSession(session, "retry", client, mockPool);

    expect(mockRemoveSession).toHaveBeenCalledWith(session.sessionId);
  });

  it("does NOT call spawnAgent when workspace.cwd is missing", async () => {
    const missingCwd = join(tmpdir(), `ak-nonexistent-${randomUUID()}`);
    const session = makeSession(missingCwd);
    const client = makeApiClient();
    mockSpawnAgent.mockClear();

    await resumeSession(session, "retry", client, mockPool);

    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });
});

describe("resumeSession — existing workspace.cwd proceeds past the guard", () => {
  it("does not return false immediately when workspace.cwd exists and task is cancelled", async () => {
    // Create a real temp dir so existsSync returns true
    const existingCwd = mkdtempSync(join(tmpdir(), "ak-existing-"));
    try {
      const session = makeSession(existingCwd);
      // Let getTask return a cancelled task so the function bails for a different reason
      const client = makeApiClient({ getTask: vi.fn().mockResolvedValue({ status: "cancelled" }) });

      const result = await resumeSession(session, "retry", client, mockPool);

      // The function returns false for a cancelled task, but the cwd guard
      // was NOT the reason — getTask was called, which proves we got past the guard.
      expect(result).toBe(false);
      expect(client.getTask).toHaveBeenCalledWith(session.taskId);
    } finally {
      try {
        rmdirSync(existingCwd);
      } catch {
        /* ignore */
      }
    }
  });
});
