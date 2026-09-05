import {
  AuthError,
  authenticateRealmrootToken,
  authenticateWebSession,
  type RealmrootPrincipal,
  type ResourceScope,
  validateCsrfToken,
} from "@server/auth/realmroot";
import type { Env } from "@server/env";
import { isPublishedV2Operation, v2Problem } from "@server/http/middleware/v2Contract";
import type { Context, Next } from "hono";

export async function authenticationMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  try {
    const principal = c.req.header("authorization") ? await authenticateRealmrootToken(c) : await authenticateWebSession(c);
    if (!principal) return authenticationFailure(c, "Authentication required");
    c.set("principal", principal);
    c.set("ownerId", principal.tenantId);
    return next();
  } catch (error) {
    if (error instanceof AuthError) return authenticationFailure(c, error.message);
    throw error;
  }
}

export async function csrfProtectionMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const principal = c.get("principal");
  if (principal.source !== "session" || isSafeMethod(c.req.method)) return next();
  const session = c.get("session");
  if (!session || !(await validateCsrfToken(c.req.header("x-csrf-token"), session.csrfToken))) {
    return authorizationFailure(c, "Invalid CSRF token");
  }
  return next();
}

export async function principalProvisioningMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const principal = c.get("principal");
  if (principal.source === "token") await ensureTokenPrincipal(c, principal);
  await next();
}

export function authorizeScope(scope: ResourceScope) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    if (!c.get("principal").scopes.includes(scope)) return authorizationFailure(c, `Missing scope: ${scope}`);
    await next();
  };
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

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}
