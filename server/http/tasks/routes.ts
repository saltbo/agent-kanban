import type { Env } from "@server/env";
import { registerTaskClaimRoutes } from "@server/http/tasks/claimRoutes";
import { registerTaskEventRoutes } from "@server/http/tasks/eventRoutes";
import type { Hono } from "hono";

export function registerTaskWorkflowRoutes(api: Hono<{ Bindings: Env }>): void {
  registerTaskEventRoutes(api);
  registerTaskClaimRoutes(api);
}
