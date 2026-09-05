import { taskLaunchResources } from "@server/adapters/agency/taskLaunchResources";
import { d1TaskClaimRepository } from "@server/adapters/d1/tasks/d1TaskClaims";
import { d1TaskLaunchRepository } from "@server/adapters/d1/tasks/d1TaskLaunches";
import { authorizeScope } from "@server/auth/middleware";
import type { Env } from "@server/env";
import { idempotencyMiddleware } from "@server/http/middleware/idempotency";
import { v2Problem } from "@server/http/middleware/v2Contract";
import { agencyDependencies } from "@server/http/resource-server/agencyDependencies";
import { completeExternalCreation, rejectRequestBody, resourceIdempotencyFor } from "@server/http/resource-server/request";
import {
  agentRuntimeSessionRequired,
  requestActorId,
  type TaskContext,
  taskNotFound,
  verifiedAgentRuntimeSession,
} from "@server/http/tasks/workflowSupport";
import { recoverTaskClaimSession } from "@server/usecases/tasks/recoverTaskClaimSession";
import { replaceTaskClaim, TaskClaimFailure } from "@server/usecases/tasks/replaceTaskClaim";
import type { Hono } from "hono";

export function registerTaskClaimRoutes(api: Hono<{ Bindings: Env }>): void {
  api.post("/api/tasks/:taskId/claims", authorizeScope("task:claim"), idempotencyMiddleware, createClaim);
}

async function createClaim(c: TaskContext): Promise<Response> {
  const collection = `tasks/${encodeURIComponent(c.req.param("taskId")!)}/claims`;
  const response = await commitClaim(
    c,
    d1TaskClaimRepository(
      c.env.DB,
      resourceIdempotencyFor(
        c,
        collection,
        (claim) => claim.id,
        (claim) => claim,
        { includeResourceHeaders: false },
      ),
    ),
  );
  if (response instanceof Response) return response;
  const claim = { ...response.claim, id: response.version };
  if (!response.created) await completeExternalCreation(c, collection, claim.id, response.version, claim, 200, { includeResourceHeaders: false });
  return c.json(claim, response.created ? 201 : 200);
}

async function commitClaim(c: TaskContext, repository = d1TaskClaimRepository(c.env.DB)) {
  const bodyError = await rejectRequestBody(c, "Task Claim");
  if (bodyError) return bodyError;
  const agentActorId = requestActorId(c);
  const execution = verifiedAgentRuntimeSession(c);
  if (!execution) return agentRuntimeSessionRequired(c);
  try {
    await recoverTaskClaimSession(
      d1TaskLaunchRepository(c.env.DB),
      taskLaunchResources(async (ownerId, projectId) => {
        if (ownerId !== c.get("ownerId")) throw new Error("Task recovery tenant mismatch");
        const agency = await agencyDependencies(c, ["sessions:write"]);
        if (agency.projectId !== projectId) throw new Error("Task recovery Project mismatch");
        return agency.client;
      }).create,
      { ownerId: c.get("ownerId"), taskId: c.req.param("taskId")!, agentActorId },
    );
    return await replaceTaskClaim(repository, {
      ownerId: c.get("ownerId"),
      taskId: c.req.param("taskId")!,
      agentActorId,
      runtime: execution.runtime,
      runtimeSessionId: execution.sessionId,
    });
  } catch (error) {
    if (!(error instanceof TaskClaimFailure)) throw error;
    if (error.code === "TASK_NOT_FOUND") return taskNotFound(c, error.message);
    if (error.code === "TASK_CLAIM_FORBIDDEN") return v2Problem(c, 403, "task-claim-forbidden", "Task claim forbidden", error.message);
    return v2Problem(c, 409, "task-claim-conflict", "Task claim conflict", error.message);
  }
}
