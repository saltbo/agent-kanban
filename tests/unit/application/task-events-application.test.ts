// @vitest-environment node

import type { Task, TaskStatus } from "@shared";
import { describe, expect, it, vi } from "vitest";
import {
  type TaskEventRepository,
  type TaskEventSnapshot,
  type TaskEventWaiter,
  waitForTaskEvents,
} from "../../../server/usecases/tasks/waitForTaskEvents";

function task(id: string, status: TaskStatus): Task {
  return { id, status } as Task;
}

function repository(...snapshots: TaskEventSnapshot[]): TaskEventRepository {
  let index = 0;
  return {
    readSnapshot: vi.fn(async () => snapshots[Math.min(index++, snapshots.length - 1)] ?? null),
  };
}

function waiter(): TaskEventWaiter & { pause: ReturnType<typeof vi.fn> } {
  let now = 0;
  return {
    now: () => now,
    pause: vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    }),
  };
}

const input = { ownerId: "tenant-a", taskIds: ["task-a"], until: "done" as const, cursor: null, maxWaitMs: 10_000 };

describe("waitForTaskEvents", () => {
  it("returns an immediate changed snapshot on the first call without pausing", async () => {
    const clock = waiter();
    await expect(waitForTaskEvents(repository({ offset: 3, tasks: [task("task-a", "in_progress")] }), clock, input)).resolves.toMatchObject({
      outcome: "changed",
      tasks: [{ id: "task-a", status: "in_progress" }],
      until: "done",
    });
    expect(clock.pause).not.toHaveBeenCalled();
  });

  it("returns reached only when every requested Task currently has the target status", async () => {
    const first = await waitForTaskEvents(repository({ offset: 4, tasks: [task("task-a", "done"), task("task-b", "in_progress")] }), waiter(), {
      ...input,
      taskIds: ["task-a", "task-b"],
    });
    expect(first.outcome).toBe("changed");
    await expect(
      waitForTaskEvents(repository({ offset: 5, tasks: [task("task-a", "done"), task("task-b", "done")] }), waiter(), {
        ...input,
        taskIds: ["task-a", "task-b"],
      }),
    ).resolves.toMatchObject({ outcome: "reached" });
  });

  it("uses current-all semantics after polling rather than remembering an earlier reached Task", async () => {
    const initial = await waitForTaskEvents(repository({ offset: 8, tasks: [task("task-a", "done"), task("task-b", "in_progress")] }), waiter(), {
      ...input,
      taskIds: ["task-a", "task-b"],
    });
    const clock = waiter();
    await expect(
      waitForTaskEvents(
        repository(
          { offset: 8, tasks: [task("task-a", "in_progress"), task("task-b", "in_progress")] },
          { offset: 9, tasks: [task("task-a", "in_progress"), task("task-b", "done")] },
        ),
        clock,
        { ...input, taskIds: ["task-a", "task-b"], cursor: initial.cursor },
      ),
    ).resolves.toMatchObject({ outcome: "changed", tasks: [{ status: "in_progress" }, { status: "done" }] });
    expect(clock.pause).toHaveBeenCalledOnce();
  });

  it("treats cancelled as unreachable for other targets but as an ordinary wait target", async () => {
    await expect(waitForTaskEvents(repository({ offset: 10, tasks: [task("task-a", "cancelled")] }), waiter(), input)).resolves.toMatchObject({
      outcome: "unreachable",
    });

    const initial = await waitForTaskEvents(repository({ offset: 10, tasks: [task("task-a", "todo"), task("task-b", "cancelled")] }), waiter(), {
      ...input,
      taskIds: ["task-a", "task-b"],
      until: "cancelled",
    });
    const clock = waiter();
    await expect(
      waitForTaskEvents(repository({ offset: 10, tasks: [task("task-a", "todo"), task("task-b", "cancelled")] }), clock, {
        ...input,
        taskIds: ["task-a", "task-b"],
        until: "cancelled",
        cursor: initial.cursor,
        maxWaitMs: 0,
      }),
    ).resolves.toMatchObject({ outcome: "timed_out" });
  });

  it("[spec: tasks/wait] returns changed for a newer cursor offset and timed_out without real waiting when unchanged", async () => {
    const initial = await waitForTaskEvents(repository({ offset: 11, tasks: [task("task-a", "in_progress")] }), waiter(), input);
    await expect(
      waitForTaskEvents(repository({ offset: 12, tasks: [task("task-a", "in_progress")] }), waiter(), { ...input, cursor: initial.cursor }),
    ).resolves.toMatchObject({ outcome: "changed" });

    const clock = waiter();
    await expect(
      waitForTaskEvents(repository({ offset: 11, tasks: [task("task-a", "in_progress")] }), clock, {
        ...input,
        cursor: initial.cursor,
        maxWaitMs: 4_500,
      }),
    ).resolves.toMatchObject({ outcome: "timed_out" });
    expect(clock.pause.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([2_000, 2_000, 500]);
  });

  it("binds a cursor to the normalized Task set and until condition", async () => {
    const initial = await waitForTaskEvents(repository({ offset: 1, tasks: [task("task-b", "todo"), task("task-a", "todo")] }), waiter(), {
      ...input,
      taskIds: ["task-b", "task-a"],
    });
    await expect(
      waitForTaskEvents(repository({ offset: 1, tasks: [task("task-a", "todo"), task("task-b", "todo")] }), waiter(), {
        ...input,
        taskIds: ["task-a", "task-b"],
        cursor: initial.cursor,
        maxWaitMs: 0,
      }),
    ).resolves.toMatchObject({ outcome: "timed_out" });
    await expect(
      waitForTaskEvents(repository({ offset: 1, tasks: [task("task-a", "todo")] }), waiter(), {
        ...input,
        cursor: initial.cursor,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(
      waitForTaskEvents(repository({ offset: 1, tasks: [task("task-b", "todo"), task("task-a", "todo")] }), waiter(), {
        ...input,
        taskIds: ["task-a", "task-b"],
        until: "in_review",
        cursor: initial.cursor,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("rejects the historical FNV collision pair as different Task sets", async () => {
    const first = "rujznff4f8tq";
    const collidingUnderFnv = "s2jqw9oegkky";
    const initial = await waitForTaskEvents(repository({ offset: 7, tasks: [task(first, "todo")] }), waiter(), {
      ...input,
      taskIds: [first],
    });

    await expect(
      waitForTaskEvents(repository({ offset: 7, tasks: [task(collidingUnderFnv, "todo")] }), waiter(), {
        ...input,
        taskIds: [collidingUnderFnv],
        cursor: initial.cursor,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(initial.cursor).toMatch(/^v1:7:[0-9a-f]{64}$/);
  });

  it("conceals a missing Task through the repository failure", async () => {
    await expect(waitForTaskEvents(repository(), waiter(), input)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});
