import type { Context, Next } from "hono";
import { decodeJwt, decodeProtectedHeader, importJWK, errors as joseErrors, jwtVerify } from "jose";
import { AuthError, authenticateRealmrootToken, authenticateWebSession, CsrfError, type RealmrootPrincipal } from "./realmrootAuth";
import type { Env } from "./types";

type IdentityType = "user" | "machine" | "agent:worker" | "agent:leader" | "service";

interface RouteRule {
  allow: IdentityType[];
  scope?: string;
}

const ROUTE_RULES: { method: string; pattern: RegExp; rule: RouteRule }[] = [
  { method: "GET", pattern: /^\/api\/machines(?:\/[^/]+)?$/, rule: { allow: ["user", "machine"], scope: "ak:read" } },
  { method: "GET", pattern: /^\/api\/models$/, rule: { allow: ["user", "machine", "agent:worker", "agent:leader"], scope: "ak:read" } },
  { method: "GET", pattern: /^\/api\/agents(?:\/[^/]+)?$/, rule: { allow: ["user", "machine", "agent:worker", "agent:leader"], scope: "ak:read" } },
  {
    method: "GET",
    pattern: /^\/api\/subagents(?:\/[^/]+)?$/,
    rule: { allow: ["user", "machine", "agent:worker", "agent:leader"], scope: "ak:read" },
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/[^/]+\/inbox(?:\/[^/]+)?$/,
    rule: { allow: ["user"], scope: "ak:read" },
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/[^/]+\/sessions$/,
    rule: { allow: ["user", "machine", "agent:worker", "agent:leader"], scope: "ak:read" },
  },
  {
    method: "GET",
    pattern: /^\/api\/tasks(?:\/[^/]+)?(?:\/(?:session|notes|messages|stream|session\/ws))?$/,
    rule: { allow: ["user", "machine", "agent:worker", "agent:leader"], scope: "ak:read" },
  },
  {
    method: "GET",
    pattern: /^\/api\/sessions(?:\/[^/]+(?:\/ws)?)?$/,
    rule: { allow: ["user", "machine", "agent:worker", "agent:leader"], scope: "ak:read" },
  },
  { method: "GET", pattern: /^\/api\/ama\/sessions\/[^/]+\/socket$/, rule: { allow: ["user"], scope: "ak:read" } },
  { method: "GET", pattern: /^\/api\/tunnel\/ws$/, rule: { allow: ["user", "machine"], scope: "ak:read" } },
  {
    method: "GET",
    pattern: /^\/api\/boards\/[^/]+\/maintainers(?:\/[^/]+(?:\/(?:variables|runs|memories))?)?$/,
    rule: { allow: ["user", "agent:leader"], scope: "ak:read" },
  },
  {
    method: "GET",
    pattern: /^\/api\/boards(?:\/[^/]+(?:\/stream)?)?$/,
    rule: { allow: ["user", "machine", "agent:worker", "agent:leader"], scope: "ak:read" },
  },
  {
    method: "GET",
    pattern: /^\/api\/repositories(?:\/[^/]+)?$/,
    rule: { allow: ["user", "machine", "agent:worker", "agent:leader"], scope: "ak:read" },
  },
  { method: "GET", pattern: /^\/api\/github-app\/(?:config|setup|repositories)$/, rule: { allow: ["user"], scope: "ak:read" } },
  { method: "POST", pattern: /^\/api\/ama\/provision$/, rule: { allow: ["user"], scope: "ak:write" } },
  {
    method: "POST",
    pattern: /^\/api\/repositories\/[^/]+\/github-token$/,
    rule: { allow: ["user", "machine", "agent:worker", "agent:leader"], scope: "ak:read" },
  },
  { method: "POST", pattern: /^\/api\/machines$/, rule: { allow: ["user", "machine"], scope: "ak:write" } },
  { method: "POST", pattern: /^\/api\/machines\/[^/]+\/heartbeat$/, rule: { allow: ["user", "machine"], scope: "ak:write" } },
  { method: "DELETE", pattern: /^\/api\/machines\/[^/]+$/, rule: { allow: ["user"], scope: "ak:write" } },
  { method: "POST", pattern: /^\/api\/machines\/cloud$/, rule: { allow: ["user"], scope: "ak:write" } },
  { method: "POST", pattern: /^\/api\/agents$/, rule: { allow: ["user", "machine", "agent:leader"], scope: "ak:write" } },
  { method: "PATCH", pattern: /^\/api\/agents\/[^/]+$/, rule: { allow: ["user", "agent:leader"], scope: "ak:write" } },
  { method: "DELETE", pattern: /^\/api\/agents\/[^/]+$/, rule: { allow: ["user", "agent:leader"], scope: "ak:write" } },
  { method: "POST", pattern: /^\/api\/subagents$/, rule: { allow: ["user", "machine", "agent:leader"], scope: "ak:write" } },
  { method: "PATCH", pattern: /^\/api\/subagents\/[^/]+$/, rule: { allow: ["user", "agent:leader"], scope: "ak:write" } },
  { method: "DELETE", pattern: /^\/api\/subagents\/[^/]+$/, rule: { allow: ["user", "agent:leader"], scope: "ak:write" } },
  { method: "POST", pattern: /^\/api\/agents\/[^/]+\/sessions$/, rule: { allow: ["user", "machine"], scope: "ak:write" } },
  { method: "DELETE", pattern: /^\/api\/agents\/[^/]+\/sessions\/[^/]+$/, rule: { allow: ["user", "machine"], scope: "ak:write" } },
  { method: "POST", pattern: /^\/api\/agents\/[^/]+\/sessions\/[^/]+\/reopen$/, rule: { allow: ["user", "machine"], scope: "ak:write" } },
  {
    method: "PATCH",
    pattern: /^\/api\/agents\/[^/]+\/sessions\/[^/]+\/usage$/,
    rule: { allow: ["machine", "agent:worker", "agent:leader"], scope: "agent:usage" },
  },
  { method: "POST", pattern: /^\/api\/tasks$/, rule: { allow: ["agent:worker", "agent:leader"], scope: "task:log" } },
  { method: "PATCH", pattern: /^\/api\/tasks\/[^/]+$/, rule: { allow: ["agent:worker", "agent:leader"], scope: "task:log" } },
  { method: "DELETE", pattern: /^\/api\/tasks\/[^/]+$/, rule: { allow: ["agent:worker", "agent:leader"], scope: "task:cancel" } },
  { method: "POST", pattern: /^\/api\/tasks\/[^/]+\/claim$/, rule: { allow: ["agent:worker"], scope: "task:claim" } },
  { method: "POST", pattern: /^\/api\/tasks\/[^/]+\/review$/, rule: { allow: ["agent:worker"], scope: "task:review" } },
  { method: "POST", pattern: /^\/api\/tasks\/[^/]+\/assign$/, rule: { allow: ["agent:worker", "agent:leader"], scope: "task:assign" } },
  { method: "POST", pattern: /^\/api\/tasks\/[^/]+\/release$/, rule: { allow: ["machine", "agent:worker", "agent:leader"], scope: "task:release" } },
  { method: "POST", pattern: /^\/api\/tasks\/[^/]+\/complete$/, rule: { allow: ["user", "machine", "agent:leader"], scope: "task:complete" } },
  { method: "POST", pattern: /^\/api\/tasks\/[^/]+\/cancel$/, rule: { allow: ["user", "machine", "agent:leader"], scope: "task:cancel" } },
  { method: "POST", pattern: /^\/api\/tasks\/[^/]+\/reject$/, rule: { allow: ["user", "agent:leader"], scope: "task:reject" } },
  { method: "POST", pattern: /^\/api\/tasks\/[^/]+\/messages$/, rule: { allow: ["user", "agent:worker", "agent:leader"], scope: "task:message" } },
  { method: "POST", pattern: /^\/api\/tasks\/[^/]+\/notes$/, rule: { allow: ["agent:worker", "agent:leader"], scope: "task:log" } },
  {
    method: "POST",
    pattern: /^\/api\/boards\/[^/]+\/maintainers\/[^/]+\/sessions$/,
    rule: { allow: ["agent:leader"], scope: "ak:write" },
  },
  { method: "POST", pattern: /^\/api\/boards$/, rule: { allow: ["user", "agent:leader"], scope: "ak:write" } },
  { method: "POST", pattern: /^\/api\/boards\/[^/]+\/(?:labels|maintainers)$/, rule: { allow: ["user", "agent:leader"], scope: "ak:write" } },
  {
    method: "PATCH",
    pattern: /^\/api\/boards\/[^/]+(?:\/labels\/[^/]+|\/maintainers\/[^/]+)?$/,
    rule: { allow: ["user", "agent:leader"], scope: "ak:write" },
  },
  {
    method: "PUT",
    pattern: /^\/api\/boards\/[^/]+\/maintainers\/[^/]+\/variables$/,
    rule: { allow: ["user", "agent:leader"], scope: "ak:write" },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/boards\/[^/]+(?:\/labels\/[^/]+|\/maintainers\/[^/]+)?$/,
    rule: { allow: ["user", "agent:leader"], scope: "ak:write" },
  },
  { method: "POST", pattern: /^\/api\/repositories$/, rule: { allow: ["user", "agent:leader"], scope: "ak:write" } },
  { method: "DELETE", pattern: /^\/api\/repositories\/[^/]+$/, rule: { allow: ["user", "agent:leader"], scope: "ak:write" } },
  { method: "GET", pattern: /^\/api\/admin\/(?:stats|machines)$/, rule: { allow: ["user"], scope: "ak:read" } },
];

export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  try {
    const agentToken = localAgentToken(c.req.header("authorization"));
    if (agentToken) return await authenticateAkAgent(c, agentToken, next);

    const principal = c.req.header("authorization") ? await authenticateRealmrootToken(c) : await authenticateWebSession(c);
    if (!principal) return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required" } }, 401);
    if (principal.type === "agent") throw new AuthError("Realmroot Agent tokens are not accepted by AK");
    if (principal.source === "token") await ensureTokenPrincipal(c, principal);
    c.set("principal", principal);
    c.set("ownerId", principal.tenantId);
    c.set("identityType", principal.type === "human" ? "user" : principal.type);
    if (principal.type === "machine") c.set("machineId", principal.subjectId);
    if (principal.source === "token" && principal.type === "human") {
      const machineId = c.req.header("x-ak-machine-id");
      if (machineId) {
        if (!/^[A-Za-z0-9_-]{1,160}$/.test(machineId)) return c.json({ error: { code: "FORBIDDEN", message: "Invalid AK machine context" } }, 403);
        const binding = await c.env.DB.prepare(
          `SELECT 1 FROM realmroot_native_machine_bindings
           WHERE tenant_id = ? AND subject_id = ? AND machine_id = ?`,
        )
          .bind(principal.tenantId, principal.subjectId, machineId)
          .first();
        if (!binding) return c.json({ error: { code: "FORBIDDEN", message: "Native subject is not bound to this machine" } }, 403);
        c.set("machineId", machineId);
        c.set("identityType", "machine");
      }
    }
    return enforceRouteRule(c, next);
  } catch (error) {
    if (error instanceof CsrfError) return c.json({ error: { code: "CSRF_INVALID", message: error.message } }, 403);
    if (error instanceof AuthError || error instanceof joseErrors.JOSEError) {
      const message = error instanceof AuthError ? error.message : "Invalid Realmroot authority";
      return c.json({ error: { code: "UNAUTHORIZED", message } }, 401);
    }
    throw error;
  }
}

function localAgentToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  try {
    return decodeProtectedHeader(token).typ === "agent+jwt" ? token : null;
  } catch {
    return null;
  }
}

async function authenticateAkAgent(c: Context<{ Bindings: Env }>, token: string, next: Next): Promise<Response> {
  const unverified = decodeJwt(token) as { sub?: unknown; aid?: unknown };
  if (typeof unverified.sub !== "string" || typeof unverified.aid !== "string") throw new AuthError("Invalid AK Agent token claims");

  const row = await c.env.DB.prepare(
    `SELECT s.id AS session_id, s.agent_id, s.machine_id, s.public_key, a.owner_id, a.kind, 'legacy' AS source
     FROM agent_sessions s
     JOIN agents a ON a.id = s.agent_id
     WHERE s.id = ? AND s.agent_id = ? AND s.status = 'active' AND a.version = 'latest'
     UNION ALL
     SELECT s.id AS session_id, s.agent_id, NULL AS machine_id, s.public_key, s.owner_id, a.kind, 'ama' AS source
     FROM ama_agent_sessions s
     JOIN agents a ON a.id = s.agent_id AND a.owner_id = s.owner_id
     WHERE s.id = ? AND s.agent_id = ? AND s.status = 'active' AND a.version = 'latest'
     LIMIT 1`,
  )
    .bind(unverified.sub, unverified.aid, unverified.sub, unverified.aid)
    .first<{
      session_id: string;
      agent_id: string;
      machine_id: string | null;
      public_key: string;
      owner_id: string;
      kind: string;
      source: "legacy" | "ama";
    }>();
  if (!row) return c.json({ error: { code: "FORBIDDEN", message: "AK Agent session is not active" } }, 403);

  const key = await importJWK({ kty: "OKP", crv: "Ed25519", x: row.public_key }, "EdDSA");
  const { payload, protectedHeader } = await jwtVerify(token, key, {
    algorithms: ["EdDSA"],
    typ: "agent+jwt",
    audience: new URL(c.req.url).origin,
  });
  const now = Math.floor(Date.now() / 1000);
  if (
    protectedHeader.alg !== "EdDSA" ||
    payload.sub !== row.session_id ||
    payload.aid !== row.agent_id ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    payload.iat < now - 120 ||
    payload.iat > now + 30 ||
    payload.exp <= now ||
    payload.exp > now + 150 ||
    payload.exp - payload.iat > 120 ||
    typeof payload.jti !== "string" ||
    payload.jti.length === 0 ||
    payload.jti.length > 160
  ) {
    throw new AuthError("Invalid AK Agent token claims");
  }

  try {
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM ak_agent_jwt_replays WHERE expires_at <= ?").bind(new Date().toISOString()),
      c.env.DB.prepare("INSERT INTO ak_agent_jwt_replays (session_id, jti, expires_at) VALUES (?, ?, ?)").bind(
        row.session_id,
        payload.jti,
        new Date((payload.exp ?? Math.floor(Date.now() / 1000) + 60) * 1000).toISOString(),
      ),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE") || String(error).includes("PRIMARY KEY")) throw new AuthError("Replayed AK Agent token");
    throw error;
  }

  const leader = row.kind === "leader";
  const scopes = leader
    ? ["task:assign", "task:complete", "task:reject", "task:cancel", "task:log", "task:message", "agent:usage", "ak:read", "ak:write"]
    : ["task:claim", "task:review", "task:log", "task:message", "agent:usage", "ak:read"];
  c.set("principal", { source: "session", type: "agent", subjectId: row.agent_id, tenantId: row.owner_id, scopes });
  c.set("ownerId", row.owner_id);
  c.set("agentId", row.agent_id);
  c.set("sessionId", row.session_id);
  c.set("agentRuntimeSource", row.source);
  c.set("agentCapabilities", scopes);
  c.set("identityType", leader ? "agent:leader" : "agent:worker");
  if (row.machine_id) c.set("machineId", row.machine_id);
  const response = await enforceRouteRule(c, next);
  return response ?? c.res;
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
  const identity = c.get("identityType") as IdentityType;
  const rule = ROUTE_RULES.find(({ method, pattern }) => method === c.req.method && pattern.test(c.req.path))?.rule;
  if (!rule) {
    return c.json({ error: { code: "FORBIDDEN", message: "Operation is not available to this principal" } }, 403);
  }
  if (!rule.allow.includes(identity)) return c.json({ error: { code: "FORBIDDEN", message: `${rule.allow.join(" or ")} required` } }, 403);
  const principal = c.get("principal");
  if (rule.scope && (principal.source === "token" || principal.type === "agent") && !principal.scopes.includes(rule.scope)) {
    return c.json({ error: { code: "FORBIDDEN", message: `Missing scope: ${rule.scope}` } }, 403);
  }
  return next();
}
