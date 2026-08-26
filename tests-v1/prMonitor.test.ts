// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process so getPrState never shells out
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

// Mock pino logger so output goes through console with [LEVEL] prefixes
vi.mock("../packages/cli/src/logger.js", () => ({
  createLogger: () => ({
    info: (msg: string) => console.log(`[INFO] ${msg}`),
    warn: (msg: string) => console.log(`[WARN] ${msg}`),
    error: (msg: string) => console.error(`[ERROR] ${msg}`),
    debug: (msg: string) => console.log(`[DEBUG] ${msg}`),
    fatal: (msg: string) => console.error(`[FATAL] ${msg}`),
  }),
}));

// Mock fs so saveTrackedTasks/loadTrackedTasks never touches disk
vi.mock("fs", () => ({
  readFileSync: vi.fn().mockImplementation(() => {
    throw new Error("ENOENT");
  }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { PrMonitor } from "../packages/cli/src/daemon/prMonitor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExecSync(returnValue: string | Error) {
  if (returnValue instanceof Error) {
    vi.mocked(execSync).mockImplementation(() => {
      throw returnValue;
    });
  } else {
    vi.mocked(execSync).mockReturnValue(Buffer.from(`${returnValue}\n`) as any);
  }
}

function makeClient(
  overrides: Partial<{
    completeTask: () => Promise<unknown>;
    cancelTask: () => Promise<unknown>;
    getTask: () => Promise<unknown>;
  }> = {},
) {
  return {
    completeTask: vi.fn().mockResolvedValue({}),
    cancelTask: vi.fn().mockResolvedValue({}),
    getTask: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as any;
}

/** Trigger one check() cycle by advancing fake timers. */
async function runCheck(monitor: PrMonitor) {
  // check() is private and called via setInterval. We call it through the
  // public track+start flow but bypass the timer by invoking the private
  // method directly via cast.
  await (monitor as any).check();
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default: execSync throws so getPrState returns null
  vi.mocked(execSync).mockImplementation(() => {
    throw new Error("gh: not found");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Consecutive failure counter (failureCount)
// ---------------------------------------------------------------------------

describe("PrMonitor — consecutive failure counter (failureCount)", () => {
  it("logs [WARN] on the first error from completeTask", async () => {
    makeExecSync("MERGED");

    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({
        status: "in_review",
        pr_url: "https://github.com/org/repo/pull/1",
      }),
      completeTask: vi.fn().mockRejectedValue(new Error("network error")),
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCheck(monitor);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[WARN]"));
    spy.mockRestore();
  });

  it("does not log [ERROR] for failures below 10", async () => {
    makeExecSync("MERGED");

    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({
        status: "in_review",
        pr_url: "https://github.com/org/repo/pull/1",
      }),
      completeTask: vi.fn().mockRejectedValue(new Error("fail")),
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    for (let i = 0; i < 9; i++) {
      await runCheck(monitor);
    }

    const errorCalls = spy.mock.calls.filter((args) => String(args[0]).includes("[ERROR]"));
    expect(errorCalls).toHaveLength(0);
    spy.mockRestore();
  });

  it("logs [ERROR] exactly at failure count 10", async () => {
    makeExecSync("MERGED");

    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({
        status: "in_review",
        pr_url: "https://github.com/org/repo/pull/1",
      }),
      completeTask: vi.fn().mockRejectedValue(new Error("fail")),
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    for (let i = 0; i < 10; i++) {
      await runCheck(monitor);
    }

    const errorCalls = spy.mock.calls.filter((args) => String(args[0]).includes("[ERROR]"));
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0][0]).toContain("10 consecutive");
    spy.mockRestore();
  });

  it("logs [ERROR] again at failure count 20 (every 10th after 10)", async () => {
    makeExecSync("MERGED");

    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({
        status: "in_review",
        pr_url: "https://github.com/org/repo/pull/1",
      }),
      completeTask: vi.fn().mockRejectedValue(new Error("fail")),
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    for (let i = 0; i < 20; i++) {
      await runCheck(monitor);
    }

    const errorCalls = spy.mock.calls.filter((args) => String(args[0]).includes("[ERROR]"));
    // One at count=10, one at count=20
    expect(errorCalls).toHaveLength(2);
    spy.mockRestore();
  });

  it("does not log [ERROR] at count 11 (between multiples of 10)", async () => {
    makeExecSync("MERGED");

    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({
        status: "in_review",
        pr_url: "https://github.com/org/repo/pull/1",
      }),
      completeTask: vi.fn().mockRejectedValue(new Error("fail")),
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    for (let i = 0; i < 11; i++) {
      await runCheck(monitor);
    }

    const errorCalls = spy.mock.calls.filter((args) => String(args[0]).includes("[ERROR]"));
    // Only one at count=10, not again at count=11
    expect(errorCalls).toHaveLength(1);
    spy.mockRestore();
  });

  it("resets failureCount to 0 on a successful check", async () => {
    makeExecSync("MERGED");

    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({
        status: "in_review",
        pr_url: "https://github.com/org/repo/pull/1",
      }),
      completeTask: vi.fn().mockRejectedValueOnce(new Error("fail")).mockRejectedValueOnce(new Error("fail")).mockResolvedValue({}), // Success
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Two failures then a success
    await runCheck(monitor);
    await runCheck(monitor);
    await runCheck(monitor);

    // Now fail 9 more times — should NOT hit [ERROR] at count=10 because
    // the counter was reset
    client.completeTask = vi.fn().mockRejectedValue(new Error("fail"));
    for (let i = 0; i < 9; i++) {
      await runCheck(monitor);
    }

    const errorCalls = spy.mock.calls.filter((args) => String(args[0]).includes("[ERROR]"));
    expect(errorCalls).toHaveLength(0);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Per-task failure tracking (taskFailures)
// ---------------------------------------------------------------------------

describe("PrMonitor — per-task failure tracking (taskFailures)", () => {
  it("does not warn for fewer than 20 consecutive getPrState failures on a task", async () => {
    makeExecSync(new Error("gh: not found"));

    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({
        status: "in_review",
        pr_url: "https://github.com/org/repo/pull/1",
      }),
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    for (let i = 0; i < 19; i++) {
      await runCheck(monitor);
    }

    const warnCalls = spy.mock.calls.filter((args) => String(args[0]).includes("[WARN]") && String(args[0]).includes("task-1"));
    expect(warnCalls).toHaveLength(0);
    spy.mockRestore();
  });

  it("logs [WARN] for a task at exactly 20 consecutive getPrState failures", async () => {
    makeExecSync(new Error("gh: not found"));

    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({
        status: "in_review",
        pr_url: "https://github.com/org/repo/pull/1",
      }),
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    for (let i = 0; i < 20; i++) {
      await runCheck(monitor);
    }

    const warnCalls = spy.mock.calls.filter((args) => String(args[0]).includes("[WARN]") && String(args[0]).includes("task-1"));
    expect(warnCalls).toHaveLength(1);
    spy.mockRestore();
  });

  it("logs the [WARN] message only once, not on the 21st failure", async () => {
    makeExecSync(new Error("gh: not found"));

    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({
        status: "in_review",
        pr_url: "https://github.com/org/repo/pull/1",
      }),
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    for (let i = 0; i < 21; i++) {
      await runCheck(monitor);
    }

    const warnCalls = spy.mock.calls.filter((args) => String(args[0]).includes("[WARN]") && String(args[0]).includes("task-1"));
    expect(warnCalls).toHaveLength(1);
    spy.mockRestore();
  });

  it("clears per-task failure count on successful getPrState (task stays OPEN)", async () => {
    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({
        status: "in_review",
        pr_url: "https://github.com/org/repo/pull/1",
      }),
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    // 19 failures
    makeExecSync(new Error("fail"));
    for (let i = 0; i < 19; i++) {
      await runCheck(monitor);
    }

    // One success (OPEN) — resets the counter
    makeExecSync("OPEN");
    await runCheck(monitor);

    // 19 more failures — should NOT trigger the [WARN] because counter reset
    makeExecSync(new Error("fail"));
    for (let i = 0; i < 19; i++) {
      await runCheck(monitor);
    }

    const warnCalls = spy.mock.calls.filter((args) => String(args[0]).includes("[WARN]") && String(args[0]).includes("task-1"));
    expect(warnCalls).toHaveLength(0);
    spy.mockRestore();
  });

  it("clears per-task failure count when task is untracked", async () => {
    makeExecSync(new Error("gh: not found"));

    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({
        status: "in_review",
        pr_url: "https://github.com/org/repo/pull/1",
      }),
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    // 19 failures
    for (let i = 0; i < 19; i++) {
      await runCheck(monitor);
    }

    // Explicitly untrack — clears task failure count
    monitor.untrack("task-1");
    monitor.track("task-1");

    // 20 more failures — the counter restarted, so [WARN] fires once at 20
    for (let i = 0; i < 20; i++) {
      await runCheck(monitor);
    }

    const warnCalls = spy.mock.calls.filter((args) => String(args[0]).includes("[WARN]") && String(args[0]).includes("task-1"));
    // Exactly one warn after the clean restart
    expect(warnCalls).toHaveLength(1);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Task status detection (done/cancelled/deleted)
// ---------------------------------------------------------------------------

describe("PrMonitor — task status detection", () => {
  it("untracks task when getTask throws (task deleted)", async () => {
    const client = makeClient({
      getTask: vi.fn().mockRejectedValue(new Error("Task not found")),
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    await runCheck(monitor);

    expect((monitor as any).trackedTasks.has("task-1")).toBe(false);
  });

  it("untracks task when status is done", async () => {
    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({ status: "done", pr_url: "https://github.com/org/repo/pull/1" }),
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCheck(monitor);

    expect((monitor as any).trackedTasks.has("task-1")).toBe(false);
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/\[INFO\].*task-1.*done.*untracking/));
    spy.mockRestore();
  });

  it("untracks task when status is cancelled", async () => {
    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({ status: "cancelled" }),
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCheck(monitor);

    expect((monitor as any).trackedTasks.has("task-1")).toBe(false);
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/\[INFO\].*task-1.*cancelled.*untracking/));
    spy.mockRestore();
  });

  it("untracks task when getTask returns null", async () => {
    const client = makeClient({
      getTask: vi.fn().mockResolvedValue(null),
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCheck(monitor);

    expect((monitor as any).trackedTasks.has("task-1")).toBe(false);
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/\[INFO\].*task-1.*unknown.*untracking/));
    spy.mockRestore();
  });

  it("keeps tracking task with active status", async () => {
    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({ status: "in_progress" }),
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    await runCheck(monitor);

    expect((monitor as any).trackedTasks.has("task-1")).toBe(true);
  });

  it("untracks multiple done/cancelled tasks in a single check", async () => {
    const client = makeClient({
      getTask: vi
        .fn()
        .mockResolvedValueOnce({ status: "done" }) // task-1 done → untrack
        .mockResolvedValueOnce({ status: "cancelled" }) // task-2 cancelled → untrack
        .mockResolvedValueOnce({ status: "in_progress" }), // task-3 active → keep
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");
    monitor.track("task-2");
    monitor.track("task-3");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCheck(monitor);

    expect((monitor as any).trackedTasks.has("task-1")).toBe(false);
    expect((monitor as any).trackedTasks.has("task-2")).toBe(false);
    expect((monitor as any).trackedTasks.has("task-3")).toBe(true);

    const untrackCalls = spy.mock.calls.filter((args) => String(args[0]).includes("untracking"));
    expect(untrackCalls).toHaveLength(2);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Happy path — MERGED and CLOSED PR states
// ---------------------------------------------------------------------------

describe("PrMonitor — PR state transitions", () => {
  it("calls completeTask when PR state is MERGED", async () => {
    makeExecSync("MERGED");

    const completeTask = vi.fn().mockResolvedValue({});
    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({
        status: "in_review",
        pr_url: "https://github.com/org/repo/pull/1",
      }),
      completeTask,
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    await runCheck(monitor);

    expect(completeTask).toHaveBeenCalledWith("task-1");
  });

  it("calls cancelTask when PR state is CLOSED", async () => {
    makeExecSync("CLOSED");

    const cancelTask = vi.fn().mockResolvedValue({});
    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({
        status: "in_review",
        pr_url: "https://github.com/org/repo/pull/1",
      }),
      cancelTask,
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    await runCheck(monitor);

    expect(cancelTask).toHaveBeenCalledWith("task-1");
  });

  it("checks PR state for tasks in any status with pr_url (not just in_review)", async () => {
    makeExecSync("MERGED");

    const completeTask = vi.fn().mockResolvedValue({});
    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({
        status: "in_progress", // Not in_review, but has pr_url
        pr_url: "https://github.com/org/repo/pull/1",
      }),
      completeTask,
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    await runCheck(monitor);

    expect(completeTask).toHaveBeenCalledWith("task-1");
  });

  it("skips PR check for tasks without pr_url", async () => {
    const completeTask = vi.fn().mockResolvedValue({});
    const cancelTask = vi.fn().mockResolvedValue({});
    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({
        status: "in_review",
        // No pr_url
      }),
      completeTask,
      cancelTask,
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    await runCheck(monitor);

    // PR check should be skipped entirely
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
    expect(completeTask).not.toHaveBeenCalled();
    expect(cancelTask).not.toHaveBeenCalled();
  });

  it("does not call completeTask or cancelTask when PR state is OPEN", async () => {
    makeExecSync("OPEN");

    const completeTask = vi.fn().mockResolvedValue({});
    const cancelTask = vi.fn().mockResolvedValue({});
    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({
        status: "in_review",
        pr_url: "https://github.com/org/repo/pull/1",
      }),
      completeTask,
      cancelTask,
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    await runCheck(monitor);

    expect(completeTask).not.toHaveBeenCalled();
    expect(cancelTask).not.toHaveBeenCalled();
  });

  it("untracks the task after a MERGED PR", async () => {
    makeExecSync("MERGED");

    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({
        status: "in_review",
        pr_url: "https://github.com/org/repo/pull/1",
      }),
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    await runCheck(monitor);

    expect((monitor as any).trackedTasks.has("task-1")).toBe(false);
  });

  it("untracks the task after a CLOSED PR", async () => {
    makeExecSync("CLOSED");

    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({
        status: "in_review",
        pr_url: "https://github.com/org/repo/pull/1",
      }),
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    await runCheck(monitor);

    expect((monitor as any).trackedTasks.has("task-1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guard: skip check when nothing is tracked or already running
// ---------------------------------------------------------------------------

describe("PrMonitor — check guard conditions", () => {
  it("does not call getTask when no tasks are tracked", async () => {
    const getTask = vi.fn().mockResolvedValue(null);
    const monitor = new PrMonitor(makeClient({ getTask }));

    await runCheck(monitor);

    expect(getTask).not.toHaveBeenCalled();
  });

  it("does not call getTask on a concurrent overlapping check", async () => {
    makeExecSync("OPEN");

    // getTask resolves on the next tick to allow overlap simulation
    let resolveFirst!: () => void;
    const firstCall = new Promise<any>((res) => {
      resolveFirst = () => res({ status: "in_progress", pr_url: "https://github.com/org/repo/pull/1" });
    });
    const getTask = vi.fn().mockReturnValueOnce(firstCall).mockResolvedValue({ status: "in_progress" });

    const monitor = new PrMonitor(makeClient({ getTask }));
    monitor.track("task-1");

    // Start first check but don't await yet
    const first = runCheck(monitor);
    // Start second check while first is still in flight
    const second = runCheck(monitor);

    resolveFirst();
    await Promise.all([first, second]);

    // Second check should be skipped entirely because checking flag was set
    expect(getTask).toHaveBeenCalledTimes(1);
  });

  it("processes all tracked tasks in a single check", async () => {
    makeExecSync("OPEN");

    const getTask = vi
      .fn()
      .mockResolvedValueOnce({ status: "in_progress", pr_url: "https://github.com/org/repo/pull/1" })
      .mockResolvedValueOnce({ status: "in_review", pr_url: "https://github.com/org/repo/pull/2" })
      .mockResolvedValueOnce({ status: "todo" }); // No pr_url

    const monitor = new PrMonitor(makeClient({ getTask }));
    monitor.track("task-1");
    monitor.track("task-2");
    monitor.track("task-3");

    await runCheck(monitor);

    expect(getTask).toHaveBeenCalledTimes(3);
    expect(getTask).toHaveBeenCalledWith("task-1");
    expect(getTask).toHaveBeenCalledWith("task-2");
    expect(getTask).toHaveBeenCalledWith("task-3");
  });
});

// ---------------------------------------------------------------------------
// New simplified behavior tests
// ---------------------------------------------------------------------------

describe("PrMonitor — simplified one-pass behavior", () => {
  it("handles mixed task states and PR outcomes in one pass", async () => {
    const getTask = vi
      .fn()
      .mockResolvedValueOnce({ status: "done" }) // task-1: done → untrack
      .mockRejectedValueOnce(new Error("Not found")) // task-2: deleted → untrack
      .mockResolvedValueOnce({ status: "in_progress", pr_url: "https://github.com/org/repo/pull/3" }) // task-3: MERGED → complete + untrack
      .mockResolvedValueOnce({ status: "in_review", pr_url: "https://github.com/org/repo/pull/4" }) // task-4: CLOSED → cancel + untrack
      .mockResolvedValueOnce({ status: "in_review", pr_url: "https://github.com/org/repo/pull/5" }) // task-5: OPEN → continue tracking
      .mockResolvedValueOnce({ status: "todo" }); // task-6: no pr_url → continue tracking

    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from("MERGED")) // task-3
      .mockReturnValueOnce(Buffer.from("CLOSED")) // task-4
      .mockReturnValueOnce(Buffer.from("OPEN")); // task-5

    const completeTask = vi.fn().mockResolvedValue({});
    const cancelTask = vi.fn().mockResolvedValue({});
    const client = makeClient({ getTask, completeTask, cancelTask });

    const monitor = new PrMonitor(client);
    monitor.track("task-1");
    monitor.track("task-2");
    monitor.track("task-3");
    monitor.track("task-4");
    monitor.track("task-5");
    monitor.track("task-6");

    await runCheck(monitor);

    // Verify API calls
    expect(getTask).toHaveBeenCalledTimes(6);
    expect(completeTask).toHaveBeenCalledWith("task-3");
    expect(cancelTask).toHaveBeenCalledWith("task-4");

    // Verify tracking state
    const trackedTasks = (monitor as any).trackedTasks;
    expect(trackedTasks.has("task-1")).toBe(false); // done → untracked
    expect(trackedTasks.has("task-2")).toBe(false); // deleted → untracked
    expect(trackedTasks.has("task-3")).toBe(false); // merged → untracked
    expect(trackedTasks.has("task-4")).toBe(false); // closed → untracked
    expect(trackedTasks.has("task-5")).toBe(true); // open → still tracked
    expect(trackedTasks.has("task-6")).toBe(true); // no pr_url → still tracked
  });

  it("increments task failure count when getPrState fails but task is still active", async () => {
    const client = makeClient({
      getTask: vi.fn().mockResolvedValue({
        status: "in_review",
        pr_url: "https://github.com/org/repo/pull/1",
      }),
    });
    const monitor = new PrMonitor(client);
    monitor.track("task-1");

    // First check: gh command fails
    makeExecSync(new Error("gh auth required"));
    await runCheck(monitor);

    // Task should still be tracked
    expect((monitor as any).trackedTasks.has("task-1")).toBe(true);
    expect((monitor as any).taskFailures.get("task-1")).toBe(1);

    // Second check: gh command succeeds
    makeExecSync("OPEN");
    await runCheck(monitor);

    // Task failure count should be cleared
    expect((monitor as any).taskFailures.has("task-1")).toBe(false);
  });

  it("handles tasks in any status with pr_url correctly", async () => {
    const getTask = vi
      .fn()
      .mockResolvedValueOnce({ status: "todo", pr_url: "https://github.com/org/repo/pull/1" })
      .mockResolvedValueOnce({ status: "in_progress", pr_url: "https://github.com/org/repo/pull/2" })
      .mockResolvedValueOnce({ status: "in_review", pr_url: "https://github.com/org/repo/pull/3" });

    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from("MERGED")) // todo with merged PR
      .mockReturnValueOnce(Buffer.from("CLOSED")) // in_progress with closed PR
      .mockReturnValueOnce(Buffer.from("OPEN")); // in_review with open PR

    const completeTask = vi.fn().mockResolvedValue({});
    const cancelTask = vi.fn().mockResolvedValue({});
    const client = makeClient({ getTask, completeTask, cancelTask });

    const monitor = new PrMonitor(client);
    monitor.track("task-1");
    monitor.track("task-2");
    monitor.track("task-3");

    await runCheck(monitor);

    // All PR states should be checked regardless of task status
    expect(completeTask).toHaveBeenCalledWith("task-1");
    expect(cancelTask).toHaveBeenCalledWith("task-2");

    // Verify tracking state
    const trackedTasks = (monitor as any).trackedTasks;
    expect(trackedTasks.has("task-1")).toBe(false); // merged → untracked
    expect(trackedTasks.has("task-2")).toBe(false); // closed → untracked
    expect(trackedTasks.has("task-3")).toBe(true); // open → still tracked
  });
});
