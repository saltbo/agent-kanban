import { d1TaskClaimDeletionRepository } from "@server/adapters/d1/tasks/d1TaskClaimDeletions";
import { d1TaskClaimRepository } from "@server/adapters/d1/tasks/d1TaskClaims";
import { authorizeScope } from "@server/auth/middleware";
import type { Env } from "@server/env";
import { idempotencyMiddleware } from "@server/http/middleware/idempotency";
import { v2Problem } from "@server/http/middleware/v2Contract";
import { completeExternalCreation, rejectRequestBody, resourceIdempotencyFor } from "@server/http/resource-server/request";
import {
  agentRuntimeSessionRequired,
  readStrongVersionPrecondition,
  requestActorId,
  type TaskContext,
  taskNotFound,
  verifiedAgentRuntimeSession,
} from "@server/http/tasks/workflowSupport";
import { deleteTaskClaim, TaskClaimDeletionFailure } from "@server/usecases/tasks/deleteTaskClaim";
import { replaceTaskClaim, TaskClaimFailure } from "@server/usecases/tasks/replaceTaskClaim";
import type { Hono } from "hono";

export function registerTaskClaimRoutes(api: Hono<{ Bindings: Env }>): void {
  api.post("/api/tasks/:taskId/claims", authorizeScope("task:claim"), idempotencyMiddleware, createClaim);
  api.get("/api/tasks/:taskId/claims/:claimId", authorizeScope("task:read"), getClaim);
  api.delete("/api/tasks/:taskId/claims/:claimId", authorizeScope("task:release"), deleteClaimResource);
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
      ),
    ),
  );
  if (response instanceof Response) return response;
  const claim = { ...response.claim, id: response.version };
  const location = new URL(`/api/tasks/${encodeURIComponent(claim.taskId)}/claims/${encodeURIComponent(claim.id)}`, c.req.url).toString();
  c.header("Location", location);
  c.header("ETag", `"${response.version}"`);
  if (!response.created) await completeExternalCreation(c, collection, claim.id, response.version, claim, 200);
  return c.json(claim, response.created ? 201 : 200);
}

async function getClaim(c: TaskContext): Promise<Response> {
  const target = await d1TaskClaimRepository(c.env.DB).findTarget(c.get("ownerId"), c.req.param("taskId")!);
  if (!target) return taskNotFound(c, "Task not found");
  const claim = target.activeClaim;
  if (!claim || claim.actionId !== c.req.param("claimId")) {
    return v2Problem(c, 404, "task-claim-not-found", "Task Claim not found", "Task Claim not found");
  }
  c.header("ETag", `"${claim.actionId}"`);
  return c.json({
    id: claim.actionId,
    taskId: c.req.param("taskId")!,
    agentActorId: target.assignedTo,
    runtime: claim.runtime,
    runtimeSessionId: claim.runtimeSessionId,
    claimedAt: claim.claimedAt,
  });
}

async function deleteClaimResource(c: TaskContext): Promise<Response> {
  const claimVersion = readStrongVersionPrecondition(c, "Task Claim");
  if (claimVersion instanceof Response) return claimVersion;
  if (claimVersion !== c.req.param("claimId")) {
    return v2Problem(
      c,
      412,
      "task-claim-precondition-failed",
      "Task Claim precondition failed",
      "If-Match does not identify the requested Task Claim",
    );
  }
  return releaseClaim(c, claimVersion);
}

async function commitClaim(c: TaskContext, repository = d1TaskClaimRepository(c.env.DB)) {
  const bodyError = await rejectRequestBody(c, "Task Claim");
  if (bodyError) return bodyError;
  const agentActorId = requestActorId(c);
  const execution = verifiedAgentRuntimeSession(c);
  if (!execution) return agentRuntimeSessionRequired(c);
  try {
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

async function releaseClaim(c: TaskContext, claimVersion: string): Promise<Response> {
  const agentActorId = requestActorId(c);
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
