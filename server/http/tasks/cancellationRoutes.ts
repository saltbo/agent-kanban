import { d1TaskCancellationRepository } from "@server/adapters/d1/tasks/d1TaskCancellations";
import type { Env } from "@server/env";
import { v2Problem } from "@server/http/middleware/v2Contract";
import {
  actorRequired,
  rejectNonEmptyRepresentation,
  resourceLocation,
  type TaskContext,
  taskNotFound,
  taskWorkflowActor,
} from "@server/http/tasks/workflowSupport";
import { replaceTaskCancellation, TaskCancellationFailure } from "@server/usecases/tasks/replaceTaskCancellation";
import type { Hono } from "hono";

export function registerTaskCancellationRoutes(api: Hono<{ Bindings: Env }>): void {
  api.put("/api/task-cancellations/:taskId", replaceCancellation);
}

async function replaceCancellation(c: TaskContext): Promise<Response> {
  const actor = taskWorkflowActor(c);
  if (!actor) return actorRequired(c);
  const invalidBody = await rejectNonEmptyRepresentation(
    c,
    "invalid-task-cancellation",
    "Invalid Task Cancellation",
    "Task Cancellation has no client-writable properties",
  );
  if (invalidBody) return invalidBody;
  try {
    const result = await replaceTaskCancellation(d1TaskCancellationRepository(c.env.DB), {
      ownerId: c.get("ownerId"),
      taskId: c.req.param("taskId")!,
      actor,
    });
    c.header("Location", resourceLocation(c, "task-cancellations", result.cancellation.taskId));
    c.header("ETag", `"${result.version}"`);
    return c.json(result.cancellation, result.created ? 201 : 200);
  } catch (error) {
    if (!(error instanceof TaskCancellationFailure)) throw error;
    if (error.code === "TASK_NOT_FOUND") return taskNotFound(c, error.message);
    return v2Problem(c, 409, "task-cancellation-conflict", "Task cancellation conflict", error.message);
  }
}
