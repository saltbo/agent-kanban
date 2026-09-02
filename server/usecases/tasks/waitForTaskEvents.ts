import type { Task, TaskStatus } from "@shared";

export type TaskEventOutcome = "changed" | "reached" | "timed_out" | "unreachable";

export type TaskEventSnapshot = {
  offset: number;
  tasks: Task[];
};

export interface TaskEventRepository {
  readSnapshot(ownerId: string, taskIds: string[]): Promise<TaskEventSnapshot | null>;
}

export interface TaskEventWaiter {
  now(): number;
  pause(milliseconds: number): Promise<void>;
}

export type WaitForTaskEventsInput = {
  cursor: string | null;
  maxWaitMs: number;
  ownerId: string;
  taskIds: string[];
  until: TaskStatus;
};

export type TaskEventsResult = {
  cursor: string;
  outcome: TaskEventOutcome;
  tasks: Task[];
  until: TaskStatus;
};

export class TaskEventsFailure extends Error {
  constructor(
    readonly code: "INVALID_CURSOR" | "TASK_NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

const POLL_INTERVAL_MS = 2_000;

export async function waitForTaskEvents(
  repository: TaskEventRepository,
  waiter: TaskEventWaiter,
  input: WaitForTaskEventsInput,
): Promise<TaskEventsResult> {
  const cursorOffset = input.cursor === null ? null : await decodeCursor(input.cursor, input.taskIds, input.until);
  const deadline = waiter.now() + input.maxWaitMs;

  while (true) {
    const snapshot = await repository.readSnapshot(input.ownerId, input.taskIds);
    if (!snapshot) throw new TaskEventsFailure("TASK_NOT_FOUND", "One or more Tasks were not found in the authenticated tenant");

    const outcome = taskEventOutcome(snapshot.tasks, input.until);
    if (outcome || cursorOffset === null || snapshot.offset > cursorOffset) {
      return taskEventsResult(snapshot, input.taskIds, input.until, outcome ?? "changed");
    }

    const remaining = deadline - waiter.now();
    if (remaining <= 0) return taskEventsResult(snapshot, input.taskIds, input.until, "timed_out");
    await waiter.pause(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

function taskEventOutcome(tasks: Task[], until: TaskStatus): "reached" | "unreachable" | null {
  if (tasks.every((task) => task.status === until)) return "reached";
  if (until !== "cancelled" && tasks.some((task) => task.status === "cancelled")) return "unreachable";
  return null;
}

async function taskEventsResult(
  snapshot: TaskEventSnapshot,
  taskIds: string[],
  until: TaskStatus,
  outcome: TaskEventOutcome,
): Promise<TaskEventsResult> {
  return {
    cursor: await encodeCursor(snapshot.offset, taskIds, until),
    outcome,
    tasks: snapshot.tasks,
    until,
  };
}

async function encodeCursor(offset: number, taskIds: string[], until: TaskStatus): Promise<string> {
  return `v1:${offset}:${await cursorContext(taskIds, until)}`;
}

async function decodeCursor(cursor: string, taskIds: string[], until: TaskStatus): Promise<number> {
  const match = /^v1:(0|[1-9][0-9]*):([0-9a-f]{64})$/.exec(cursor);
  if (!match || match[2] !== (await cursorContext(taskIds, until))) {
    throw new TaskEventsFailure("INVALID_CURSOR", "Cursor is invalid for this Task set and wait condition");
  }
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset)) throw new TaskEventsFailure("INVALID_CURSOR", "Cursor offset is outside the supported range");
  return offset;
}

async function cursorContext(taskIds: string[], until: TaskStatus): Promise<string> {
  const value = `${[...taskIds].sort().join("\u001f")}\u001e${until}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
