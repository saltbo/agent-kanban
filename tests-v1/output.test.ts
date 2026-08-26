// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatAgent,
  formatAgentList,
  formatBoard,
  formatBoardList,
  formatLabelList,
  formatMaintainer,
  formatMaintainerList,
  formatModelList,
  formatRepositoryList,
  formatSessionEvent,
  formatTask,
  formatTaskList,
  formatTaskNotes,
  formatTaskRuntime,
  getOutputFormat,
  output,
} from "../packages/cli/src/output";

function sessionEvent(sequence: number, type: string, payload: Record<string, unknown>) {
  return { id: `event-${sequence}`, sessionId: "session-1", sequence, createdAt: "2026-07-01T00:00:00.000Z", type, payload };
}

describe("formatTask", () => {
  it("includes task title on the first line", () => {
    const task = { id: "t1", title: "My Task", status: "todo" };
    const result = formatTask(task);
    expect(result.split("\n")[0]).toBe("My Task");
  });

  it("includes task ID", () => {
    const task = { id: "abc123", title: "T", status: "todo" };
    const result = formatTask(task);
    expect(result).toContain("abc123");
  });

  it("includes status", () => {
    const task = { id: "t1", title: "T", status: "in_progress" };
    const result = formatTask(task);
    expect(result).toContain("in_progress");
  });

  it("appends BLOCKED to status when task is blocked", () => {
    const task = { id: "t1", title: "T", status: "todo", blocked: true };
    const result = formatTask(task);
    expect(result).toContain("BLOCKED");
  });

  it("does not show BLOCKED when blocked is false", () => {
    const task = { id: "t1", title: "T", status: "todo", blocked: false };
    const result = formatTask(task);
    expect(result).not.toContain("BLOCKED");
  });

  it("omits Labels line when missing labels", () => {
    const task = { id: "t1", title: "T", status: "todo", labels: null };
    const result = formatTask(task);
    expect(result).not.toContain("Labels:");
  });

  it("includes labels when present", () => {
    const task = { id: "t1", title: "T", status: "todo", labels: ["bug", "urgent"] };
    const result = formatTask(task);
    expect(result).toContain("bug");
    expect(result).toContain("urgent");
  });

  it("does not include Labels line when labels are absent", () => {
    const task = { id: "t1", title: "T", status: "todo", labels: null };
    const result = formatTask(task);
    expect(result).not.toContain("Labels:");
  });

  it("includes assigned_to when present", () => {
    const task = { id: "t1", title: "T", status: "todo", assigned_to: "agent-7" };
    const result = formatTask(task);
    expect(result).toContain("agent-7");
  });

  it("omits Assigned line when assigned_to is absent", () => {
    const task = { id: "t1", title: "T", status: "todo", assigned_to: null };
    const result = formatTask(task);
    expect(result).not.toContain("Assigned to:");
  });

  it("includes repository_name when present", () => {
    const task = { id: "t1", title: "T", status: "todo", repository_name: "my-repo" };
    const result = formatTask(task);
    expect(result).toContain("my-repo");
  });

  it("omits Repository line when repository_name is absent", () => {
    const task = { id: "t1", title: "T", status: "todo", repository_name: null };
    const result = formatTask(task);
    expect(result).not.toContain("Repository:");
  });

  it("includes depends_on IDs when present", () => {
    const task = { id: "t1", title: "T", status: "todo", depends_on: ["dep1", "dep2"] };
    const result = formatTask(task);
    expect(result).toContain("dep1");
    expect(result).toContain("dep2");
  });

  it("omits Depends on line when depends_on is empty", () => {
    const task = { id: "t1", title: "T", status: "todo", depends_on: [] };
    const result = formatTask(task);
    expect(result).not.toContain("Depends on:");
  });

  it("includes pr_url when present", () => {
    const task = { id: "t1", title: "T", status: "todo", pr_url: "https://github.com/org/repo/pull/42" };
    const result = formatTask(task);
    expect(result).toContain("https://github.com/org/repo/pull/42");
  });

  it("omits PR line when pr_url is absent", () => {
    const task = { id: "t1", title: "T", status: "todo", pr_url: null };
    const result = formatTask(task);
    expect(result).not.toContain("PR:");
  });

  it("includes description when present", () => {
    const task = { id: "t1", title: "T", status: "todo", description: "A task description" };
    const result = formatTask(task);
    expect(result).toContain("A task description");
  });

  it("omits description section when absent", () => {
    const task = { id: "t1", title: "T", status: "todo", description: null };
    const result = formatTask(task);
    expect(result.split("\n").length).toBeLessThan(10);
  });

  it("includes input as JSON when present", () => {
    const task = { id: "t1", title: "T", status: "todo", input: { key: "value" } };
    const result = formatTask(task);
    expect(result).toContain('"key"');
    expect(result).toContain('"value"');
  });

  it("omits Input section when absent", () => {
    const task = { id: "t1", title: "T", status: "todo", input: null };
    const result = formatTask(task);
    expect(result).not.toContain("Input:");
  });

  it("omits legacy result when present", () => {
    const task = { id: "t1", title: "T", status: "done", result: "Completed successfully" };
    const result = formatTask(task);
    expect(result).not.toContain("Completed successfully");
  });

  it("omits Result line when result is absent", () => {
    const task = { id: "t1", title: "T", status: "todo", result: null };
    const result = formatTask(task);
    expect(result).not.toContain("Result:");
  });
});

describe("formatTaskNotes", () => {
  it("returns 'No notes.' for empty array", () => {
    expect(formatTaskNotes([])).toBe("No notes.");
  });

  it("includes the action for each log entry", () => {
    const logs = [{ id: "l1", task_id: "t1", actor_id: null, action: "created", detail: null, created_at: "2024-01-01T00:00:00.000Z" }];
    const result = formatTaskNotes(logs);
    expect(result).toContain("created");
  });

  it("includes the detail text when present", () => {
    const logs = [
      { id: "l1", task_id: "t1", actor_id: null, action: "commented", detail: "This is the detail", created_at: "2024-01-01T00:00:00.000Z" },
    ];
    const result = formatTaskNotes(logs);
    expect(result).toContain("This is the detail");
  });

  it("includes actor_id when present", () => {
    const logs = [{ id: "l1", task_id: "t1", actor_id: "agent-5", action: "claimed", detail: null, created_at: "2024-01-01T00:00:00.000Z" }];
    const result = formatTaskNotes(logs);
    expect(result).toContain("agent-5");
  });

  it("omits actor bracket when actor_id is absent", () => {
    const logs = [{ id: "l1", task_id: "t1", actor_id: null, action: "created", detail: null, created_at: "2024-01-01T00:00:00.000Z" }];
    const result = formatTaskNotes(logs);
    expect(result).not.toContain("[null]");
    expect(result).not.toContain("[undefined]");
  });

  it("formats multiple log entries each on its own line", () => {
    const logs = [
      { id: "l1", task_id: "t1", actor_id: null, action: "created", detail: null, created_at: "2024-01-01T00:00:00.000Z" },
      { id: "l2", task_id: "t1", actor_id: "ag1", action: "claimed", detail: null, created_at: "2024-01-02T00:00:00.000Z" },
    ];
    const result = formatTaskNotes(logs);
    const lines = result.split("\n");
    expect(lines.length).toBe(2);
  });

  it("formats the created_at timestamp", () => {
    const logs = [{ id: "l1", task_id: "t1", actor_id: null, action: "created", detail: null, created_at: "2024-06-15T10:30:00.000Z" }];
    const result = formatTaskNotes(logs);
    // The timestamp should be a recognisable date string (locale-formatted)
    expect(result.trim().length).toBeGreaterThan(0);
  });
});

describe("formatTaskRuntime", () => {
  it("shows AMA session status and recent event types", () => {
    const result = formatTaskRuntime({
      task_id: "task-1",
      session_id: "session-1",
      session: { status: "idle", statusReason: null, startedAt: "2026-06-06T12:00:00.000Z" },
      events: [
        sessionEvent(1, "message.started", { message: { role: "assistant", content: [] } }),
        sessionEvent(2, "message.completed", { message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
      ],
      pagination: { hasMore: false },
    });
    expect(result).toContain("Task runtime");
    expect(result).toContain("session-1");
    expect(result).toContain("idle");
    expect(result).toContain("message.completed");
  });
});

describe("formatSessionEvent", () => {
  it("includes tool result output in all mode", () => {
    const result = formatSessionEvent(
      sessionEvent(7, "message.completed", {
        message: {
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId: "call-1",
              result: { content: [{ type: "text", text: "created comment as agent-kanban-local[bot]" }] },
            },
          ],
        },
      }),
    );

    expect(result).toContain("message.completed");
    expect(result).toContain("result");
    expect(result).toContain("created comment");
  });

  it("includes tool result output in tool mode", () => {
    const result = formatSessionEvent(
      sessionEvent(8, "message.completed", {
        message: {
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId: "call-1",
              result: { content: [{ type: "text", text: "Resource not accessible by integration" }] },
            },
          ],
        },
      }),
      "tool",
    );

    expect(result).toContain("result");
    expect(result).toContain("Resource not accessible by integration");
  });

  it("prints assistant text without event framing in assistant mode", () => {
    const result = formatSessionEvent(
      sessionEvent(9, "message.completed", { message: { role: "assistant", content: [{ type: "text", text: "ACK PR bot identity fixed" }] } }),
      "assistant",
    );

    expect(result).toBe("ACK PR bot identity fixed");
  });
});

describe("formatAgent", () => {
  it("includes agent name on the first line", () => {
    const agent = { id: "a1", name: "Claude", status: "idle" };
    const result = formatAgent(agent);
    expect(result.split("\n")[0]).toBe("Claude");
  });

  it("includes agent ID", () => {
    const agent = { id: "agent-42", name: "Claude", status: "idle" };
    const result = formatAgent(agent);
    expect(result).toContain("agent-42");
  });

  it("includes status", () => {
    const agent = { id: "a1", name: "Claude", status: "working" };
    const result = formatAgent(agent);
    expect(result).toContain("working");
  });

  it("includes role when present", () => {
    const agent = { id: "a1", name: "Claude", status: "idle", role: "developer" };
    const result = formatAgent(agent);
    expect(result).toContain("developer");
  });

  it("omits Role line when role is absent", () => {
    const agent = { id: "a1", name: "Claude", status: "idle", role: null };
    const result = formatAgent(agent);
    expect(result).not.toContain("Role:");
  });

  it("includes bio when present", () => {
    const agent = { id: "a1", name: "Claude", status: "idle", bio: "An AI assistant" };
    const result = formatAgent(agent);
    expect(result).toContain("An AI assistant");
  });

  it("omits Bio line when bio is absent", () => {
    const agent = { id: "a1", name: "Claude", status: "idle", bio: null };
    const result = formatAgent(agent);
    expect(result).not.toContain("Bio:");
  });

  it("always shows Runtime line", () => {
    const agent = { id: "a1", name: "Claude", status: "idle", runtime: "claude" };
    const result = formatAgent(agent);
    expect(result).toContain("Runtime:  claude");
  });

  it("includes model when present", () => {
    const agent = { id: "a1", name: "Claude", status: "idle", model: "claude-opus-4" };
    const result = formatAgent(agent);
    expect(result).toContain("claude-opus-4");
  });

  it("omits Model line when model is absent", () => {
    const agent = { id: "a1", name: "Claude", status: "idle", model: null };
    const result = formatAgent(agent);
    expect(result).not.toContain("Model:");
  });

  it("includes skills when present", () => {
    const agent = { id: "a1", name: "Claude", status: "idle", skills: ["agent-kanban", "git"] };
    const result = formatAgent(agent);
    expect(result).toContain("agent-kanban");
    expect(result).toContain("git");
  });

  it("omits Skills line when skills array is empty", () => {
    const agent = { id: "a1", name: "Claude", status: "idle", skills: [] };
    const result = formatAgent(agent);
    expect(result).not.toContain("Skills:");
  });

  it("includes handoff_to when present", () => {
    const agent = { id: "a1", name: "Claude", status: "idle", handoff_to: ["qa"] };
    const result = formatAgent(agent);
    expect(result).toContain("qa");
  });

  it("omits Handoff line when handoff_to array is empty", () => {
    const agent = { id: "a1", name: "Claude", status: "idle", handoff_to: [] };
    const result = formatAgent(agent);
    expect(result).not.toContain("Handoff:");
  });

  it("includes structured status task counts when present", () => {
    const agent = {
      id: "a1",
      name: "Claude",
      status: { schedulable: true, tasks: { todo: 1, in_progress: 2, in_review: 3, done: 4, cancelled: 5 } },
    };
    const result = formatAgent(agent);
    expect(result).toContain("Status:   schedulable");
    expect(result).toContain("Todo:     1");
    expect(result).toContain("Progress: 2");
    expect(result).toContain("Review:   3");
    expect(result).toContain("Done:     4");
    expect(result).toContain("Cancelled:5");
  });

  it("includes zero structured status task count values", () => {
    const agent = {
      id: "a1",
      name: "Claude",
      status: { schedulable: false, tasks: { todo: 0, in_progress: 0, in_review: 0, done: 0, cancelled: 0 } },
    };
    const result = formatAgent(agent);
    expect(result).toContain("Status:   unschedulable");
    expect(result).toContain("Todo:     0");
  });

  it("omits legacy Tasks line with structured status", () => {
    const agent = {
      id: "a1",
      name: "Claude",
      status: { schedulable: true, tasks: { todo: 0, in_progress: 0, in_review: 0, done: 0, cancelled: 0 } },
      task_count: 3,
    };
    const result = formatAgent(agent);
    expect(result).not.toContain("Tasks:");
  });
});

describe("formatTaskList", () => {
  it("returns 'No tasks found.' for empty array", () => {
    expect(formatTaskList([])).toBe("No tasks found.");
  });

  it("includes task ID and title", () => {
    const tasks = [{ id: "t1", title: "Do something", status: "todo" }];
    const result = formatTaskList(tasks);
    expect(result).toContain("t1");
    expect(result).toContain("Do something");
  });

  it("includes label bracket when present", () => {
    const tasks = [{ id: "t1", title: "T", status: "todo", labels: ["bug"] }];
    const result = formatTaskList(tasks);
    expect(result).toContain("[bug]");
  });

  it("includes repository name when present", () => {
    const tasks = [{ id: "t1", title: "T", status: "todo", repository_name: "my-repo" }];
    const result = formatTaskList(tasks);
    expect(result).toContain("my-repo");
  });

  it("includes assigned_to agent when present", () => {
    const tasks = [{ id: "t1", title: "T", status: "todo", assigned_to: "agent-9" }];
    const result = formatTaskList(tasks);
    expect(result).toContain("agent-9");
  });

  it("returns one line per task", () => {
    const tasks = [
      { id: "t1", title: "First", status: "todo" },
      { id: "t2", title: "Second", status: "todo" },
    ];
    const lines = formatTaskList(tasks).split("\n");
    expect(lines.length).toBe(2);
  });
});

describe("formatAgentList", () => {
  it("returns 'No agents found.' for empty array", () => {
    expect(formatAgentList([])).toBe("No agents found.");
  });

  it("includes agent ID and name", () => {
    const agents = [
      { id: "a1", name: "Claude", status: { schedulable: true, tasks: { todo: 0, in_progress: 0, in_review: 0, done: 0, cancelled: 0 } } },
    ];
    const result = formatAgentList(agents);
    expect(result).toContain("a1");
    expect(result).toContain("Claude");
  });

  it("includes status", () => {
    const agents = [
      { id: "a1", name: "Claude", status: { schedulable: false, tasks: { todo: 1, in_progress: 2, in_review: 3, done: 4, cancelled: 5 } } },
    ];
    const result = formatAgentList(agents);
    expect(result).toContain("[unschedulable]");
    expect(result).toContain("todo=1 progress=2 review=3 done=4 cancelled=5");
  });

  it("includes role when present", () => {
    const agents = [{ id: "a1", name: "Claude", status: "idle", role: "backend-dev", runtime: "claude" }];
    const result = formatAgentList(agents);
    expect(result).toContain("(backend-dev)");
  });

  it("includes runtime and bio when present", () => {
    const agents = [{ id: "a1", name: "Claude", status: "idle", runtime: "claude", bio: "Builds APIs" }];
    const result = formatAgentList(agents);
    expect(result).toContain("claude");
    expect(result).toContain("Builds APIs");
  });
});

describe("formatModelList", () => {
  it("returns 'No models found.' for an empty list", () => {
    expect(formatModelList([])).toBe("No models found.");
  });

  it("prints id, display name, context window, and reasoning efforts", () => {
    const result = formatModelList([
      {
        id: "gpt-5",
        name: "GPT-5",
        context_window: 400000,
        supported_reasoning_efforts: ["low", "medium", "high"],
      },
    ]);

    expect(result).toBe("  gpt-5  GPT-5 context=400000 efforts=low,medium,high");
  });

  it("omits duplicate display name and missing optional fields", () => {
    expect(formatModelList([{ id: "claude-opus-4-1", name: "claude-opus-4-1" }])).toBe("  claude-opus-4-1");
  });
});

describe("formatBoardList", () => {
  it("returns 'No boards found.' for empty array", () => {
    expect(formatBoardList([])).toBe("No boards found.");
  });

  it("includes board ID and name", () => {
    const boards = [{ id: "b1", name: "My Board", description: null }];
    const result = formatBoardList(boards);
    expect(result).toContain("b1");
    expect(result).toContain("My Board");
  });

  it("includes description when present", () => {
    const boards = [{ id: "b1", name: "My Board", description: "Work stuff" }];
    const result = formatBoardList(boards);
    expect(result).toContain("Work stuff");
  });

  it("omits description dash when description is absent", () => {
    const boards = [{ id: "b1", name: "My Board", description: null }];
    const result = formatBoardList(boards);
    expect(result).not.toContain(" — ");
  });
});

describe("formatLabelList", () => {
  it("returns 'No labels found.' for empty array", () => {
    expect(formatLabelList([])).toBe("No labels found.");
  });

  it("includes label name and color", () => {
    const labels = [{ name: "backend", color: "#38BDF8", description: "" }];
    const result = formatLabelList(labels);
    expect(result).toContain("backend");
    expect(result).toContain("#38BDF8");
  });

  it("includes description when present", () => {
    const labels = [{ name: "v1.4", color: "#22C55E", description: "Version 1.4" }];
    expect(formatLabelList(labels)).toContain("Version 1.4");
  });
});

describe("formatRepositoryList", () => {
  it("returns 'No repositories found.' for empty array", () => {
    expect(formatRepositoryList([])).toBe("No repositories found.");
  });

  it("includes repo ID, name, and URL", () => {
    const repos = [{ id: "r1", name: "my-repo", url: "https://github.com/org/my-repo" }];
    const result = formatRepositoryList(repos);
    expect(result).toContain("r1");
    expect(result).toContain("my-repo");
    expect(result).toContain("https://github.com/org/my-repo");
  });
});

describe("formatMaintainer", () => {
  it("formats board maintainer details", () => {
    const result = formatMaintainer({
      id: "maintainer-1",
      board_id: "board-1",
      agent_id: "agent-1",
      status: "active",
      heartbeat_enabled: false,
      interval_seconds: 3600,
    });

    expect(result).toContain("Maintainer maintainer-1");
    expect(result).toContain("Board:");
    expect(result).toContain("Heartbeat:");
    expect(result).toContain("disabled");
    expect(result).not.toContain("Repository:");
  });
});

describe("formatMaintainerList", () => {
  it("formats board maintainer list rows", () => {
    const result = formatMaintainerList([
      {
        id: "maintainer-1",
        agent_id: "agent-1",
        status: "active",
        heartbeat_enabled: true,
        interval_seconds: 3600,
      },
    ]);

    expect(result).toContain("maintainer-1");
    expect(result).toContain("agent=agent-1");
    expect(result).toContain("heartbeat=enabled");
    expect(result).not.toContain("repo=");
  });
});

describe("formatBoard", () => {
  it("includes board name in header line", () => {
    const board = { name: "Sprint 1", tasks: [] };
    const result = formatBoard(board);
    expect(result).toContain("Sprint 1");
  });

  it("groups tasks by status", () => {
    const board = {
      name: "My Board",
      tasks: [
        { id: "t1", title: "Task A", status: "todo" },
        { id: "t2", title: "Task B", status: "done" },
      ],
    };
    const result = formatBoard(board);
    expect(result).toContain("Todo (1):");
    expect(result).toContain("Done (1):");
    expect(result).toContain("Task A");
    expect(result).toContain("Task B");
  });

  it("shows task count in header", () => {
    const board = {
      name: "My Board",
      tasks: [{ id: "t1", title: "Build feature", status: "todo" }],
    };
    const result = formatBoard(board);
    expect(result).toContain("My Board (1 tasks)");
  });

  it("shows agent and PR info", () => {
    const board = {
      name: "My Board",
      tasks: [{ id: "t1", title: "Task A", status: "in_review", assigned_to: "abcdef1234567890", pr_url: "https://github.com/org/repo/pull/1" }],
    };
    const result = formatBoard(board);
    expect(result).toContain("→ abcdef12");
    expect(result).toContain("PR: https://github.com/org/repo/pull/1");
  });

  it("skips empty status groups", () => {
    const board = {
      name: "My Board",
      tasks: [{ id: "t1", title: "Done task", status: "done" }],
    };
    const result = formatBoard(board);
    expect(result).not.toContain("Todo");
    expect(result).toContain("Done (1):");
  });

  it("handles board with no tasks", () => {
    const board = { name: "Empty Board", tasks: [] };
    const result = formatBoard(board);
    expect(result).toContain("Empty Board");
    expect(result).toContain("(0 tasks)");
  });
});

describe("getOutputFormat", () => {
  it("returns 'json' when given 'json'", () => {
    expect(getOutputFormat("json")).toBe("json");
  });

  it("returns 'yaml' when given 'yaml'", () => {
    expect(getOutputFormat("yaml")).toBe("yaml");
  });

  it("returns 'wide' when given 'wide'", () => {
    expect(getOutputFormat("wide")).toBe("wide");
  });

  it("rejects an unrecognized value", () => {
    expect(() => getOutputFormat("unknown")).toThrow("Invalid output format: unknown");
  });

  it("returns 'text' when given undefined", () => {
    expect(getOutputFormat(undefined)).toBe("text");
  });
});

describe("output", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls textFormatter in text mode when provided", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    let called = false;
    const formatter = (_data: any) => {
      called = true;
      return "formatted";
    };
    output({ foo: "bar" }, "text", formatter);
    expect(called).toBe(true);
    spy.mockRestore();
  });

  it("falls back to JSON.stringify in text mode when no formatter provided", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    output({ foo: "bar" }, "text");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('"foo"'));
  });

  it("outputs pretty-printed JSON in json mode", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    output({ foo: "bar" }, "json");
    const logged = spy.mock.calls[0][0];
    expect(JSON.parse(logged)).toEqual({ foo: "bar" });
  });

  it("outputs yaml with kind/spec envelope for a single object when kind is provided", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    output({ title: "My Task", status: "todo" }, "yaml", undefined, { kind: "task" });
    const logged = spy.mock.calls[0][0];
    expect(logged).toContain("kind: task");
    expect(logged).toContain("spec:");
  });

  it("outputs multi-doc yaml for an array when kind is provided", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const item1 = { title: "Task 1", status: "todo" };
    const item2 = { title: "Task 2", status: "done" };
    output([item1, item2], "yaml", undefined, { kind: "task" });
    const logged = spy.mock.calls[0][0];
    // Each document must start with ---
    const docSeparators = logged.match(/^---$/gm) || [];
    expect(docSeparators.length).toBe(2);
    expect(logged).toContain("Task 1");
    expect(logged).toContain("Task 2");
  });

  it("outputs raw yaml without wrapper when no kind is provided", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    output({ foo: "bar" }, "yaml");
    const logged = spy.mock.calls[0][0];
    expect(logged).not.toContain("kind:");
    expect(logged).not.toContain("spec:");
    expect(logged).toContain("foo:");
  });

  it("calls wideFormatter in wide mode when wideFormatter is provided", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const textFn = vi.fn(() => "text-output");
    const wideFn = vi.fn(() => "wide-output");
    output({ foo: "bar" }, "wide", textFn, { wideFormatter: wideFn });
    expect(wideFn).toHaveBeenCalledWith({ foo: "bar" });
    expect(textFn).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith("wide-output");
  });

  it("falls back to textFormatter in wide mode when wideFormatter is not provided", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const textFn = vi.fn(() => "text-output");
    output({ foo: "bar" }, "wide", textFn);
    expect(textFn).toHaveBeenCalledWith({ foo: "bar" });
    expect(spy).toHaveBeenCalledWith("text-output");
  });
});
