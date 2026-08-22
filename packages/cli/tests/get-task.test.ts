// @vitest-environment node
/**
 * Tests for `get task` command handler in commands/get.ts.
 *
 * Covers the --board required validation added to list mode:
 *   - `ak get task` (no id, no --board) → error + process.exit(1)
 *   - `ak get task --board <id>` → calls client.listTasks with board_id param
 *   - `ak get task <id>` (no --board) → calls client.getTask, no error
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock createClient before importing the command ────────────────────────────

const mockGetTask = vi.fn();
const mockGetTaskSession = vi.fn();
const mockGetTaskSessionWs = vi.fn();
const mockGetSession = vi.fn();
const mockGetSessionWs = vi.fn();
const mockSessionSocketHeaders = vi.fn();
const mockListTasks = vi.fn();
const mockClient = {
  getTask: mockGetTask,
  getTaskSession: mockGetTaskSession,
  getTaskSessionWs: mockGetTaskSessionWs,
  getSession: mockGetSession,
  getSessionWs: mockGetSessionWs,
  sessionSocketHeaders: mockSessionSocketHeaders,
  listTasks: mockListTasks,
};
const mockCreateClient = vi.fn(() => Promise.resolve(mockClient));
const mockReadSessionEvents = vi.fn();
const mockFindMatchingSessionSubagents = vi.fn();
const mockFindSessionSubagents = vi.fn();
const mockFilterSessionEventsBySubagent = vi.fn();
const mockMatchesSessionEventFilter = vi.fn();
const mockFormatSessionEvent = vi.fn(() => "event");
const mockOutput = vi.fn();

vi.mock("../src/agent/leader.js", () => ({
  createClient: mockCreateClient,
}));

vi.mock("../src/sessionWs.js", () => ({
  readSessionEvents: (...args: unknown[]) => mockReadSessionEvents(...args),
  findMatchingSessionSubagents: (...args: unknown[]) => mockFindMatchingSessionSubagents(...args),
  findSessionSubagents: (...args: unknown[]) => mockFindSessionSubagents(...args),
  filterSessionEventsBySubagent: (...args: unknown[]) => mockFilterSessionEventsBySubagent(...args),
  matchesSessionEventFilter: (...args: unknown[]) => mockMatchesSessionEventFilter(...args),
}));

// Silence output helpers — we don't test formatting
vi.mock("../src/output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/output.js")>();
  return {
    ...actual,
    getOutputFormat: vi.fn((format?: string) => format ?? "text"),
    output: (...args: unknown[]) => mockOutput(...args),
    formatSessionEvent: (...args: unknown[]) => mockFormatSessionEvent(...args),
    formatTask: vi.fn(),
    formatTaskList: vi.fn(),
    formatTaskListWide: vi.fn(),
    formatTaskSession: vi.fn(() => "session"),
    formatBoard: vi.fn(),
    formatBoardList: vi.fn(),
    formatAgent: vi.fn(),
    formatAgentList: vi.fn(),
    formatRepository: vi.fn(),
    formatRepositoryList: vi.fn(),
    formatTaskNotes: vi.fn(),
    formatMaintainer: vi.fn(),
    formatMaintainerList: vi.fn(),
    formatModelList: vi.fn(),
    formatSubagent: vi.fn(),
    formatSubagentList: vi.fn(),
  };
});

const { registerGetCommand } = await import("../src/commands/get.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride(); // prevents real process.exit inside commander's own validation
  registerGetCommand(program);
  return program;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

let exitSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockListTasks.mockResolvedValue([]);
  mockGetTask.mockResolvedValue({ id: "task-1", title: "Test task" });
  mockGetTaskSession.mockResolvedValue({ task_id: "task-1", session_id: "session-1", session: { state: "idle" } });
  mockGetTaskSessionWs.mockResolvedValue({ url: "wss://session.test" });
  mockGetSession.mockResolvedValue({ session_id: "session-1", session: { state: "idle" } });
  mockGetSessionWs.mockResolvedValue({ url: "wss://session.test" });
  mockSessionSocketHeaders.mockResolvedValue({ authorization: "Bearer session-authority", dpop: "session-proof" });
  mockReadSessionEvents.mockResolvedValue([]);
  mockFindMatchingSessionSubagents.mockReturnValue([{ toolCallId: "call-reviewer", name: "reviewer" }]);
  mockFindSessionSubagents.mockReturnValue([{ toolCallId: "call-reviewer", name: "reviewer" }]);
  mockFilterSessionEventsBySubagent.mockImplementation((events) => events);
  mockMatchesSessionEventFilter.mockReturnValue(true);

  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as any);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("get task — list mode without --board", () => {
  it("prints an error message when --board is omitted", async () => {
    const program = makeProgram();
    await expect(program.parseAsync(["get", "task"], { from: "user" })).rejects.toThrow("process.exit called");
    expect(errorSpy).toHaveBeenCalledWith("Error: --board is required when listing tasks\nUsage: ak get task --board <id>");
  });

  it("exits with code 1 when --board is omitted", async () => {
    const program = makeProgram();
    await expect(program.parseAsync(["get", "task"], { from: "user" })).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not call client.listTasks when --board is omitted", async () => {
    const program = makeProgram();
    await expect(program.parseAsync(["get", "task"], { from: "user" })).rejects.toThrow("process.exit called");
    expect(mockListTasks).not.toHaveBeenCalled();
  });
});

describe("get task — list mode with --board", () => {
  it("calls client.listTasks with board_id when --board is provided", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "task", "--board", "board-abc"], { from: "user" });
    expect(mockListTasks).toHaveBeenCalledWith(expect.objectContaining({ board_id: "board-abc" }));
  });

  it("does not call process.exit when --board is provided", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "task", "--board", "board-abc"], { from: "user" });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("passes --status filter to listTasks when provided", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "task", "--board", "board-abc", "--status", "in_progress"], { from: "user" });
    expect(mockListTasks).toHaveBeenCalledWith(expect.objectContaining({ board_id: "board-abc", status: "in_progress" }));
  });

  it("passes --label filter to listTasks when provided", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "task", "--board", "board-abc", "--label", "bug"], { from: "user" });
    expect(mockListTasks).toHaveBeenCalledWith(expect.objectContaining({ board_id: "board-abc", label: "bug" }));
  });

  it("passes --repo filter as repository_id to listTasks when provided", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "task", "--board", "board-abc", "--repo", "repo-xyz"], { from: "user" });
    expect(mockListTasks).toHaveBeenCalledWith(expect.objectContaining({ board_id: "board-abc", repository_id: "repo-xyz" }));
  });
});

describe("get task — single-task fetch by ID", () => {
  it("calls client.getTask with the provided id", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "task", "task-42"], { from: "user" });
    expect(mockGetTask).toHaveBeenCalledWith("task-42");
  });

  it("does not call process.exit when an id is provided without --board", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "task", "task-42"], { from: "user" });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not call client.listTasks when an id is provided", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "task", "task-42"], { from: "user" });
    expect(mockListTasks).not.toHaveBeenCalled();
  });

  it("calls client.getTaskSession instead of client.getTask when --session is provided", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "task", "task-42", "--session"], { from: "user" });
    expect(mockGetTaskSession).toHaveBeenCalledWith("task-42");
    expect(mockGetTaskSessionWs).toHaveBeenCalledWith("task-42");
    expect(mockGetTask).not.toHaveBeenCalled();
  });

  it("enables main-stream filtering for normal task session events", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "task", "task-42", "--session"], { from: "user" });
    expect(mockReadSessionEvents).toHaveBeenCalledWith(
      "wss://session.test",
      expect.objectContaining({
        all: undefined,
        watch: undefined,
        filter: "all",
        headers: { authorization: "Bearer session-authority", dpop: "session-proof" },
        mainStream: true,
        recentLimit: 20,
      }),
    );
    expect(mockSessionSocketHeaders).toHaveBeenCalledWith("wss://session.test");
  });

  it("uses the default recent limit when filtering task session events by subagent", async () => {
    const rawEvents = Array.from({ length: 25 }, (_, index) => ({
      sequence: index + 1,
      event: { type: "message.completed", payload: { message: { role: "assistant", content: [] } } },
    }));
    mockReadSessionEvents.mockResolvedValueOnce(rawEvents);
    mockFilterSessionEventsBySubagent.mockReturnValueOnce(rawEvents);

    const program = makeProgram();
    await program.parseAsync(["get", "task", "task-42", "--session", "--subagent", "reviewer"], { from: "user" });

    expect(mockGetTaskSessionWs).toHaveBeenCalledWith("task-42");
    expect(mockGetTaskSession).toHaveBeenCalledWith("task-42");
    expect(mockReadSessionEvents).toHaveBeenCalledWith(
      "wss://session.test",
      expect.objectContaining({ all: true, watch: false, filter: "all", recentLimit: 20 }),
    );
    expect(mockReadSessionEvents.mock.calls[0]?.[1]).not.toHaveProperty("mainStream");
    expect(mockFindMatchingSessionSubagents).toHaveBeenCalledWith(rawEvents, "reviewer");
    expect(mockFilterSessionEventsBySubagent).toHaveBeenCalledWith(rawEvents, "reviewer");
    expect(mockFormatSessionEvent).toHaveBeenCalledTimes(20);
    expect(mockFormatSessionEvent).toHaveBeenNthCalledWith(1, rawEvents[5], "all", expect.objectContaining({ verbose: undefined }));
    expect(mockFormatSessionEvent).toHaveBeenNthCalledWith(20, rawEvents[24], "all", expect.objectContaining({ verbose: undefined }));
    expect(logSpy).toHaveBeenCalledWith("\nRecent subagent reviewer events (last 20):");
  });

  it("requires a task id when --session is provided", async () => {
    const program = makeProgram();
    await expect(program.parseAsync(["get", "task", "--session"], { from: "user" })).rejects.toThrow("process.exit called");
    expect(errorSpy).toHaveBeenCalledWith("Usage: ak get task <task-id> --session");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("get session", () => {
  it("loads session metadata and events by session id", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "session", "session-42"], { from: "user" });
    expect(mockGetSession).toHaveBeenCalledWith("session-42");
    expect(mockGetSessionWs).toHaveBeenCalledWith("session-42");
    expect(mockGetTaskSession).not.toHaveBeenCalled();
    expect(mockGetTaskSessionWs).not.toHaveBeenCalled();
    expect(mockReadSessionEvents).toHaveBeenCalledWith(
      "wss://session.test",
      expect.objectContaining({
        all: undefined,
        watch: undefined,
        filter: "all",
        headers: { authorization: "Bearer session-authority", dpop: "session-proof" },
        mainStream: true,
        recentLimit: 20,
      }),
    );
    expect(mockSessionSocketHeaders).toHaveBeenCalledWith("wss://session.test");
  });

  it("passes --watch, --all, and --tool to the WebSocket event reader", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "session", "session-42", "--watch", "--all", "--tool"], { from: "user" });
    expect(mockReadSessionEvents).toHaveBeenCalledWith(
      "wss://session.test",
      expect.objectContaining({ all: true, watch: true, filter: "tool", mainStream: true }),
    );
  });

  it("passes --limit to the WebSocket event reader", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "session", "session-42", "--limit", "5"], { from: "user" });
    expect(mockReadSessionEvents).toHaveBeenCalledWith("wss://session.test", expect.objectContaining({ recentLimit: 5 }));
  });

  it("passes --verbose to the session event formatter", async () => {
    mockReadSessionEvents.mockImplementationOnce(async (_url, options) => {
      options.onEvent?.({ sequence: 1, event: { type: "message.completed", payload: { message: { role: "tool", content: [] } } } });
      return [];
    });
    const program = makeProgram();
    await program.parseAsync(["get", "session", "session-42", "--verbose"], { from: "user" });
    expect(mockFormatSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ sequence: 1 }), "all", expect.objectContaining({ verbose: true }));
  });

  it("supports json output with collected events", async () => {
    const event = { sequence: 1, event: { type: "message.completed", payload: { message: { role: "assistant", content: [] } } } };
    mockReadSessionEvents.mockResolvedValueOnce([event]);
    const program = makeProgram();
    await program.parseAsync(["get", "session", "session-42", "-o", "json"], { from: "user" });
    expect(mockReadSessionEvents).toHaveBeenCalledWith("wss://session.test", expect.objectContaining({ mainStream: true }));
    expect(mockOutput).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: "session-1", events: [event] }),
      "json",
      undefined,
      expect.objectContaining({ kind: "session" }),
    );
  });

  it("does not force-exit after json output so large stdout can flush", async () => {
    const previousWorkerId = process.env.VITEST_WORKER_ID;
    delete process.env.VITEST_WORKER_ID;
    try {
      const program = makeProgram();
      await program.parseAsync(["get", "session", "session-42", "-o", "json"], { from: "user" });
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      if (previousWorkerId === undefined) delete process.env.VITEST_WORKER_ID;
      else process.env.VITEST_WORKER_ID = previousWorkerId;
    }
  });

  it("keeps text output usable when session events are unavailable", async () => {
    mockReadSessionEvents.mockRejectedValueOnce(new Error("Invalid session socket message"));
    const program = makeProgram();
    await program.parseAsync(["get", "session", "session-42"], { from: "user" });
    expect(mockGetSession).toHaveBeenCalledWith("session-42");
    expect(logSpy).toHaveBeenCalledWith("  unavailable: Invalid session socket message");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("includes events_error in json output when session events are unavailable", async () => {
    mockReadSessionEvents.mockRejectedValueOnce(new Error("Invalid session socket message"));
    const program = makeProgram();
    await program.parseAsync(["get", "session", "session-42", "-o", "json"], { from: "user" });
    expect(mockOutput).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: "session-1", events: [], events_error: "Invalid session socket message" }),
      "json",
      undefined,
      expect.objectContaining({ kind: "session" }),
    );
  });

  it("loads all events and applies local filtering when --subagent is provided", async () => {
    const rawEvents = [
      { sequence: 1, event: { type: "message.completed", payload: { message: { role: "assistant", content: [] } } } },
      { sequence: 2, event: { type: "message.completed", payload: { message: { role: "assistant", content: [] } } } },
    ];
    const subagentEvents = [rawEvents[1]];
    mockReadSessionEvents.mockResolvedValueOnce(rawEvents);
    mockFilterSessionEventsBySubagent.mockReturnValueOnce(subagentEvents);

    const program = makeProgram();
    await program.parseAsync(["get", "session", "session-42", "--subagent", "reviewer", "--assistant", "--limit", "1"], { from: "user" });

    expect(mockReadSessionEvents).toHaveBeenCalledWith(
      "wss://session.test",
      expect.objectContaining({ all: true, watch: false, filter: "all", recentLimit: 1 }),
    );
    expect(mockReadSessionEvents.mock.calls[0]?.[1]).not.toHaveProperty("mainStream");
    expect(mockFindMatchingSessionSubagents).toHaveBeenCalledWith(rawEvents, "reviewer");
    expect(mockFilterSessionEventsBySubagent).toHaveBeenCalledWith(rawEvents, "reviewer");
    expect(mockMatchesSessionEventFilter).toHaveBeenCalledWith(rawEvents[1], "assistant");
    expect(mockFormatSessionEvent).toHaveBeenCalledWith(rawEvents[1], "assistant", expect.objectContaining({ verbose: undefined }));
  });

  it("rejects combining --subagent and --watch", async () => {
    const program = makeProgram();
    await expect(program.parseAsync(["get", "session", "session-42", "--subagent", "reviewer", "--watch"], { from: "user" })).rejects.toThrow(
      "process.exit called",
    );
    expect(errorSpy).toHaveBeenCalledWith("--subagent does not support --watch");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockGetSessionWs).not.toHaveBeenCalled();
    expect(mockReadSessionEvents).not.toHaveBeenCalled();
  });

  it("rejects invalid --limit values", async () => {
    const program = makeProgram();
    await expect(program.parseAsync(["get", "session", "session-42", "--limit", "nope"], { from: "user" })).rejects.toThrow("process.exit called");
    expect(errorSpy).toHaveBeenCalledWith("--limit must be a positive number");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("rejects combining --tool and --assistant", async () => {
    const program = makeProgram();
    await expect(program.parseAsync(["get", "session", "task-42", "--tool", "--assistant"], { from: "user" })).rejects.toThrow("process.exit called");
    expect(errorSpy).toHaveBeenCalledWith("--tool and --assistant cannot be used together");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
