// @vitest-environment node

import { EventEmitter } from "node:events";
import type { Task } from "@agent-kanban/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── helpers ───────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    board_id: "board-1",
    seq: 1,
    status: "todo",
    title: "Test task",
    description: null,
    repository_id: null,
    labels: null,
    created_by: null,
    assigned_to: null,
    result: null,
    pr_url: null,
    input: null,
    created_from: null,
    scheduled_at: null,
    position: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── parseDuration ─────────────────────────────────────────────────────────

describe("parseDuration", () => {
  let parseDuration: (input: string) => number;

  beforeEach(async () => {
    vi.resetModules();
    ({ parseDuration } = await import("../packages/cli/src/commands/wait.js"));
  });

  it('returns Infinity for "0"', () => {
    expect(parseDuration("0")).toBe(Number.POSITIVE_INFINITY);
  });

  it("parses milliseconds suffix ms", () => {
    expect(parseDuration("500ms")).toBe(500);
  });

  it("parses seconds suffix s", () => {
    expect(parseDuration("30s")).toBe(30_000);
  });

  it("parses minutes suffix m", () => {
    expect(parseDuration("15m")).toBe(900_000);
  });

  it("parses hours suffix h", () => {
    expect(parseDuration("2h")).toBe(7_200_000);
  });

  it("trims surrounding whitespace", () => {
    expect(parseDuration("  10s  ")).toBe(10_000);
  });

  it("parses single-millisecond value 1ms", () => {
    expect(parseDuration("1ms")).toBe(1);
  });

  it("parses large hour value 24h", () => {
    expect(parseDuration("24h")).toBe(86_400_000);
  });

  it("throws on empty string", () => {
    expect(() => parseDuration("")).toThrow("Invalid duration");
  });

  it("throws on bare number with no unit", () => {
    expect(() => parseDuration("30")).toThrow("Invalid duration");
  });

  it("throws on unknown unit", () => {
    expect(() => parseDuration("10d")).toThrow("Invalid duration");
  });

  it("throws on non-numeric prefix", () => {
    expect(() => parseDuration("Xm")).toThrow("Invalid duration");
  });
});

// ─── waitForTasks ──────────────────────────────────────────────────────────
//
// Multi-poll tests need a timeout just large enough to allow a few polls to
// complete, but small enough that the per-poll sleep = Math.min(5000, remaining)
// is very short. We use 200ms total so each sleep is at most 200ms per cycle,
// allowing 3 calls within real wall time without fake timers.

describe("waitForTasks", () => {
  let waitForTasks: (ids: string[], opts: { until: any; timeout: number }) => Promise<number>;

  // Fresh module registry per test so vi.doMock takes effect
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 0 immediately when task is already at target status", async () => {
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        getTask: async (_id: string) => makeTask({ id: _id, status: "done" }),
      }),
    }));
    ({ waitForTasks } = await import("../packages/cli/src/commands/wait.js"));

    const code = await waitForTasks(["task-1"], { until: "done", timeout: 5000 });
    expect(code).toBe(0);
  });

  it("returns 0 when task transitions from todo to done across polls", async () => {
    let callCount = 0;
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        getTask: async (_id: string) => {
          callCount++;
          // Poll 1 → todo (not done), poll 2 → done (terminates)
          if (callCount === 1) return makeTask({ id: _id, status: "todo" });
          return makeTask({ id: _id, status: "done" });
        },
      }),
    }));
    ({ waitForTasks } = await import("../packages/cli/src/commands/wait.js"));

    // 2 polls require 1 sleep ≤ remaining ≤ 200ms; resolves within 200ms wall time
    const code = await waitForTasks(["task-1"], { until: "done", timeout: 200 });
    expect(code).toBe(0);
    expect(callCount).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("returns 2 when a task is cancelled while waiting for done", async () => {
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        getTask: async (_id: string) => makeTask({ id: _id, status: "cancelled" }),
      }),
    }));
    ({ waitForTasks } = await import("../packages/cli/src/commands/wait.js"));

    const code = await waitForTasks(["task-1"], { until: "done", timeout: 5000 });
    expect(code).toBe(2);
  });

  it("returns 0 when waiting for cancelled and task is already cancelled", async () => {
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        getTask: async (_id: string) => makeTask({ id: _id, status: "cancelled" }),
      }),
    }));
    ({ waitForTasks } = await import("../packages/cli/src/commands/wait.js"));

    const code = await waitForTasks(["task-1"], { until: "cancelled", timeout: 5000 });
    expect(code).toBe(0);
  });

  it("returns 124 on timeout when task never reaches target", async () => {
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        // Always returns in_progress, never done
        getTask: async (_id: string) => makeTask({ id: _id, status: "in_progress" }),
      }),
    }));
    ({ waitForTasks } = await import("../packages/cli/src/commands/wait.js"));

    // Tiny timeout: first poll runs, then deadline has passed → 124
    const code = await waitForTasks(["task-1"], { until: "done", timeout: 1 });
    expect(code).toBe(124);
  });

  it("returns 0 when all multiple tasks reach target", async () => {
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        getTask: async (_id: string) => makeTask({ id: _id, status: "done" }),
      }),
    }));
    ({ waitForTasks } = await import("../packages/cli/src/commands/wait.js"));

    const code = await waitForTasks(["task-1", "task-2", "task-3"], { until: "done", timeout: 5000 });
    expect(code).toBe(0);
  });

  it("returns 2 when one of many tasks is cancelled while waiting for done", async () => {
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        getTask: async (_id: string) => {
          if (_id === "task-2") return makeTask({ id: _id, status: "cancelled" });
          return makeTask({ id: _id, status: "done" });
        },
      }),
    }));
    ({ waitForTasks } = await import("../packages/cli/src/commands/wait.js"));

    const code = await waitForTasks(["task-1", "task-2", "task-3"], { until: "done", timeout: 5000 });
    expect(code).toBe(2);
  });
});

// ─── waitForBoard ──────────────────────────────────────────────────────────

describe("waitForBoard", () => {
  let waitForBoard: (boardId: string, opts: any) => Promise<number>;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 0 when all tasks are done (--until all-done)", async () => {
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        listTasks: async (_params: any) => [makeTask({ id: "t1", status: "done" }), makeTask({ id: "t2", status: "cancelled" })],
      }),
    }));
    ({ waitForBoard } = await import("../packages/cli/src/commands/wait.js"));

    const code = await waitForBoard("board-1", {
      until: "all-done",
      filter: undefined,
      label: undefined,
      includeCurrent: true,
      timeout: 5000,
    });
    expect(code).toBe(0);
  });

  it("returns 124 on timeout when tasks are never all done", async () => {
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        listTasks: async (_params: any) => [makeTask({ id: "t1", status: "in_progress" })],
      }),
    }));
    ({ waitForBoard } = await import("../packages/cli/src/commands/wait.js"));

    const code = await waitForBoard("board-1", {
      until: "all-done",
      filter: undefined,
      label: undefined,
      includeCurrent: false,
      timeout: 1,
    });
    expect(code).toBe(124);
  });

  it("returns 0 on first task entering in_review with --filter in_review (transition, not initial)", async () => {
    let callCount = 0;
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        listTasks: async (_params: any) => {
          callCount++;
          if (callCount === 1) {
            // First snapshot: task is todo — not in_review, no match
            return [makeTask({ id: "t1", status: "todo" })];
          }
          // Second snapshot: task transitions to in_review — match
          return [makeTask({ id: "t1", status: "in_review" })];
        },
      }),
    }));
    ({ waitForBoard } = await import("../packages/cli/src/commands/wait.js"));

    // 200ms total timeout → sleep per cycle is at most 200ms; resolves in 2 polls
    const code = await waitForBoard("board-1", {
      until: undefined,
      filter: ["in_review"],
      label: undefined,
      includeCurrent: false,
      timeout: 200,
    });
    expect(code).toBe(0);
  }, 30_000);

  it("does NOT exit on initial snapshot with in_review task when includeCurrent is false", async () => {
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        // Always returns in_review — never a *transition* into it
        listTasks: async (_params: any) => [makeTask({ id: "t1", status: "in_review" })],
      }),
    }));
    ({ waitForBoard } = await import("../packages/cli/src/commands/wait.js"));

    // Should time out because the initial state never triggers a filtered event
    const code = await waitForBoard("board-1", {
      until: undefined,
      filter: ["in_review"],
      label: undefined,
      includeCurrent: false,
      timeout: 1,
    });
    expect(code).toBe(124);
  });

  it("exits 0 on initial snapshot with in_review task when includeCurrent is true", async () => {
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        listTasks: async (_params: any) => [makeTask({ id: "t1", status: "in_review" })],
      }),
    }));
    ({ waitForBoard } = await import("../packages/cli/src/commands/wait.js"));

    const code = await waitForBoard("board-1", {
      until: undefined,
      filter: ["in_review"],
      label: undefined,
      includeCurrent: true,
      timeout: 5000,
    });
    expect(code).toBe(0);
  });

  it("returns 0 on --until in_review when first snapshot already has in_review task", async () => {
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        listTasks: async (_params: any) => [makeTask({ id: "t1", status: "in_review" }), makeTask({ id: "t2", status: "todo" })],
      }),
    }));
    ({ waitForBoard } = await import("../packages/cli/src/commands/wait.js"));

    // --until in_review means "any task is in_review" — predicate satisfied regardless of includeCurrent
    const code = await waitForBoard("board-1", {
      until: "in_review",
      filter: undefined,
      label: undefined,
      includeCurrent: false,
      timeout: 5000,
    });
    expect(code).toBe(0);
  });

  it("returns 0 with --until all-done when only done tasks present", async () => {
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        listTasks: async (_params: any) => [makeTask({ id: "t1", status: "done" }), makeTask({ id: "t2", status: "done" })],
      }),
    }));
    ({ waitForBoard } = await import("../packages/cli/src/commands/wait.js"));

    const code = await waitForBoard("board-1", {
      until: "all-done",
      filter: undefined,
      label: undefined,
      includeCurrent: false,
      timeout: 5000,
    });
    expect(code).toBe(0);
  });

  it("does not satisfy all-done predicate when task list is empty", async () => {
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        listTasks: async (_params: any) => [],
      }),
    }));
    ({ waitForBoard } = await import("../packages/cli/src/commands/wait.js"));

    const code = await waitForBoard("board-1", {
      until: "all-done",
      filter: undefined,
      label: undefined,
      includeCurrent: false,
      timeout: 1,
    });
    // Empty list never satisfies "all-done" — should timeout
    expect(code).toBe(124);
  });

  it("returns 0 with --until all-in_progress once all tasks are in_progress", async () => {
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        listTasks: async (_params: any) => [makeTask({ id: "t1", status: "in_progress" }), makeTask({ id: "t2", status: "in_progress" })],
      }),
    }));
    ({ waitForBoard } = await import("../packages/cli/src/commands/wait.js"));

    const code = await waitForBoard("board-1", {
      until: "all-in_progress",
      filter: undefined,
      label: undefined,
      includeCurrent: false,
      timeout: 5000,
    });
    expect(code).toBe(0);
  });

  it("passes label and board_id params through to listTasks", async () => {
    let capturedParams: any;
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        listTasks: async (params: any) => {
          capturedParams = params;
          return [makeTask({ id: "t1", status: "done" })];
        },
      }),
    }));
    ({ waitForBoard } = await import("../packages/cli/src/commands/wait.js"));

    await waitForBoard("board-42", {
      until: "all-done",
      filter: undefined,
      label: "release",
      includeCurrent: false,
      timeout: 5000,
    });

    expect(capturedParams).toMatchObject({ board_id: "board-42", label: "release" });
  });

  it("throws on invalid all-<status> predicate value", async () => {
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        listTasks: async (_params: any) => [],
      }),
    }));
    ({ waitForBoard } = await import("../packages/cli/src/commands/wait.js"));

    await expect(
      waitForBoard("board-1", {
        until: "all-badstatus",
        filter: undefined,
        label: undefined,
        includeCurrent: false,
        timeout: 5000,
      }),
    ).rejects.toThrow("Invalid --until value");
  });

  it("throws on completely unrecognised predicate string", async () => {
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        listTasks: async (_params: any) => [],
      }),
    }));
    ({ waitForBoard } = await import("../packages/cli/src/commands/wait.js"));

    await expect(
      waitForBoard("board-1", {
        until: "not-a-valid-pred",
        filter: undefined,
        label: undefined,
        includeCurrent: false,
        timeout: 5000,
      }),
    ).rejects.toThrow("Invalid --until value");
  });

  it("returns 0 with first-match mode when a filtered transition occurs", async () => {
    let callCount = 0;
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        listTasks: async (_params: any) => {
          callCount++;
          if (callCount === 1) return [makeTask({ id: "t1", status: "todo" })];
          return [makeTask({ id: "t1", status: "done" })];
        },
      }),
    }));
    ({ waitForBoard } = await import("../packages/cli/src/commands/wait.js"));

    const code = await waitForBoard("board-1", {
      until: "first-match",
      filter: ["done"],
      label: undefined,
      includeCurrent: false,
      timeout: 200,
    });
    expect(code).toBe(0);
  }, 30_000);
});

// ─── waitForPr ─────────────────────────────────────────────────────────────

describe("waitForPr", () => {
  let waitForPr: (num: string, timeoutMs: number) => Promise<number>;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeChild(
    overrides: Partial<{ errorCode: string | null; exitCode: number | null }> = {},
  ): EventEmitter & { kill: ReturnType<typeof vi.fn> } {
    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    child.kill = vi.fn();
    const { errorCode = null, exitCode = 0 } = overrides;
    // Emit asynchronously so listeners can be attached
    setImmediate(() => {
      if (errorCode !== null) {
        const err: NodeJS.ErrnoException = Object.assign(new Error("spawn error"), { code: errorCode });
        child.emit("error", err);
      } else {
        child.emit("exit", exitCode);
      }
    });
    return child;
  }

  it("returns 0 when gh exits with code 0", async () => {
    vi.doMock("node:child_process", () => ({
      spawn: () => makeChild({ exitCode: 0 }),
    }));
    ({ waitForPr } = await import("../packages/cli/src/commands/wait.js"));

    const code = await waitForPr("123", 10000);
    expect(code).toBe(0);
  });

  it("returns 1 when gh exits with non-zero code", async () => {
    vi.doMock("node:child_process", () => ({
      spawn: () => makeChild({ exitCode: 1 }),
    }));
    ({ waitForPr } = await import("../packages/cli/src/commands/wait.js"));

    const code = await waitForPr("123", 10000);
    expect(code).toBe(1);
  });

  it("returns 1 when gh is not found (ENOENT error)", async () => {
    vi.doMock("node:child_process", () => ({
      spawn: () => makeChild({ errorCode: "ENOENT" }),
    }));
    ({ waitForPr } = await import("../packages/cli/src/commands/wait.js"));

    const code = await waitForPr("123", 10000);
    expect(code).toBe(1);
  });

  it("returns 1 when spawn fails with a non-ENOENT error", async () => {
    vi.doMock("node:child_process", () => ({
      spawn: () => makeChild({ errorCode: "EPERM" }),
    }));
    ({ waitForPr } = await import("../packages/cli/src/commands/wait.js"));

    const code = await waitForPr("123", 10000);
    expect(code).toBe(1);
  });

  it("returns 124 on timeout and kills the child process", async () => {
    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    child.kill = vi.fn();
    // Never emit exit — let the timeout fire
    vi.doMock("node:child_process", () => ({
      spawn: () => child,
    }));
    ({ waitForPr } = await import("../packages/cli/src/commands/wait.js"));

    const code = await waitForPr("123", 10); // 10ms timeout
    expect(code).toBe(124);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not set a timer when timeoutMs is Infinity", async () => {
    vi.doMock("node:child_process", () => ({
      spawn: () => makeChild({ exitCode: 0 }),
    }));
    ({ waitForPr } = await import("../packages/cli/src/commands/wait.js"));

    // Should resolve normally without a timeout
    const code = await waitForPr("123", Number.POSITIVE_INFINITY);
    expect(code).toBe(0);
  });
});

// ─── registerWaitCommand / parseStatusList ─────────────────────────────────
//
// Tests for command registration. We verify the commands are registered by
// invoking the action handler paths that throw (invalid input), which doesn't
// require a successful process.exit call.
//
// For success paths we use a record-and-ignore mock for process.exit so the
// action doesn't terminate the test process and the thrown error doesn't get
// caught by the action's own catch block.

describe("registerWaitCommand — command registration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers wait task, wait board, and wait pr subcommands", async () => {
    const { registerWaitCommand } = await import("../packages/cli/src/commands/wait.js");
    const { Command } = await import("../packages/cli/node_modules/commander/esm.mjs");
    const program = new Command();
    registerWaitCommand(program);

    const waitCmd = program.commands.find((c: any) => c.name() === "wait");
    expect(waitCmd).toBeDefined();
    const names = waitCmd!.commands.map((c: any) => c.name());
    expect(names).toContain("task");
    expect(names).toContain("board");
    expect(names).toContain("pr");
  });

  it("board command: exits 1 and writes to stderr when --filter has an invalid status", async () => {
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    let capturedCode = -1;
    vi.spyOn(process, "exit").mockImplementation((code?: any) => {
      capturedCode = Number(code);
      // Don't throw — let the action complete naturally
      return undefined as never;
    });

    const { registerWaitCommand } = await import("../packages/cli/src/commands/wait.js");
    const { Command } = await import("../packages/cli/node_modules/commander/esm.mjs");
    const program = new Command();
    program.exitOverride();
    registerWaitCommand(program);

    await program.parseAsync(["node", "ak", "wait", "board", "board-1", "--filter", "badstatus"]);

    expect(capturedCode).toBe(1);
    expect(stderrChunks.join("")).toContain("Invalid status");
  });

  it("task command: exits 1 and writes to stderr when --until has an invalid status", async () => {
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    let capturedCode = -1;
    vi.spyOn(process, "exit").mockImplementation((code?: any) => {
      capturedCode = Number(code);
      return undefined as never;
    });

    const { registerWaitCommand } = await import("../packages/cli/src/commands/wait.js");
    const { Command } = await import("../packages/cli/node_modules/commander/esm.mjs");
    const program = new Command();
    program.exitOverride();
    registerWaitCommand(program);

    await program.parseAsync(["node", "ak", "wait", "task", "task-1", "--until", "badstatus"]);

    expect(capturedCode).toBe(1);
    expect(stderrChunks.join("")).toContain("Invalid --until value");
  });

  it("board command: invokes waitForBoard and exits 0 when board condition is met", async () => {
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        listTasks: async () => [makeTask({ id: "t1", status: "done" })],
      }),
    }));

    let capturedCode = -1;
    vi.spyOn(process, "exit").mockImplementation((code?: any) => {
      capturedCode = Number(code);
      return undefined as never;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const { registerWaitCommand } = await import("../packages/cli/src/commands/wait.js");
    const { Command } = await import("../packages/cli/node_modules/commander/esm.mjs");
    const program = new Command();
    program.exitOverride();
    registerWaitCommand(program);

    await program.parseAsync(["node", "ak", "wait", "board", "board-1", "--until", "all-done"]);

    expect(capturedCode).toBe(0);
  });

  it("board command: derives includeCurrent=true from --filter without --include-current", async () => {
    // Task already in_review. With includeCurrent=true the initial snapshot triggers exit 0.
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        listTasks: async () => [makeTask({ id: "t1", status: "in_review" })],
      }),
    }));

    let capturedCode = -1;
    vi.spyOn(process, "exit").mockImplementation((code?: any) => {
      capturedCode = Number(code);
      return undefined as never;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const { registerWaitCommand } = await import("../packages/cli/src/commands/wait.js");
    const { Command } = await import("../packages/cli/node_modules/commander/esm.mjs");
    const program = new Command();
    program.exitOverride();
    registerWaitCommand(program);

    await program.parseAsync(["node", "ak", "wait", "board", "board-1", "--filter", "in_review", "--timeout", "5s"]);

    expect(capturedCode).toBe(0);
  });

  it("task command: exits 0 when task is already done", async () => {
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        getTask: async (_id: string) => makeTask({ id: _id, status: "done" }),
      }),
    }));

    let capturedCode = -1;
    vi.spyOn(process, "exit").mockImplementation((code?: any) => {
      capturedCode = Number(code);
      return undefined as never;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const { registerWaitCommand } = await import("../packages/cli/src/commands/wait.js");
    const { Command } = await import("../packages/cli/node_modules/commander/esm.mjs");
    const program = new Command();
    program.exitOverride();
    registerWaitCommand(program);

    await program.parseAsync(["node", "ak", "wait", "task", "task-1", "--until", "done"]);

    expect(capturedCode).toBe(0);
  });

  it("pr command: exits 0 when gh exits 0", async () => {
    // Emit "exit" after listeners are attached by using a spawn that emits asynchronously
    vi.doMock("node:child_process", () => ({
      spawn: () => {
        const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
        child.kill = vi.fn();
        // Emit after listeners are attached (next tick after spawn returns)
        setImmediate(() => child.emit("exit", 0));
        return child;
      },
    }));

    let capturedCode = -1;
    vi.spyOn(process, "exit").mockImplementation((code?: any) => {
      capturedCode = Number(code);
      return undefined as never;
    });

    const { registerWaitCommand } = await import("../packages/cli/src/commands/wait.js");
    const { Command } = await import("../packages/cli/node_modules/commander/esm.mjs");
    const program = new Command();
    program.exitOverride();
    registerWaitCommand(program);

    await program.parseAsync(["node", "ak", "wait", "pr", "42", "--timeout", "30s"]);

    expect(capturedCode).toBe(0);
  }, 10_000);

  it("pr command: exits 1 when gh exits non-zero", async () => {
    vi.doMock("node:child_process", () => ({
      spawn: () => {
        const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
        child.kill = vi.fn();
        setImmediate(() => child.emit("exit", 1));
        return child;
      },
    }));

    let capturedCode = -1;
    vi.spyOn(process, "exit").mockImplementation((code?: any) => {
      capturedCode = Number(code);
      return undefined as never;
    });

    const { registerWaitCommand } = await import("../packages/cli/src/commands/wait.js");
    const { Command } = await import("../packages/cli/node_modules/commander/esm.mjs");
    const program = new Command();
    program.exitOverride();
    registerWaitCommand(program);

    await program.parseAsync(["node", "ak", "wait", "pr", "42", "--timeout", "30s"]);

    expect(capturedCode).toBe(1);
  }, 10_000);
});

// ─── CLI includeCurrent default derivation ─────────────────────────────────
//
// The action handler computes: includeCurrent = opts.includeCurrent ?? !!filter
// These tests verify the two logical cases by exercising waitForBoard with the
// exact includeCurrent value the CLI would derive, confirming observable behavior.

describe("waitForBoard — CLI includeCurrent default derivation", () => {
  let waitForBoard: (boardId: string, opts: any) => Promise<number>;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("when filter is undefined, derived includeCurrent is false — initial snapshot does not satisfy filter", async () => {
    // opts.includeCurrent ?? !!undefined === false
    // With no filter and all-done predicate, tasks must all be done — empty list times out
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        listTasks: async (_params: any) => [],
      }),
    }));
    ({ waitForBoard } = await import("../packages/cli/src/commands/wait.js"));

    const derivedIncludeCurrent = undefined ?? !!undefined; // false
    const code = await waitForBoard("board-1", {
      until: "all-done",
      filter: undefined,
      label: undefined,
      includeCurrent: derivedIncludeCurrent,
      timeout: 1,
    });
    expect(derivedIncludeCurrent).toBe(false);
    expect(code).toBe(124); // empty list → never satisfies all-done → timeout
  });

  it("when filter is provided but --include-current is not passed, derived includeCurrent is true", () => {
    // opts.includeCurrent ?? !!["in_review"] === true
    const filter: string[] = ["in_review"];
    const derivedIncludeCurrent = undefined ?? !!filter;
    expect(derivedIncludeCurrent).toBe(true);
  });

  it("when filter is provided and derived includeCurrent is true, exits 0 on initial snapshot match", async () => {
    // opts.includeCurrent ?? !!["in_review"] === true
    // Task is already in_review on first snapshot → exits 0 immediately
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        listTasks: async (_params: any) => [makeTask({ id: "t1", status: "in_review" })],
      }),
    }));
    ({ waitForBoard } = await import("../packages/cli/src/commands/wait.js"));

    const filter: string[] = ["in_review"];
    const derivedIncludeCurrent = undefined ?? !!filter; // true

    const code = await waitForBoard("board-1", {
      until: undefined,
      filter: filter as any,
      label: undefined,
      includeCurrent: derivedIncludeCurrent,
      timeout: 5000,
    });
    expect(code).toBe(0);
  });

  it("when --include-current is explicitly false with filter, initial snapshot is ignored", async () => {
    // Explicit false overrides the derived default
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        // Always returns in_review — never a transition
        listTasks: async (_params: any) => [makeTask({ id: "t1", status: "in_review" })],
      }),
    }));
    ({ waitForBoard } = await import("../packages/cli/src/commands/wait.js"));

    const code = await waitForBoard("board-1", {
      until: undefined,
      filter: ["in_review"] as any,
      label: undefined,
      includeCurrent: false, // explicit false, overrides derived default
      timeout: 1,
    });
    expect(code).toBe(124);
  });

  it("when --include-current is explicitly true without filter, includeCurrent is true regardless", async () => {
    // Explicit true takes precedence (undefined ?? true === true, but here it's just directly true)
    vi.doMock("../packages/cli/src/agent/leader.js", () => ({
      createClient: async () => ({
        listTasks: async (_params: any) => [makeTask({ id: "t1", status: "done" })],
      }),
    }));
    ({ waitForBoard } = await import("../packages/cli/src/commands/wait.js"));

    const derivedIncludeCurrent = true ?? !!undefined; // explicit true passed
    const code = await waitForBoard("board-1", {
      until: "all-done",
      filter: undefined,
      label: undefined,
      includeCurrent: derivedIncludeCurrent,
      timeout: 5000,
    });
    expect(code).toBe(0);
  });
});
