// @vitest-environment node
/**
 * Tests for `get agent` command handler in commands/get.ts.
 *
 * Covers list mode and agent lookup:
 *   - `ak get agent` (no id) → calls listAgents with worker filter
 *   - `ak get agent <id>`    → calls getAgent directly, no filtering
 *   - `ak get agent <username>` → lists versions for that username when no id exists
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock createClient before importing the command ────────────────────────────

const mockGetAgent = vi.fn();
const mockListAgents = vi.fn();
const mockGetSubagent = vi.fn();
const mockListSubagents = vi.fn();
const mockGetRepository = vi.fn();
const mockListRepositories = vi.fn();
const mockClient = {
  getAgent: mockGetAgent,
  listAgents: mockListAgents,
  getSubagent: mockGetSubagent,
  listSubagents: mockListSubagents,
  getRepository: mockGetRepository,
  listRepositories: mockListRepositories,
};
const mockCreateClient = vi.fn(() => Promise.resolve(mockClient));

vi.mock("../src/agent/leader.js", () => ({
  createClient: mockCreateClient,
}));

vi.mock("../src/output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/output.js")>();
  return {
    ...actual,
    getOutputFormat: vi.fn(() => "text"),
    output: vi.fn(),
    formatTask: vi.fn(),
    formatTaskList: vi.fn(),
    formatTaskListWide: vi.fn(),
    formatBoard: vi.fn(),
    formatBoardList: vi.fn(),
    formatAgent: vi.fn(),
    formatAgentList: vi.fn(),
    formatSubagent: vi.fn(),
    formatSubagentList: vi.fn(),
    formatRepository: vi.fn(),
    formatRepositoryList: vi.fn(),
    formatTaskNotes: vi.fn(),
  };
});

const { registerGetCommand } = await import("../src/commands/get.js");
const outputModule = await import("../src/output.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerGetCommand(program);
  return program;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Restore getOutputFormat default after clearAllMocks wipes it
  vi.mocked(outputModule.getOutputFormat).mockReturnValue("text");
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as any);
});

afterEach(() => {
  exitSpy.mockRestore();
});

// ── Tests: list mode ──────────────────────────────────────────────────────────

describe("get agent — list mode filtering", () => {
  it("calls listAgents once with worker kind filter", async () => {
    mockListAgents.mockResolvedValue([]);
    await makeProgram().parseAsync(["get", "agent"], { from: "user" });
    expect(mockListAgents).toHaveBeenCalledWith({ kind: "worker" });
  });

  it("passes through agents returned by the API", async () => {
    mockListAgents.mockResolvedValue([
      { id: "a1", kind: "worker", name: "Alice" },
      { id: "a3", kind: "worker", name: "Bob" },
    ]);
    await makeProgram().parseAsync(["get", "agent"], { from: "user" });
    const passed = vi.mocked(outputModule.output).mock.calls[0][0] as any[];
    expect(passed).toHaveLength(2);
    expect(passed.map((a: any) => a.id)).toEqual(["a1", "a3"]);
  });

  it("passes an empty array when the API returns no workers", async () => {
    mockListAgents.mockResolvedValue([]);
    await makeProgram().parseAsync(["get", "agent"], { from: "user" });
    const passed = vi.mocked(outputModule.output).mock.calls[0][0] as any[];
    expect(passed).toHaveLength(0);
  });

  it("does not call getAgent in list mode", async () => {
    mockListAgents.mockResolvedValue([]);
    await makeProgram().parseAsync(["get", "agent"], { from: "user" });
    expect(mockGetAgent).not.toHaveBeenCalled();
  });

  it("does not call process.exit in list mode", async () => {
    mockListAgents.mockResolvedValue([]);
    await makeProgram().parseAsync(["get", "agent"], { from: "user" });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("filters workers by role", async () => {
    mockListAgents.mockResolvedValue([{ id: "a1", kind: "worker", name: "Alice", role: "qa" }]);
    await makeProgram().parseAsync(["get", "agent", "--role", "qa"], { from: "user" });
    expect(mockListAgents).toHaveBeenCalledWith({ kind: "worker", role: "qa" });
    const passed = vi.mocked(outputModule.output).mock.calls[0][0] as any[];
    expect(passed.map((a: any) => a.id)).toEqual(["a1"]);
  });

  it("filters workers by runtime", async () => {
    mockListAgents.mockResolvedValue([{ id: "a1", kind: "worker", name: "Alice", runtime: "codex" }]);
    await makeProgram().parseAsync(["get", "agent", "--runtime", "copilot"], { from: "user" });
    expect(mockListAgents).toHaveBeenCalledWith({ kind: "worker", runtime: "copilot" });
    const passed = vi.mocked(outputModule.output).mock.calls[0][0] as any[];
    expect(passed.map((a: any) => a.id)).toEqual(["a1"]);
  });

  it("filters workers by runtime availability", async () => {
    mockListAgents.mockResolvedValue([{ id: "a1", kind: "worker", name: "Alice", status: { schedulable: true } }]);
    await makeProgram().parseAsync(["get", "agent", "--available"], { from: "user" });
    expect(mockListAgents).toHaveBeenCalledWith({ kind: "worker", available: "true" });
    const passed = vi.mocked(outputModule.output).mock.calls[0][0] as any[];
    expect(passed.map((a: any) => a.id)).toEqual(["a1"]);
  });

  it("combines role, runtime, and availability filters", async () => {
    mockListAgents.mockResolvedValue([{ id: "a1", kind: "worker", name: "Alice", role: "qa", runtime: "codex", status: { schedulable: true } }]);
    await makeProgram().parseAsync(["get", "agent", "--role", "qa", "--runtime", "codex", "--available"], { from: "user" });
    expect(mockListAgents).toHaveBeenCalledWith({ kind: "worker", role: "qa", runtime: "codex", available: "true" });
    const passed = vi.mocked(outputModule.output).mock.calls[0][0] as any[];
    expect(passed.map((a: any) => a.id)).toEqual(["a1"]);
  });
});

describe("get repo", () => {
  it("lists board repositories when --board is provided", async () => {
    mockListRepositories.mockResolvedValue([{ id: "repo-1", name: "Repo", url: "https://github.com/org/repo" }]);
    await makeProgram().parseAsync(["get", "repo", "--board", "board-1"], { from: "user" });
    expect(mockListRepositories).toHaveBeenCalledWith({ board_id: "board-1" });
    expect(mockGetRepository).not.toHaveBeenCalled();
  });

  it("fetches one repository by id", async () => {
    mockGetRepository.mockResolvedValue({ id: "repo-1", name: "Repo", url: "https://github.com/org/repo" });
    await makeProgram().parseAsync(["get", "repo", "repo-1"], { from: "user" });
    expect(mockGetRepository).toHaveBeenCalledWith("repo-1");
    expect(mockListRepositories).not.toHaveBeenCalled();
  });
});

// ── Tests: single-agent fetch ─────────────────────────────────────────────────

describe("get agent — single agent fetch by ID", () => {
  it("calls getAgent with the provided id", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent-99", name: "Solo", kind: "worker" });
    await makeProgram().parseAsync(["get", "agent", "agent-99"], { from: "user" });
    expect(mockGetAgent).toHaveBeenCalledWith("agent-99");
  });

  it("does not call listAgents when an id is provided", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent-99", name: "Solo", kind: "worker" });
    await makeProgram().parseAsync(["get", "agent", "agent-99"], { from: "user" });
    expect(mockListAgents).not.toHaveBeenCalled();
  });

  it("does not call process.exit when an id is provided", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent-99", name: "Solo", kind: "worker" });
    await makeProgram().parseAsync(["get", "agent", "agent-99"], { from: "user" });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("works when the fetched agent has kind === 'leader' (no filtering on single fetch)", async () => {
    const leaderAgent = { id: "leader-1", name: "TopDog", kind: "leader" };
    mockGetAgent.mockResolvedValue(leaderAgent);
    await makeProgram().parseAsync(["get", "agent", "leader-1"], { from: "user" });
    expect(mockGetAgent).toHaveBeenCalledWith("leader-1");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("get agent — username version list", () => {
  it("lists versions when the argument is a username", async () => {
    mockGetAgent.mockRejectedValue({ status: 404, message: "Not found" });
    mockListAgents.mockResolvedValue([
      { id: "agent-1", username: "alex-kim", version: "abc123def4", name: "Alex Kim", created_at: "2026-01-01T00:00:00Z" },
      { id: "agent-latest", username: "alex-kim", version: "latest", name: "Alex Kim", created_at: "2026-01-02T00:00:00Z" },
      { id: "agent-other", username: "riley", version: "abc123def4", name: "Riley" },
    ]);

    await makeProgram().parseAsync(["get", "agent", "alex-kim"], { from: "user" });

    expect(mockGetAgent).toHaveBeenCalledWith("alex-kim");
    expect(mockListAgents).toHaveBeenCalledOnce();
    expect(vi.mocked(outputModule.output)).toHaveBeenCalledWith(
      {
        username: "alex-kim",
        versions: [
          {
            id: "agent-latest",
            username: "alex-kim",
            version: "latest",
            name: "Alex Kim",
            created_at: "2026-01-02T00:00:00Z",
          },
          { id: "agent-1", username: "alex-kim", version: "abc123def4", name: "Alex Kim", created_at: "2026-01-01T00:00:00Z" },
        ],
      },
      "text",
      expect.any(Function),
      { kind: "agent" },
    );
  });
});

describe("get subagent", () => {
  it("lists subagents when no id is provided", async () => {
    mockListSubagents.mockResolvedValue([
      { id: "subagent-1", name: "Reviewer", username: "reviewer" },
      { id: "subagent-2", name: "Test Writer", username: "test-writer" },
    ]);

    await makeProgram().parseAsync(["get", "subagent"], { from: "user" });

    expect(mockListSubagents).toHaveBeenCalledOnce();
    expect(mockGetSubagent).not.toHaveBeenCalled();
    expect(vi.mocked(outputModule.output)).toHaveBeenCalledWith(
      [
        { id: "subagent-1", name: "Reviewer", username: "reviewer" },
        { id: "subagent-2", name: "Test Writer", username: "test-writer" },
      ],
      "text",
      vi.mocked(outputModule.formatSubagentList),
      { kind: "subagent" },
    );
  });

  it("gets a subagent by id", async () => {
    mockGetSubagent.mockResolvedValue({ id: "subagent-1", name: "Reviewer", username: "reviewer" });

    await makeProgram().parseAsync(["get", "subagent", "subagent-1"], { from: "user" });

    expect(mockGetSubagent).toHaveBeenCalledWith("subagent-1");
    expect(mockListSubagents).not.toHaveBeenCalled();
    expect(vi.mocked(outputModule.output)).toHaveBeenCalledWith(
      { id: "subagent-1", name: "Reviewer", username: "reviewer" },
      "text",
      vi.mocked(outputModule.formatSubagent),
      { kind: "subagent" },
    );
  });
});
