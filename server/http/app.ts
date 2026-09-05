import { authenticationMiddleware, csrfProtectionMiddleware, principalProvisioningMiddleware } from "@server/auth/middleware";
import type { Env } from "@server/env";
import { registerAgentRoutes } from "@server/http/agents/routes";
import { registerAuthRoutes } from "@server/http/auth/routes";
import { registerBoardRoutes } from "@server/http/boards/routes";
import { registerGithubApplicationRoutes, registerGithubSetupRedirectRoute, registerGithubWebhookRoutes } from "@server/http/github/routes";
import { registerMachineRoutes } from "@server/http/machines/routes";
import { createAccessLogMiddleware } from "@server/http/middleware/accessLog";
import { resourceServerErrorHandler } from "@server/http/middleware/idempotency";
import { requestContextMiddleware } from "@server/http/middleware/requestContext";
import { isPublishedV2Operation, v2ApiVersionMiddleware } from "@server/http/middleware/v2Contract";
import { registerPublicRoutes } from "@server/http/public/routes";
import { registerRepositoryRoutes } from "@server/http/repositories/routes";
import { registerResourceServerRoutes } from "@server/http/resource-server/routes";
import { registerTaskResourceRoutes } from "@server/http/tasks/resourceRoutes";
import { registerTaskWorkflowRoutes } from "@server/http/tasks/routes";
import { createLogger } from "@server/observability/logger";
import { Hono } from "hono";

const api = new Hono<{ Bindings: Env }>();
const logger = createLogger("api");

api.use("*", requestContextMiddleware);
api.use("*", createAccessLogMiddleware(logger));
api.onError(resourceServerErrorHandler);

// Public routes must be registered before the protected /api middleware.
registerAuthRoutes(api);
registerResourceServerRoutes(api);
registerGithubWebhookRoutes(api);
registerGithubSetupRedirectRoute(api);
registerPublicRoutes(api);
api.get("/api/ping", (c) => c.json({ pong: true }));

api.use("/api/*", (c, next) => (isPublishedV2Operation(c.req.method, c.req.path) ? v2ApiVersionMiddleware(c, next) : next()));
api.use("/api/*", (c, next) => (c.req.path.startsWith("/api/auth/") ? next() : authenticationMiddleware(c, next)));
api.use("/api/*", (c, next) => (c.req.path.startsWith("/api/auth/") ? next() : csrfProtectionMiddleware(c, next)));
api.use("/api/*", (c, next) => (c.req.path.startsWith("/api/auth/") ? next() : principalProvisioningMiddleware(c, next)));

registerTaskWorkflowRoutes(api);
registerTaskResourceRoutes(api);
registerBoardRoutes(api);
registerAgentRoutes(api);
registerMachineRoutes(api);
registerGithubApplicationRoutes(api);
registerRepositoryRoutes(api);

export { api };
