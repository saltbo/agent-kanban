import type { Context, Next } from "hono";
import { createAuth } from "./betterAuth";
import type { Env } from "./types";

type IdentityType = "user" | "machine" | "maintainer:key" | "agent:worker" | "agent:leader";

interface RouteRule {
  allow: IdentityType[];
  capability?: string; // required agent capability (only checked for agent identities)
  apiKey?: {
    configId?: string;
    permissions?: Record<string, string[]>;
  };
}

const LEADER_CAPABILITIES = ["task:complete", "task:reject", "task:cancel", "task:log", "task:message", "agent:usage"];
const WORKER_CAPABILITIES = ["task:claim", "task:review", "task:log", "task:message", "agent:usage"];

// Route permission rules: method + path pattern → allowed identity types + required capability
// Routes not listed here are open to any authenticated identity.
const ROUTE_RULES: { method: string; pattern: RegExp; rule: RouteRule }[] = [
  // Machines — machine-only (user can delete)
  { method: "POST", pattern: /^\/api\/machines$/, rule: { allow: ["machine"] } },
  { method: "POST", pattern: /^\/api\/machines\/[^/]+\/heartbeat$/, rule: { allow: ["machine"] } },
  { method: "DELETE", pattern: /^\/api\/machines\/[^/]+$/, rule: { allow: ["user"] } },

  // Agents — user/machine/leader creates, user/leader manages
  { method: "POST", pattern: /^\/api\/agents$/, rule: { allow: ["user", "machine", "agent:leader"] } },
  { method: "PATCH", pattern: /^\/api\/agents\/[^/]+$/, rule: { allow: ["user", "agent:leader"] } },
  { method: "DELETE", pattern: /^\/api\/agents\/[^/]+$/, rule: { allow: ["user", "agent:leader"] } },

  // Subagents — configuration only, no cryptographic identity
  { method: "POST", pattern: /^\/api\/subagents$/, rule: { allow: ["user", "machine", "agent:leader"] } },
  { method: "PATCH", pattern: /^\/api\/subagents\/[^/]+$/, rule: { allow: ["user", "agent:leader"] } },
  { method: "DELETE", pattern: /^\/api\/subagents\/[^/]+$/, rule: { allow: ["user", "agent:leader"] } },

  // Agent Sessions — machine creates/closes, agent reports usage
  { method: "POST", pattern: /^\/api\/agents\/[^/]+\/sessions$/, rule: { allow: ["machine"] } },
  { method: "DELETE", pattern: /^\/api\/agents\/[^/]+\/sessions\/[^/]+$/, rule: { allow: ["machine"] } },
  {
    method: "PATCH",
    pattern: /^\/api\/agents\/[^/]+\/sessions\/[^/]+\/usage$/,
    rule: { allow: ["machine", "agent:worker", "agent:leader"], capability: "agent:usage" },
  },

  // Tasks — CRUD
  { method: "POST", pattern: /^\/api\/tasks$/, rule: { allow: ["user", "agent:worker", "agent:leader"] } },
  { method: "PATCH", pattern: /^\/api\/tasks\/[^/]+$/, rule: { allow: ["user", "agent:worker", "agent:leader"] } },
  { method: "DELETE", pattern: /^\/api\/tasks\/[^/]+$/, rule: { allow: ["user", "agent:worker", "agent:leader"] } },

  // Task lifecycle — agents operate, machine manages
  { method: "POST", pattern: /^\/api\/tasks\/[^/]+\/claim$/, rule: { allow: ["agent:worker"], capability: "task:claim" } },
  { method: "POST", pattern: /^\/api\/tasks\/[^/]+\/review$/, rule: { allow: ["agent:worker"], capability: "task:review" } },
  { method: "POST", pattern: /^\/api\/tasks\/[^/]+\/assign$/, rule: { allow: ["user", "agent:worker", "agent:leader"] } },
  { method: "POST", pattern: /^\/api\/tasks\/[^/]+\/release$/, rule: { allow: ["machine", "agent:worker", "agent:leader"] } },
  { method: "POST", pattern: /^\/api\/tasks\/[^/]+\/complete$/, rule: { allow: ["user", "machine", "agent:worker", "agent:leader"] } },
  { method: "POST", pattern: /^\/api\/tasks\/[^/]+\/cancel$/, rule: { allow: ["user", "machine", "agent:worker", "agent:leader"] } },
  { method: "POST", pattern: /^\/api\/tasks\/[^/]+\/reject$/, rule: { allow: ["user", "agent:worker", "agent:leader"] } },

  // Task messages & notes
  { method: "POST", pattern: /^\/api\/tasks\/[^/]+\/messages$/, rule: { allow: ["agent:worker", "agent:leader", "user"] } },
  { method: "POST", pattern: /^\/api\/tasks\/[^/]+\/notes$/, rule: { allow: ["agent:worker", "agent:leader"] } },

  // Boards — user and leader
  { method: "POST", pattern: /^\/api\/boards$/, rule: { allow: ["user", "agent:leader"] } },
  { method: "PATCH", pattern: /^\/api\/boards\/[^/]+$/, rule: { allow: ["user", "agent:leader"] } },
  { method: "DELETE", pattern: /^\/api\/boards\/[^/]+$/, rule: { allow: ["user", "agent:leader"] } },
  { method: "POST", pattern: /^\/api\/boards\/[^/]+\/maintainers$/, rule: { allow: ["user", "agent:leader"] } },
  { method: "GET", pattern: /^\/api\/boards\/[^/]+\/maintainers\/[^/]+\/variables$/, rule: { allow: ["user", "agent:leader"] } },
  { method: "PUT", pattern: /^\/api\/boards\/[^/]+\/maintainers\/[^/]+\/variables$/, rule: { allow: ["user", "agent:leader"] } },
  {
    method: "POST",
    pattern: /^\/api\/boards\/[^/]+\/maintainers\/[^/]+\/sessions$/,
    rule: { allow: ["maintainer:key"], apiKey: { configId: "maintainer", permissions: { maintainerSession: ["create"] } } },
  },
  { method: "PATCH", pattern: /^\/api\/boards\/[^/]+\/maintainers\/[^/]+$/, rule: { allow: ["user", "agent:leader"] } },
  { method: "DELETE", pattern: /^\/api\/boards\/[^/]+\/maintainers\/[^/]+$/, rule: { allow: ["user", "agent:leader"] } },

  // Repositories — user and leader
  { method: "POST", pattern: /^\/api\/repositories$/, rule: { allow: ["user", "agent:leader"] } },
  { method: "POST", pattern: /^\/api\/repositories\/[^/]+\/github-token$/, rule: { allow: ["user", "agent:worker", "agent:leader"] } },
  { method: "DELETE", pattern: /^\/api\/repositories\/[^/]+$/, rule: { allow: ["user", "agent:leader"] } },

  // Sessions — machine reopen
  { method: "POST", pattern: /^\/api\/agents\/[^/]+\/sessions\/[^/]+\/reopen$/, rule: { allow: ["machine"] } },

  // GPG keys — user only (public key), machine for agent private key
  { method: "GET", pattern: /^\/api\/agents\/[^/]+\/gpg-key$/, rule: { allow: ["machine"] } },
  { method: "GET", pattern: /^\/api\/gpg\/public-key$/, rule: { allow: ["user"] } },

  // Agent inbox — user only
  { method: "GET", pattern: /^\/api\/agents\/[^/]+\/inbox(\/[^/]+)?$/, rule: { allow: ["user"] } },

  // Admin — user identity only (Better Auth plugin enforces role internally)
  { method: "POST", pattern: /^\/api\/auth\/admin\//, rule: { allow: ["user"] } },
  { method: "GET", pattern: /^\/api\/auth\/admin\//, rule: { allow: ["user"] } },

  // Admin stats — user identity only (role check in handler)
  { method: "GET", pattern: /^\/api\/admin\/stats$/, rule: { allow: ["user"] } },
];

function matchRouteRule(method: string, path: string): RouteRule | null {
  for (const { method: m, pattern, rule } of ROUTE_RULES) {
    if (m === method && pattern.test(path)) return rule;
  }
  return null;
}

function detectTokenType(token: string): "apikey" | "agent" | "user" {
  if (token.startsWith("ak_")) return "apikey";
  const parts = token.split(".");
  if (parts.length === 3) {
    try {
      const header = JSON.parse(atob(parts[0]));
      if (header.typ === "agent+jwt") return "agent";
    } catch {
      /* not a valid JWT header */
    }
  }
  return "user";
}

export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const header = c.req.header("Authorization");
  const queryToken = c.req.query("token");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : queryToken;

  const auth = createAuth(c.env);
  if (!token) {
    return handleUserSession(c, auth, c.req.raw.headers, next, "Missing token");
  }

  const type = detectTokenType(token);

  if (type === "apikey") {
    return handleApiKey(c, auth, token, next);
  }

  if (type === "agent") {
    const sessionReq = new Request(new URL("/api/auth/agent/session", c.req.url), {
      headers: c.req.raw.headers,
    });
    const sessionRes = await auth.handler(sessionReq);
    if (!sessionRes.ok) {
      if (sessionRes.status === 429) {
        const retryAfter = sessionRes.headers.get("Retry-After");
        return c.json(
          { error: { code: "RATE_LIMITED", message: "Too many requests" } },
          { status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {} },
        );
      }
      const body = await sessionRes.text().catch(() => "");
      return c.json({ error: { code: "UNAUTHORIZED", message: `Invalid agent session: ${sessionRes.status} ${body}`.trim() } }, 401);
    }
    const agentIdentity = await sessionRes.json();
    // Extract persistent agent ID from JWT `aid` claim
    const aid = decodeJwtClaim(token, "aid");
    return handleAgentIdentity(c, agentIdentity, aid, next);
  }

  const authHeaders = new Headers({ Authorization: `Bearer ${token}` });
  return handleUserSession(c, auth, authHeaders, next, "Invalid or expired token");
}

async function handleUserSession(c: Context<{ Bindings: Env }>, auth: any, headers: Headers, next: Next, errorMessage: string) {
  const session = await auth.api.getSession({ headers });
  if (session) {
    c.set("ownerId", session.user.id);
    c.set("identityType", "user");
    c.set("user", session.user);
    c.set("session", session.session);
    return enforceRouteRule(c, next);
  }

  if (headers !== c.req.raw.headers) {
    const cookieSession = await auth.api.getSession({ headers: c.req.raw.headers });
    if (cookieSession) {
      c.set("ownerId", cookieSession.user.id);
      c.set("identityType", "user");
      c.set("user", cookieSession.user);
      c.set("session", cookieSession.session);
      return enforceRouteRule(c, next);
    }
  }

  return c.json({ error: { code: "UNAUTHORIZED", message: errorMessage } }, 401);
}

async function handleApiKey(c: Context<{ Bindings: Env }>, auth: any, token: string, next: Next) {
  let result: any;
  try {
    const rule = matchRouteRule(c.req.method, c.req.path);
    result = await auth.api.verifyApiKey({ body: { key: token, ...rule?.apiKey } });
  } catch (err: any) {
    return c.json({ error: { code: "UNAUTHORIZED", message: err?.message || "Invalid API key" } }, 401);
  }
  if (!result?.valid) {
    return c.json({ error: result?.error || { code: "UNAUTHORIZED", message: "Invalid API key" } }, 401);
  }

  c.set("ownerId", result.key.referenceId);
  c.set("apiKeyId", result.key.id);
  c.set("apiKeyConfigId", result.key.configId);
  c.set("apiKeyPermissions", result.key.permissions ?? null);
  const metadata = result.key.metadata as Record<string, any> | null;
  c.set("apiKeyMetadata", metadata ?? null);
  c.set("identityType", result.key.configId === "maintainer" ? "maintainer:key" : "machine");
  if (metadata?.machineId) c.set("machineId", metadata.machineId);

  return enforceRouteRule(c, next);
}

async function handleAgentIdentity(c: Context<{ Bindings: Env }>, identity: any, persistentAgentId: string | null, next: Next) {
  const sessionId = identity.agent.id;

  const row = await c.env.DB.prepare(
    `SELECT s.agent_id, a.kind, NULL AS owner_id, 'legacy' AS source
     FROM agent_sessions s
     JOIN agents a ON s.agent_id = a.id
     WHERE s.id = ? AND s.status = 'active'
     UNION ALL
     SELECT s.agent_id, a.kind, s.owner_id, 'ama' AS source
     FROM ama_agent_sessions s
     JOIN agents a ON s.agent_id = a.id AND a.owner_id = s.owner_id
     WHERE s.id = ? AND s.status = 'active'
     LIMIT 1`,
  )
    .bind(sessionId, sessionId)
    .first<{ agent_id: string; kind: string; owner_id: string | null; source: "ama" | "legacy" }>();

  if (!row) {
    return c.json({ error: { code: "FORBIDDEN", message: "Agent session is not registered" } }, 403);
  }

  if (persistentAgentId && row.agent_id !== persistentAgentId) {
    return c.json({ error: { code: "FORBIDDEN", message: "Agent ID mismatch" } }, 403);
  }

  const agentId = row.agent_id;
  c.set("ownerId", row.owner_id || identity.host?.userId || identity.user?.id);
  c.set("sessionId", sessionId);
  c.set("agentId", agentId);
  c.set("agentRuntimeSource", row.source);
  c.set("machineId", row.source === "legacy" ? identity.agent.hostId : undefined);
  const kind = row.kind === "leader" ? "leader" : "worker";
  c.set("agentCapabilities", kind === "leader" ? LEADER_CAPABILITIES : WORKER_CAPABILITIES);
  c.set("identityType", kind === "leader" ? "agent:leader" : "agent:worker");

  return enforceRouteRule(c, next);
}

function decodeJwtClaim(token: string, claim: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload[claim] || null;
  } catch {
    return null;
  }
}

function enforceRouteRule(c: Context<{ Bindings: Env }>, next: Next) {
  const rule = matchRouteRule(c.req.method, c.req.path);
  const identity = c.get("identityType") as IdentityType;
  if (!rule) {
    if (identity === "maintainer:key") {
      return c.json({ error: { code: "FORBIDDEN", message: "Agent session required" } }, 403);
    }
    return next(); // no rule = open to any authenticated user/machine/agent identity
  }

  if (!rule.allow.includes(identity)) {
    return c.json({ error: { code: "FORBIDDEN", message: `${rule.allow.join(" or ")} required` } }, 403);
  }

  if (rule.capability && identity.startsWith("agent:")) {
    const caps: string[] = c.get("agentCapabilities") || [];
    if (!caps.includes(rule.capability)) {
      return c.json({ error: { code: "FORBIDDEN", message: `Missing capability: ${rule.capability}` } }, 403);
    }
  }

  return next();
}
