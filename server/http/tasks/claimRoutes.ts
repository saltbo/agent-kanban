import { d1TaskClaimDeletionRepository } from "@server/adapters/d1/tasks/d1TaskClaimDeletions";
import { d1TaskClaimRepository } from "@server/adapters/d1/tasks/d1TaskClaims";
import type { Env } from "@server/env";
import { v2Problem } from "@server/http/middleware/v2Contract";
import { rejectRequestBody } from "@server/http/resource-server/request";
import {
  agentActorRequired,
  agentRuntimeSessionRequired,
  readStrongVersionPrecondition,
  resourceLocation,
  type TaskContext,
  taskNotFound,
  verifiedAgentActorId,
  verifiedAgentRuntimeSession,
} from "@server/http/tasks/workflowSupport";
import { deleteTaskClaim, TaskClaimDeletionFailure } from "@server/usecases/tasks/deleteTaskClaim";
import { replaceTaskClaim, TaskClaimFailure } from "@server/usecases/tasks/replaceTaskClaim";
import type { Hono } from "hono";

export function registerTaskClaimRoutes(api: Hono<{ Bindings: Env }>): void {
  api.put("/api/task-claims/:taskId", replaceClaim);
  api.delete("/api/task-claims/:taskId", deleteClaim);
}

async function replaceClaim(c: TaskContext): Promise<Response> {
  const bodyError = await rejectRequestBody(c, "Task Claim");
  if (bodyError) return bodyError;
  const agentActorId = verifiedAgentActorId(c);
  if (!agentActorId) return agentActorRequired(c);
  const execution = verifiedAgentRuntimeSession(c);
  if (!execution) return agentRuntimeSessionRequired(c);
  try {
    const result = await replaceTaskClaim(d1TaskClaimRepository(c.env.DB), {
      ownerId: c.get("ownerId"),
      taskId: c.req.param("taskId")!,
      agentActorId,
      runtime: execution.runtime,
      runtimeSessionId: execution.sessionId,
    });
    c.header("Location", resourceLocation(c, "task-claims", result.claim.taskId));
    c.header("ETag", `"${result.version}"`);
    return c.json(result.claim, result.created ? 201 : 200);
  } catch (error) {
    if (!(error instanceof TaskClaimFailure)) throw error;
    if (error.code === "TASK_NOT_FOUND") return taskNotFound(c, error.message);
    if (error.code === "TASK_CLAIM_FORBIDDEN") return v2Problem(c, 403, "task-claim-forbidden", "Task claim forbidden", error.message);
    return v2Problem(c, 409, "task-claim-conflict", "Task claim conflict", error.message);
  }
}

async function deleteClaim(c: TaskContext): Promise<Response> {
  const agentActorId = verifiedAgentActorId(c);
  if (!agentActorId) return agentActorRequired(c);
  const claimVersion = readStrongVersionPrecondition(c, "Task Claim");
  if (claimVersion instanceof Response) return claimVersion;
  try {
    await deleteTaskClaim(d1TaskClaimDeletionRepository(c.env.DB), {
      ownerId: c.get("ownerId"),
      taskId: c.req.param("taskId")!,
      expectedClaimVersion: claimVersion,
      deletedByActorId: agentActorId,
    });
    return c.body(null, 204);
  } catch (error) {
    if (!(error instanceof TaskClaimDeletionFailure)) throw error;
    if (error.code === "TASK_NOT_FOUND") return taskNotFound(c, error.message);
    if (error.code === "TASK_CLAIM_DELETION_FORBIDDEN") {
      return v2Problem(c, 403, "task-claim-deletion-forbidden", "Task Claim deletion forbidden", error.message);
    }
    if (error.code === "TASK_CLAIM_PRECONDITION_FAILED") {
      return v2Problem(c, 412, "task-claim-precondition-failed", "Task Claim precondition failed", error.message);
    }
    return v2Problem(c, 409, "task-claim-deletion-conflict", "Task Claim deletion conflict", error.message);
  }
}
