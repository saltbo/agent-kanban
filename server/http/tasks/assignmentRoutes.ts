import { d1TaskAssignmentRepository } from "@server/adapters/d1/tasks/d1TaskAssignments";
import { inboxTaskLifecycleNotifier } from "@server/adapters/realmroot/inboxTaskLifecycleNotifier";
import type { Env } from "@server/env";
import { v2Problem } from "@server/http/middleware/v2Contract";
import { actorRequired, mediaType, resourceLocation, type TaskContext, taskNotFound, taskWorkflowActor } from "@server/http/tasks/workflowSupport";
import { replaceTaskAssignment, TaskAssignmentFailure } from "@server/usecases/tasks/replaceTaskAssignment";
import { notifyTaskLifecycle } from "@server/usecases/tasks/taskLifecycleNotifications";
import type { Hono } from "hono";

export function registerTaskAssignmentRoutes(api: Hono<{ Bindings: Env }>): void {
  api.put("/api/task-assignments/:taskId", replaceAssignment);
}

async function replaceAssignment(c: TaskContext): Promise<Response> {
  const actor = taskWorkflowActor(c);
  if (!actor) return actorRequired(c);
  if (mediaType(c) !== "application/json") {
    return v2Problem(c, 415, "unsupported-media-type", "Unsupported media type", "Content-Type must be application/json");
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return v2Problem(c, 400, "invalid-json", "Invalid JSON", "The request body must be valid JSON");
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "agentActorId") ||
    typeof (body as { agentActorId?: unknown }).agentActorId !== "string" ||
    !(body as { agentActorId: string }).agentActorId.trim() ||
    (body as { agentActorId: string }).agentActorId.length > 200
  ) {
    return v2Problem(c, 422, "invalid-task-assignment", "Invalid Task assignment", "agentActorId is required and must be the only property");
  }

  try {
    const result = await replaceTaskAssignment(d1TaskAssignmentRepository(c.env.DB), {
      ownerId: c.get("ownerId"),
      taskId: c.req.param("taskId")!,
      assigneeActorId: (body as { agentActorId: string }).agentActorId,
      assignedByActorId: actor.id,
    });
    await notifyTaskLifecycle(inboxTaskLifecycleNotifier(c.env), {
      taskId: result.assignment.taskId,
      assigneeActorId: result.assignment.agentActorId,
      ownerId: c.get("ownerId"),
      event: "assigned",
      version: result.version,
    });
    c.header("Location", resourceLocation(c, "task-assignments", result.assignment.taskId));
    c.header("ETag", `"${result.version}"`);
    return c.json(result.assignment, result.created ? 201 : 200);
  } catch (error) {
    if (!(error instanceof TaskAssignmentFailure)) throw error;
    if (error.code === "TASK_NOT_FOUND") return taskNotFound(c, error.message);
    return v2Problem(c, 409, "task-assignment-conflict", "Task assignment conflict", error.message);
  }
}
