import type { Env } from "@server/env";
import { registerTaskAssignmentRoutes } from "@server/http/tasks/assignmentRoutes";
import { registerTaskCancellationRoutes } from "@server/http/tasks/cancellationRoutes";
import { registerTaskClaimRoutes } from "@server/http/tasks/claimRoutes";
import { registerTaskEventRoutes } from "@server/http/tasks/eventRoutes";
import { registerTaskReviewRoutes } from "@server/http/tasks/reviewRoutes";
import type { Hono } from "hono";

export function registerTaskWorkflowRoutes(api: Hono<{ Bindings: Env }>): void {
  registerTaskEventRoutes(api);
  registerTaskAssignmentRoutes(api);
  registerTaskClaimRoutes(api);
  registerTaskCancellationRoutes(api);
  registerTaskReviewRoutes(api);
}
