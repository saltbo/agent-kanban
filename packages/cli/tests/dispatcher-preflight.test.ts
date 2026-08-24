// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cleanupPromptFile: vi.fn(),
  writePromptFile: vi.fn(() => "/tmp/prompt.md"),
  ensureSubagents: vi.fn(async () => true),
  ensureCloned: vi.fn(),
  prepareRepo: vi.fn(() => true),
  prepareSkillSnapshots: vi.fn(() => [{ ref: "owner/repo@skill", skill: "skill", contentHash: "hash", objectDir: "/cache/hash" }]),
  materializeSkillSnapshots: vi.fn(() => true),
  createRepoWorkspace: vi.fn(),
  workspaceCleanup: vi.fn(),
  sessionCreate: vi.fn(async () => {}),
  sessionForceRemove: vi.fn(async () => {}),
  provider: { name: "codex", checkAvailability: vi.fn(async () => ({ status: "ready" })) },
}));

vi.mock("../src/agent/systemPrompt.js", () => ({
  cleanupPromptFile: mocks.cleanupPromptFile,
  generateSystemPrompt: vi.fn(() => "prompt"),
  writePromptFile: mocks.writePromptFile,
}));

vi.mock("../src/client/index.js", () => ({
  AgentClient: class AgentClient {},
}));

vi.mock("../src/config.js", () => ({ getCredentials: () => ({ apiUrl: "http://ak.test", apiKey: "machine-key" }) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock("../src/providers/registry.js", () => ({
  getAvailableProviders: () => [mocks.provider],
  getProvider: () => mocks.provider,
  normalizeRuntime: (runtime: string) => runtime,
}));
vi.mock("../src/session/manager.js", () => ({
  getSessionManager: () => ({ create: mocks.sessionCreate, forceRemove: mocks.sessionForceRemove }),
}));
vi.mock("../src/workspace/agents.js", () => ({ ensureSubagents: mocks.ensureSubagents }));
vi.mock("../src/workspace/repoOps.js", () => ({
  ensureCloned: mocks.ensureCloned,
  isLocalRepoUrl: () => false,
  prepareDirectRepo: vi.fn(() => true),
  prepareRepo: mocks.prepareRepo,
  repoDir: () => "/repos/project",
}));
vi.mock("../src/workspace/skills.js", () => ({
  materializeSkillSnapshots: mocks.materializeSkillSnapshots,
  prepareSkillSnapshots: mocks.prepareSkillSnapshots,
}));
vi.mock("../src/workspace/workspace.js", () => ({
  acquireDirectRepoDir: vi.fn(),
  createDirectRepoWorkspace: vi.fn(),
  createRepoWorkspace: mocks.createRepoWorkspace,
  createTempWorkspace: vi.fn(),
  isDirectRepoDirInUse: () => false,
}));
vi.mock("../src/daemon/boundaries.js", () => ({
  apiCallIdempotent: async (_name: string, fn: () => unknown) => await fn(),
  apiCallOptional: async (_name: string, fn: () => unknown) => {
    try {
      return await fn();
    } catch {
      return null;
    }
  },
  cryptoBoundary: async (_name: string, fn: () => unknown) => await fn(),
  execBoundary: (_name: string, fn: () => unknown) => fn(),
  fsSync: (_name: string, fn: () => unknown) => fn(),
}));
vi.mock("../src/daemon/runtimeOverrides.js", () => ({ isRuntimeLimitIgnored: () => false }));

import { dispatchTasks } from "../src/daemon/dispatcher.js";

function task() {
  return {
    id: "task-1",
    title: "Dispatch safely",
    description: "test",
    labels: [],
    status: "todo",
    assigned_to: "agent-1",
    blocked: false,
    repository_id: "repo-1",
    board_id: "board-1",
    board_type: "dev",
    metadata: {},
  };
}

function agent() {
  return {
    id: "agent-1",
    name: "Codex Worker",
    username: "codex-worker",
    runtime: "codex",
    status: { schedulable: true },
    skills: ["owner/repo@skill"],
    subagents: ["sub-1"],
  };
}

function harness(overrides: Record<string, unknown> = {}) {
  const client = {
    listTasks: vi.fn(async () => [task()]),
    listRepositories: vi.fn(async () => [{ id: "repo-1", url: "https://github.com/owner/repo" }]),
    getAgent: vi.fn(async () => agent()),
    listSubagents: vi.fn(async () => [{ id: "sub-1", name: "Helper", username: "helper", role: "helper", soul: "help", models: {} }]),
    getTask: vi.fn(async () => ({ status: "in_progress" })),
    createSession: vi.fn(async () => ({ ok: true })),
    releaseTask: vi.fn(async () => undefined),
    closeSession: vi.fn(async () => undefined),
    ...overrides,
  };
  const pool = {
    hasTask: vi.fn(() => false),
    activeCountForRuntime: vi.fn(() => 0),
    spawnAgent: vi.fn(async () => undefined),
  };
  const rateLimiter = { isRuntimePaused: vi.fn(() => false) };
  const prMonitor = { track: vi.fn() };
  return { client, pool, rateLimiter, prMonitor };
}

async function dispatch(h: ReturnType<typeof harness>) {
  return dispatchTasks(h.client as any, h.pool as any, h.rateLimiter as any, h.prMonitor as any, { maxConcurrent: 2, pollInterval: 5000 });
}

describe("dispatcher preparation transaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepareRepo.mockReturnValue(true);
    mocks.prepareSkillSnapshots.mockReturnValue([{ ref: "owner/repo@skill", skill: "skill", contentHash: "hash", objectDir: "/cache/hash" }]);
    mocks.ensureSubagents.mockResolvedValue(true);
    mocks.materializeSkillSnapshots.mockReturnValue(true);
    mocks.writePromptFile.mockReturnValue("/tmp/prompt.md");
    mocks.createRepoWorkspace.mockReturnValue({
      cwd: "/worktrees/task",
      info: { type: "repo", cwd: "/worktrees/task", repoDir: "/repos/project", branchName: "ak/task" },
      cleanup: mocks.workspaceCleanup,
    });
  });

  it("completes skill and subagent preflight before creating a worktree", async () => {
    const h = harness();
    await expect(dispatch(h)).resolves.toBe(true);

    expect(mocks.prepareSkillSnapshots.mock.invocationCallOrder[0]).toBeLessThan((h.client.listSubagents as any).mock.invocationCallOrder[0]);
    expect((h.client.listSubagents as any).mock.invocationCallOrder[0]).toBeLessThan(mocks.createRepoWorkspace.mock.invocationCallOrder[0]);
  });

  it.each(["skills", "subagents"])("does not create a worktree or branch when %s preflight fails", async (phase) => {
    const h = harness(phase === "subagents" ? { listSubagents: vi.fn(async () => []) } : {});
    if (phase === "skills") mocks.prepareSkillSnapshots.mockReturnValue(null);

    await expect(dispatch(h)).resolves.toBe(false);

    expect(mocks.createRepoWorkspace).not.toHaveBeenCalled();
    expect(h.client.createSession).not.toHaveBeenCalled();
    expect(h.pool.spawnAgent).not.toHaveBeenCalled();
  });

  it("persists the local session immediately after workspace creation", async () => {
    const h = harness();
    await dispatch(h);

    expect(mocks.createRepoWorkspace.mock.invocationCallOrder[0]).toBeLessThan(mocks.sessionCreate.mock.invocationCallOrder[0]);
    expect(mocks.sessionCreate.mock.invocationCallOrder[0]).toBeLessThan(mocks.materializeSkillSnapshots.mock.invocationCallOrder[0]);
  });

  it("cleans workspace and both local/remote session state when materialization fails", async () => {
    mocks.materializeSkillSnapshots.mockReturnValue(false);
    const h = harness();

    await expect(dispatch(h)).resolves.toBe(false);

    expect(mocks.workspaceCleanup).toHaveBeenCalledOnce();
    expect(mocks.sessionForceRemove).toHaveBeenCalledOnce();
    expect(h.client.releaseTask).toHaveBeenCalledWith("task-1");
    expect(h.client.closeSession).toHaveBeenCalledOnce();
    expect(h.pool.spawnAgent).not.toHaveBeenCalled();
  });

  it("cleans prompt, workspace, local session, and remote state when spawn fails", async () => {
    const h = harness();
    h.pool.spawnAgent.mockRejectedValueOnce(new Error("spawn failed"));

    await expect(dispatch(h)).resolves.toBe(false);

    expect(mocks.cleanupPromptFile).toHaveBeenCalledOnce();
    expect(mocks.workspaceCleanup).toHaveBeenCalledOnce();
    expect(mocks.sessionForceRemove).toHaveBeenCalledOnce();
    expect(h.client.releaseTask).toHaveBeenCalledWith("task-1");
    expect(h.client.closeSession).toHaveBeenCalledOnce();
  });

  it("uses preparingTaskIds to suppress a concurrent duplicate dispatch", async () => {
    let releaseSubagent!: (value: unknown) => void;
    const subagentPending = new Promise((resolve) => {
      releaseSubagent = resolve;
    });
    const listSubagents = vi.fn(() => subagentPending);
    const h = harness({ listSubagents });

    const first = dispatch(h);
    await vi.waitFor(() => expect(listSubagents).toHaveBeenCalledOnce());
    await expect(dispatch(h)).resolves.toBe(false);
    expect(mocks.createRepoWorkspace).not.toHaveBeenCalled();

    releaseSubagent([{ id: "sub-1", name: "Helper", username: "helper", role: "helper", soul: "help", models: {} }]);
    await expect(first).resolves.toBe(true);
    expect(mocks.createRepoWorkspace).toHaveBeenCalledOnce();
  });

  it.each([
    "listTasks",
    "getAgent",
    "checkAvailability",
  ])("serializes overlapping ticks while the first tick awaits %s before task reservation", async (phase) => {
    let releaseBarrier!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      releaseBarrier = resolve;
    });
    let barrier = vi.fn(() => pending);
    const overrides: Record<string, unknown> = {};
    if (phase === "listTasks") overrides.listTasks = barrier;
    if (phase === "getAgent") {
      barrier = vi
        .fn()
        .mockImplementationOnce(() => pending)
        .mockResolvedValue(agent());
      overrides.getAgent = barrier;
    }
    if (phase === "checkAvailability") mocks.provider.checkAvailability.mockImplementationOnce(barrier as any);
    const h = harness(overrides);

    const first = dispatch(h);
    await vi.waitFor(() => expect(barrier).toHaveBeenCalledOnce());
    await expect(dispatch(h)).resolves.toBe(false);
    expect(mocks.createRepoWorkspace).not.toHaveBeenCalled();

    if (phase === "listTasks") releaseBarrier([task()]);
    else if (phase === "getAgent") releaseBarrier(agent());
    else releaseBarrier({ status: "ready" });
    await expect(first).resolves.toBe(true);

    expect(barrier).toHaveBeenCalledTimes(phase === "getAgent" ? 2 : 1);
    expect(mocks.createRepoWorkspace).toHaveBeenCalledOnce();
  });
});
