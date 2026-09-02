import { AuthError, authenticateRealmrootToken, authenticateWebSession, CsrfError, type RealmrootPrincipal } from "@server/auth/realmroot";
import type { Env } from "@server/env";
import { isPublishedV2Operation, v2Problem } from "@server/http/middleware/v2Contract";
import type { Context, Next } from "hono";
import { errors as joseErrors } from "jose";

type IdentityType = "user" | "machine" | "realmroot:agent" | "service";

interface RouteRule {
  allow: IdentityType[];
  scope?: string;
}

const ROUTE_RULES: { method: string; pattern: RegExp; rule: RouteRule }[] = [
  {
    method: "GET",
    pattern: /^\/api\/tasks(?:\/[^/]+)?$/,
    rule: { allow: ["user", "realmroot:agent"], scope: "task:read" },
  },
  { method: "GET", pattern: /^\/api\/task-events$/, rule: { allow: ["user", "realmroot:agent"], scope: "task:read" } },
  { method: "PUT", pattern: /^\/api\/task-claims\/[^/]+$/, rule: { allow: ["realmroot:agent"], scope: "task:claim" } },
  { method: "DELETE", pattern: /^\/api\/task-claims\/[^/]+$/, rule: { allow: ["realmroot:agent"], scope: "task:release" } },
  {
    method: "PUT",
    pattern: /^\/api\/task-cancellations\/[^/]+$/,
    rule: { allow: ["user", "realmroot:agent"], scope: "task:cancel" },
  },
  { method: "PUT", pattern: /^\/api\/task-assignments\/[^/]+$/, rule: { allow: ["user", "realmroot:agent"], scope: "task:assign" } },
  { method: "GET", pattern: /^\/api\/task-review-submissions\/[^/]+$/, rule: { allow: ["user", "realmroot:agent"], scope: "task:read" } },
  { method: "PUT", pattern: /^\/api\/task-review-submissions\/[^/]+$/, rule: { allow: ["realmroot:agent"], scope: "task:review" } },
  {
    method: "PUT",
    pattern: /^\/api\/task-review-rejections\/[^/]+$/,
    rule: { allow: ["user", "realmroot:agent"], scope: "task:reject" },
  },
  {
    method: "PUT",
    pattern: /^\/api\/task-review-completions\/[^/]+$/,
    rule: { allow: ["user", "realmroot:agent"], scope: "task:complete" },
  },
  {
    method: "GET",
    pattern: /^\/api\/tasks\/[^/]+\/(?:notes(?:\/[^/]+)?|stream)$/,
    rule: { allow: ["user", "realmroot:agent"], scope: "task:read" },
  },
  {
    method: "GET",
    pattern: /^\/api\/tasks\/[^/]+\/session(?:\/ws)?$/,
    rule: { allow: ["user"] },
  },
  {
    method: "GET",
    pattern: /^\/api\/boards(?:\/[^/]+(?:\/stream)?)?$/,
    rule: { allow: ["user", "realmroot:agent"], scope: "board:read" },
  },
  {
    method: "GET",
    pattern: /^\/api\/repositories(?:\/[^/]+)?$/,
    rule: { allow: ["user", "realmroot:agent"], scope: "repository:read" },
  },
  { method: "GET", pattern: /^\/api\/agents(?:\/[^/]+)?$/, rule: { allow: ["user", "realmroot:agent"], scope: "agent:read" } },
  { method: "POST", pattern: /^\/api\/agents$/, rule: { allow: ["user", "realmroot:agent"], scope: "agent:write" } },
  { method: "GET", pattern: /^\/api\/machines(?:\/[^/]+)?$/, rule: { allow: ["user", "realmroot:agent"], scope: "machine:read" } },
  { method: "POST", pattern: /^\/api\/machines$/, rule: { allow: ["user", "realmroot:agent"], scope: "machine:write" } },
  { method: "DELETE", pattern: /^\/api\/machines\/[^/]+$/, rule: { allow: ["user", "realmroot:agent"], scope: "machine:write" } },
  { method: "GET", pattern: /^\/api\/github-app\/(?:config|setup|repositories)$/, rule: { allow: ["user"], scope: "repository:read" } },
  { method: "POST", pattern: /^\/api\/tasks$/, rule: { allow: ["realmroot:agent"], scope: "task:write" } },
  { method: "PATCH", pattern: /^\/api\/tasks\/[^/]+$/, rule: { allow: ["user"] } },
  { method: "DELETE", pattern: /^\/api\/tasks\/[^/]+$/, rule: { allow: ["user"] } },
  {
    method: "POST",
    pattern: /^\/api\/tasks\/[^/]+\/notes$/,
    rule: { allow: ["realmroot:agent"], scope: "task:write" },
  },
  { method: "POST", pattern: /^\/api\/boards$/, rule: { allow: ["user", "realmroot:agent"], scope: "board:write" } },
  { method: "POST", pattern: /^\/api\/boards\/[^/]+\/labels$/, rule: { allow: ["user"] } },
  {
    method: "PATCH",
    pattern: /^\/api\/boards\/[^/]+(?:\/labels\/[^/]+)?$/,
    rule: { allow: ["user"] },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/boards\/[^/]+(?:\/labels\/[^/]+)?$/,
    rule: { allow: ["user"] },
  },
  { method: "POST", pattern: /^\/api\/repositories$/, rule: { allow: ["user", "realmroot:agent"], scope: "repository:write" } },
  { method: "DELETE", pattern: /^\/api\/repositories\/[^/]+$/, rule: { allow: ["user"] } },
];

export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  try {
    const principal = c.req.header("authorization") ? await authenticateRealmrootToken(c) : await authenticateWebSession(c);
    if (!principal) return authenticationFailure(c, "Authentication required");
    if (principal.source === "token") await ensureTokenPrincipal(c, principal);
    c.set("principal", principal);
    c.set("ownerId", principal.tenantId);
    c.set("identityType", principal.type === "human" ? "user" : principal.type === "agent" ? "realmroot:agent" : principal.type);
    return enforceRouteRule(c, next);
  } catch (error) {
    if (error instanceof CsrfError) return authorizationFailure(c, error.message);
    if (error instanceof AuthError || error instanceof joseErrors.JOSEError) {
      const message = error instanceof AuthError ? error.message : "Invalid Realmroot authority";
      return authenticationFailure(c, message);
    }
    throw error;
  }
}

async function ensureTokenPrincipal(c: Context<{ Bindings: Env }>, principal: RealmrootPrincipal): Promise<void> {
  const statements = [
    c.env.DB.prepare(
      `INSERT INTO realmroot_tenants (id) VALUES (?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
    ).bind(principal.tenantId),
  ];
  if (principal.type === "human") {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO realmroot_tenant_members (tenant_id, subject_id, role)
         VALUES (?, ?, 'member')
         ON CONFLICT(tenant_id, subject_id) DO UPDATE SET updated_at = excluded.updated_at`,
      ).bind(principal.tenantId, principal.subjectId),
    );
  }
  await c.env.DB.batch(statements);
}

function enforceRouteRule(c: Context<{ Bindings: Env }>, next: Next) {
  const principal = c.get("principal");
  if (principal.source === "token" && !isPublishedV2Operation(c.req.method, c.req.path)) {
    return authorizationFailure(c, "Operation is not published by the Agent Kanban Resource Server");
  }
  const identity = c.get("identityType") as IdentityType;
  const rule = ROUTE_RULES.find(({ method, pattern }) => method === c.req.method && pattern.test(c.req.path))?.rule;
  if (!rule) {
    return authorizationFailure(c, "Operation is not available to this principal");
  }
  if (!rule.allow.includes(identity)) return authorizationFailure(c, `${rule.allow.join(" or ")} required`);
  if (rule.scope && (principal.source === "token" || principal.type === "agent") && !principal.scopes.includes(rule.scope)) {
    return authorizationFailure(c, `Missing scope: ${rule.scope}`);
  }
  return next();
}

function authenticationFailure(c: Context<{ Bindings: Env }>, message: string): Response {
  if (isPublishedV2Operation(c.req.method, c.req.path)) {
    c.header("WWW-Authenticate", 'DPoP realm="agent-kanban"');
    return v2Problem(c, 401, "authentication-required", "Authentication required", message);
  }
  return c.json({ error: { code: "UNAUTHORIZED", message } }, 401);
}

function authorizationFailure(c: Context<{ Bindings: Env }>, message: string): Response {
  if (isPublishedV2Operation(c.req.method, c.req.path)) {
    return v2Problem(c, 403, "permission-denied", "Permission denied", message);
  }
  return c.json({ error: { code: "FORBIDDEN", message } }, 403);
}
