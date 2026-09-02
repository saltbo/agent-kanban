import { d1TaskEventRepository } from "@server/adapters/d1/tasks/d1TaskEvents";
import type { Env } from "@server/env";
import { effectiveApiVersion, v2Problem } from "@server/http/middleware/v2Contract";
import { taskEventResource } from "@server/http/resource-server/representation";
import { decodeTaskEventCursor, encodeTaskEventCursor, type TaskEventCursorBinding } from "@server/http/resource-server/taskEventCursor";
import { type TaskContext, taskNotFound } from "@server/http/tasks/workflowSupport";
import { TaskEventsFailure, waitForTaskEvents } from "@server/usecases/tasks/waitForTaskEvents";
import { TASK_STATUSES, type TaskStatus } from "@shared";
import type { Hono } from "hono";

export function registerTaskEventRoutes(api: Hono<{ Bindings: Env }>): void {
  api.get("/api/task-events", waitForEvents);
}

async function waitForEvents(c: TaskContext): Promise<Response> {
  const url = new URL(c.req.url);
  const taskIds = [
    ...new Set(
      url.searchParams
        .getAll("taskId")
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (taskIds.length === 0 || taskIds.length > 50 || taskIds.some((taskId) => taskId.length > 200)) {
    return v2Problem(c, 400, "invalid-task-event-query", "Invalid Task Event query", "taskId must contain between 1 and 50 distinct Task IDs");
  }
  const rawUntil = url.searchParams.get("until");
  const until = rawUntil?.replaceAll("-", "_") as TaskStatus | undefined;
  if (!until || !TASK_STATUSES.includes(until)) {
    return v2Problem(
      c,
      400,
      "invalid-task-event-query",
      "Invalid Task Event query",
      `until must be one of ${TASK_STATUSES.map((status) => status.replaceAll("_", "-")).join(", ")}`,
    );
  }
  const publicCursor = url.searchParams.get("cursor");
  if (publicCursor !== null && publicCursor.length > 300) {
    return v2Problem(c, 400, "invalid-task-event-query", "Invalid Task Event query", "cursor must be at most 300 characters");
  }
  const rawWaitSeconds = url.searchParams.get("waitSeconds");
  if (rawWaitSeconds !== null && !/^(?:0|[1-9]|1[0-9]|2[0-5])$/.test(rawWaitSeconds)) {
    return v2Problem(c, 400, "invalid-task-event-query", "Invalid Task Event query", "waitSeconds must be an integer from 0 through 25");
  }

  try {
    const principal = c.get("principal");
    const cursorBinding: TaskEventCursorBinding = {
      tenantId: c.get("ownerId"),
      actorId: principal.actorId ?? principal.subjectId,
      apiVersion: effectiveApiVersion(c),
      taskIds,
      until,
    };
    const cursor = publicCursor === null ? null : await decodeTaskEventCursor(publicCursor, cursorBinding, c.env.AK_SIGNING_KEY);
    if (publicCursor !== null && cursor === null) {
      return v2Problem(c, 400, "invalid-task-event-cursor", "Invalid Task Event cursor", "Cursor is invalid, expired, or belongs to another caller");
    }
    const result = await waitForTaskEvents(
      d1TaskEventRepository(c.env.DB),
      { now: Date.now, pause: (milliseconds) => abortablePause(c.req.raw.signal, milliseconds) },
      { cursor, maxWaitMs: Number(rawWaitSeconds ?? "25") * 1_000, ownerId: c.get("ownerId"), taskIds, until },
    );
    return c.json(
      taskEventResource({ ...result, cursor: await encodeTaskEventCursor(result.cursor, cursorBinding, c.env.AK_SIGNING_KEY) }, c.req.url),
    );
  } catch (error) {
    if (!(error instanceof TaskEventsFailure)) throw error;
    if (error.code === "TASK_NOT_FOUND") return taskNotFound(c, error.message);
    return v2Problem(c, 400, "invalid-task-event-cursor", "Invalid Task Event cursor", error.message);
  }
}

function abortablePause(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
