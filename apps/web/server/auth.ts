import type { Context, MiddlewareHandler } from "hono";
import { errors as joseErrors } from "jose";
import { AccessRepo } from "./accessRepo";
import { resolveAmaActorAgentId } from "./ama";
import { AmaBindingRepo } from "./amaBindingRepo";
import { ApiProblem } from "./contract";
import { AuthError, authenticateRealmrootToken, authenticateWebSession, CsrfError } from "./realmrootAuth";
import type { Env, Principal } from "./types";

export const authenticationMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  try {
    const developmentPrincipal = devPrincipal(c);
    const authorization = c.req.header("authorization");
    if (!developmentPrincipal && authorization) validateAuthorizationSyntax(authorization);
    const principal = developmentPrincipal ?? (authorization ? await authenticateRealmrootToken(c) : await authenticateWebSession(c));
    if (!principal) throw new ApiProblem(401, "unauthorized", "Unauthorized", "Authentication is required.");
    c.set("principal", principal);
    c.set("ownerId", principal.tenantId);
    const requiredScope = operationScope(c.req.path, c.req.method);
    if (!principal.scopes.includes(requiredScope))
      throw new ApiProblem(403, "insufficient-scope", "Forbidden", `The ${requiredScope} scope is required.`);
    await next();
  } catch (error) {
    if (error instanceof ApiProblem) throw error;
    if (error instanceof CsrfError) throw new ApiProblem(403, "csrf-invalid", "Forbidden", error.message);
    if (error instanceof AuthError || error instanceof joseErrors.JOSEError)
      throw new ApiProblem(401, "invalid-credentials", "Unauthorized", "Realmroot credentials are invalid.");
    throw error;
  }
};

function validateAuthorizationSyntax(authorization: string): void {
  const match = authorization.match(/^(Bearer|DPoP) ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
  if (!match) throw new ApiProblem(401, "invalid-credentials", "Unauthorized", "Realmroot credentials are invalid.");
}

function devPrincipal(c: Context<{ Bindings: Env }>): Principal | null {
  const configured = c.env.AK_DEV_AUTH_SECRET;
  const authorization = c.req.header("authorization");
  if (!configured || authorization !== `Dev ${configured}`) return null;
  const actorIssuer = c.req.header("x-ak-dev-actor-issuer");
  const actorSubject = c.req.header("x-ak-dev-actor-subject");
  return {
    source: "token",
    type: actorIssuer && actorSubject ? "agent" : "human",
    subjectId: actorSubject ?? "local-controller",
    tenantId: c.req.header("x-ak-dev-tenant") ?? "local-tenant",
    clientId: "ak-local-smoke",
    scopes: [
      "boards:read",
      "boards:write",
      "repositories:read",
      "repositories:write",
      "tasks:read",
      "tasks:write",
      "memberships:read",
      "memberships:write",
      "execution:read",
      "execution:write",
      "work:read",
      "work:write",
      "reviews:read",
      "reviews:write",
    ],
    ...(actorIssuer && actorSubject ? { actor: { issuer: actorIssuer, subject: actorSubject } } : {}),
  };
}

function operationScope(path: string, method: string): string {
  const access = method === "GET" || method === "HEAD" ? "read" : "write";
  const domain =
    path.includes("progress-entries") || path.includes("/messages")
      ? "work"
      : path.includes("board-memberships") || path.includes("/memberships")
        ? "memberships"
        : path.includes("task-assignments") ||
            path.includes("/assignments") ||
            path.includes("task-runs") ||
            path.includes("/runs") ||
            path.includes("ama-connections") ||
            path.includes("execution-binding")
          ? "execution"
          : path.includes("submissions") || path.includes("reviews")
            ? "reviews"
            : path.includes("repositories")
              ? "repositories"
              : path.includes("tasks") || path.includes("dependencies")
                ? "tasks"
                : "boards";
  return `${domain}:${access}`;
}

export async function requireBoardCapability(
  c: Context<{ Bindings: Env }>,
  boardId: string,
  capability: "plan" | "assign" | "work" | "review" | "maintain",
): Promise<void> {
  const principal = c.get("principal");
  if (principal.type === "human" || principal.type === "service") return;
  if (!principal.actor) throw new ApiProblem(403, "actor-required", "Forbidden", "A stable Realmroot Agent actor is required.");
  const agentId = await actorAmaAgentId(c, boardId);
  if (!agentId || !(await new AccessRepo(c.env.DB, principal.tenantId).hasCapability(boardId, agentId, capability)))
    throw new ApiProblem(403, "board-capability-required", "Forbidden", `The ${capability} board capability is required.`);
}

export async function requireAssignedActor(c: Context<{ Bindings: Env }>, taskId: string): Promise<void> {
  const principal = c.get("principal");
  if (principal.type === "human" || principal.type === "service") return;
  if (!principal.actor) throw new ApiProblem(403, "actor-required", "Forbidden", "A stable Realmroot Agent actor is required.");
  const assignment = await new AccessRepo(c.env.DB, principal.tenantId).activeAssignmentWithBoard(taskId);
  if (!assignment || (await actorAmaAgentId(c, assignment.board_id)) !== assignment.agent_id)
    throw new ApiProblem(403, "assignment-required", "Forbidden", "The Agent is not assigned to this task.");
}

async function actorAmaAgentId(c: Context<{ Bindings: Env }>, boardId: string): Promise<string | null> {
  const principal = c.get("principal");
  const actor = principal.actor;
  if (!actor) return null;
  let cached = c.get("actorAgentIds");
  if (!cached) {
    cached = new Map();
    c.set("actorAgentIds", cached);
  }
  const existing = cached.get(boardId);
  if (existing) return existing;
  const resolved = (async () => {
    const binding = await new AmaBindingRepo(c.env.DB, principal.tenantId).activeBinding(boardId);
    return resolveAmaActorAgentId(c.env, principal.tenantId, binding.authorized_subject_id, binding.project_uri, actor);
  })();
  cached.set(boardId, resolved);
  return resolved;
}
