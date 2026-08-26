import { ApiProblem } from "./contract";
import { AmaUserGrantRequired, amaBearerToken } from "./realmrootAuth";
import type { Env } from "./types";

export type AmaAgent = {
  id: string;
  identity: { issuer: string; subject: string };
};

type SessionRepository = { id: string; url: string; default_branch?: string | null } | null;

export function amaSessionRequest(agent: AmaAgent, repository: SessionRepository, taskUri: string, prompt: string): Record<string, unknown> {
  const repositoryUrl = repository ? amaRepositoryUrl(repository.url) : null;
  const volumes = repositoryUrl
    ? [{ name: "repository", type: "git_repository", url: repositoryUrl, ...(repository?.default_branch ? { ref: repository.default_branch } : {}) }]
    : [];
  return {
    metadata: { labels: { source: "agent-kanban" }, annotations: { "agent-kanban.dev/task": taskUri } },
    spec: {
      agentId: agent.id,
      ...(volumes.length ? { volumes, volumeMounts: [{ name: "repository", mountPath: "/workspace/repository" }] } : {}),
    },
    prompt: `Work on the Agent Kanban task at ${taskUri}. Use realmroot toolbox agent-kanban for task coordination.\n\n${prompt}`,
  };
}

export class AmaSessionTerminalError extends Error {}

export async function resolveAmaAgent(env: Env, tenantId: string, subjectId: string, projectUri: string, agentId: string): Promise<AmaAgent> {
  if (!agentId || agentId.length > 200 || agentId.includes("/"))
    throw new ApiProblem(422, "invalid-agent-id", "Invalid Agent ID", "agentId must be an AMA Agent ID.");
  const target = new URL(`/api/v1/agents/${encodeURIComponent(agentId)}`, env.AMA_ORIGIN);
  const projectId = projectIdFromUri(projectUri);
  const response = await fetchAma(env, tenantId, subjectId, target, {
    headers: { accept: "application/json", "X-AMA-Project-ID": projectId },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) throw new ApiProblem(422, "agent-not-found", "Agent Not Found", "AMA could not resolve the selected Agent.");
  if (!response.ok) throw new ApiProblem(502, "ama-unavailable", "AMA Unavailable", `AMA returned HTTP ${response.status}.`);
  const body = (await response.json()) as Record<string, unknown>;
  const metadata = body.metadata as Record<string, unknown> | undefined;
  const identity = body.identity as Record<string, unknown> | undefined;
  const status = body.status as Record<string, unknown> | undefined;
  if (metadata?.uid !== agentId || metadata?.projectId !== projectId)
    throw new ApiProblem(422, "agent-project-mismatch", "Invalid Agent", "The Agent does not belong to the board's AMA Project.");
  if (status?.ready !== true || status.phase !== "active")
    throw new ApiProblem(422, "agent-not-ready", "Agent Not Ready", "The selected AMA Agent is not ready for execution.");
  if (!identity || typeof identity.issuer !== "string" || typeof identity.subject !== "string" || identity.runtime !== "ama")
    throw new ApiProblem(502, "ama-contract-invalid", "AMA Contract Invalid", "AMA returned an Agent without a stable Realmroot identity.");
  if (identity.issuer.replace(/\/$/, "") !== env.REALMROOT_ISSUER.replace(/\/$/, ""))
    throw new ApiProblem(502, "ama-contract-invalid", "AMA Contract Invalid", "AMA returned an Agent identity from an untrusted issuer.");
  return {
    id: agentId,
    identity: { issuer: env.REALMROOT_ISSUER.replace(/\/$/, ""), subject: identity.subject },
  };
}

export async function resolveAmaActorAgentId(
  env: Env,
  tenantId: string,
  subjectId: string,
  projectUri: string,
  actor: { issuer: string; subject: string },
): Promise<string | null> {
  const projectId = projectIdFromUri(projectUri);
  const issuer = actor.issuer.replace(/\/$/, "");
  if (issuer !== env.REALMROOT_ISSUER.replace(/\/$/, "")) return null;
  const target = new URL("/api/v1/agents", env.AMA_ORIGIN);
  target.searchParams.set("identityIssuer", issuer);
  target.searchParams.set("identitySubject", actor.subject);
  target.searchParams.set("limit", "2");
  const response = await fetchAma(env, tenantId, subjectId, target, {
    headers: { accept: "application/json", "X-AMA-Project-ID": projectId },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new ApiProblem(502, "ama-unavailable", "AMA Unavailable", `AMA returned HTTP ${response.status}.`);
  const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
  if (!Array.isArray(body.data) || body.data.length > 1)
    throw new ApiProblem(502, "ama-contract-invalid", "AMA Contract Invalid", "AMA returned an invalid Agent identity lookup.");
  const agent = body.data[0];
  if (!agent) return null;
  const metadata = agent.metadata as Record<string, unknown> | undefined;
  const identity = agent.identity as Record<string, unknown> | undefined;
  const status = agent.status as Record<string, unknown> | undefined;
  if (
    typeof metadata?.uid !== "string" ||
    metadata.projectId !== projectId ||
    identity?.issuer !== issuer ||
    identity.subject !== actor.subject ||
    identity.runtime !== "ama" ||
    status?.ready !== true ||
    status.phase !== "active"
  )
    throw new ApiProblem(502, "ama-contract-invalid", "AMA Contract Invalid", "AMA returned an invalid Agent identity lookup.");
  return metadata.uid;
}

export async function deliverOutbox(
  env: Env,
  item: { tenant_id: string; kind: string; payload_json: string },
): Promise<{ uri?: string; status?: string }> {
  const payload = JSON.parse(item.payload_json) as Record<string, unknown>;
  const subjectId = String(payload.authorizedSubjectId ?? "");
  const projectId = projectIdFromUri(String(payload.projectUri ?? ""));
  let endpoint: string;
  let request = payload.request as Record<string, unknown>;
  if (item.kind === "session") {
    endpoint = "/api/v1/sessions";
    const dispatchKey = String(payload.idempotencyKey);
    const existing = await findDispatchedSession(env, item.tenant_id, subjectId, projectId, dispatchKey);
    if (existing) return existing;
    const metadata = (request.metadata ?? {}) as Record<string, unknown>;
    request = {
      ...request,
      metadata: {
        ...metadata,
        labels: { ...((metadata.labels ?? {}) as Record<string, string>), "agent-kanban-run": dispatchKey },
      },
    };
  } else {
    const sessionUri = String(request.session ?? "");
    const target = new URL(sessionUri);
    if (target.origin !== new URL(env.AMA_ORIGIN).origin) throw new Error("AMA Session URI origin mismatch");
    endpoint = `${target.pathname.replace(/\/$/, "")}/messages`;
    request = { type: "prompt", requestId: String(payload.idempotencyKey), content: String(request.body ?? "") };
  }
  const response = await fetchAma(env, item.tenant_id, subjectId, new URL(endpoint, env.AMA_ORIGIN), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "idempotency-key": String(payload.idempotencyKey),
      "X-AMA-Project-ID": projectId,
      ...(typeof payload.traceparent === "string" ? { traceparent: payload.traceparent } : {}),
      ...(typeof payload.tracestate === "string" ? { tracestate: payload.tracestate } : {}),
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    if (item.kind !== "session" && (response.status === 404 || response.status === 409))
      throw new AmaSessionTerminalError(`AMA Session is terminal (HTTP ${response.status})`);
    throw new Error(`AMA dispatch failed with HTTP ${response.status}`);
  }
  const body = (await response.json().catch(() => ({}))) as {
    id?: string;
    uri?: string;
    metadata?: { uid?: string };
    status?: { phase?: string };
    links?: { self?: string };
  };
  const sessionId = body.metadata?.uid ?? body.id;
  if (item.kind === "session" && !sessionId && !body.uri && !body.links?.self) throw new Error("AMA session contract response has no identity");
  return {
    uri: item.kind === "session" ? canonicalAmaSessionUri(env, body.uri ?? body.links?.self, sessionId) : (body.uri ?? body.links?.self),
    status: body.status?.phase,
  };
}

async function findDispatchedSession(
  env: Env,
  tenantId: string,
  subjectId: string,
  projectId: string,
  dispatchKey: string,
): Promise<{ uri: string; status?: string } | null> {
  const target = new URL("/api/v1/sessions", env.AMA_ORIGIN);
  target.searchParams.set("labelSelector", `agent-kanban-run=${dispatchKey}`);
  target.searchParams.set("limit", "2");
  const response = await fetchAma(env, tenantId, subjectId, target, {
    headers: { accept: "application/json", "X-AMA-Project-ID": projectId },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`AMA Session reconciliation failed with HTTP ${response.status}`);
  const body = (await response.json()) as {
    data?: Array<{ metadata?: { uid?: string }; status?: { phase?: string } }>;
  };
  const sessions = body.data ?? [];
  if (sessions.length > 1) throw new Error("AMA Session reconciliation found duplicate dispatch labels");
  const session = sessions[0];
  const sessionId = session?.metadata?.uid;
  return sessionId ? { uri: canonicalAmaSessionUri(env, undefined, sessionId), status: session.status?.phase } : null;
}

export async function validateAmaConnection(env: Env, tenantId: string, subjectId: string, resourceUrl: string, projectUri: string): Promise<void> {
  if (resourceUrl.replace(/\/$/, "") !== env.AMA_RESOURCE.replace(/\/$/, ""))
    throw new ApiProblem(422, "ama-resource-mismatch", "Invalid AMA Connection", "resourceUrl must be the configured AMA Resource.");
  const project = new URL(projectUri);
  if (project.origin !== new URL(env.AMA_ORIGIN).origin)
    throw new ApiProblem(422, "ama-project-mismatch", "Invalid AMA Connection", "projectUri must use the configured AMA origin.");
  const projectId = projectIdFromUri(projectUri);
  const response = await fetchAma(env, tenantId, subjectId, project, {
    headers: { accept: "application/json", "X-AMA-Project-ID": projectId },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403 || response.status === 404)
    throw new ApiProblem(422, "ama-project-unavailable", "AMA Project Unavailable", "The caller cannot access the selected AMA Project.");
  if (!response.ok) throw new ApiProblem(502, "ama-unavailable", "AMA Unavailable", `AMA returned HTTP ${response.status}.`);
  const body = (await response.json()) as { id?: unknown; metadata?: { uid?: unknown } };
  const returnedId = body.metadata?.uid ?? body.id;
  if (returnedId !== projectId)
    throw new ApiProblem(502, "ama-contract-invalid", "AMA Contract Invalid", "AMA returned a different Project identity.");
}

export async function readAmaSession(env: Env, tenantId: string, subjectId: string, projectUri: string, sessionUri: string): Promise<string> {
  const target = new URL(sessionUri);
  if (target.origin !== new URL(env.AMA_ORIGIN).origin) throw new Error("AMA Session URI origin mismatch");
  const response = await fetchAma(env, tenantId, subjectId, target, {
    headers: { accept: "application/json", "X-AMA-Project-ID": projectIdFromUri(projectUri) },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404 || response.status === 410) throw new AmaSessionTerminalError(`AMA Session is terminal (HTTP ${response.status})`);
  if (!response.ok) throw new Error(`AMA Session read failed with HTTP ${response.status}`);
  const body = (await response.json()) as { status?: { phase?: unknown } };
  if (typeof body.status?.phase !== "string") throw new Error("AMA Session response has no status.phase");
  return body.status.phase;
}

function projectIdFromUri(projectUri: string): string {
  const url = new URL(projectUri);
  const match = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
  if (!match || url.search || url.hash)
    throw new ApiProblem(422, "invalid-project-uri", "Invalid AMA Project URI", "projectUri must be a canonical AMA Project URI.");
  return decodeURIComponent(match[1]);
}

function canonicalAmaSessionUri(env: Env, value: string | undefined, sessionId: string | undefined): string {
  try {
    const target = value ? new URL(value) : sessionId ? new URL(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, env.AMA_ORIGIN) : null;
    if (!target || target.origin !== new URL(env.AMA_ORIGIN).origin || target.search || target.hash) throw new Error();
    const match = target.pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/);
    if (!match) throw new Error();
    const uriSessionId = decodeURIComponent(match[1]);
    if (sessionId && uriSessionId !== sessionId) throw new Error();
    return new URL(`/api/v1/sessions/${encodeURIComponent(uriSessionId)}`, env.AMA_ORIGIN).toString();
  } catch {
    throw new Error("AMA session contract response has an invalid canonical URI");
  }
}

function amaRepositoryUrl(value: string): string {
  const scp = value.match(/^git@([^:]+):(.+)$/);
  const normalized = scp ? `https://${scp[1]}/${scp[2]}` : value;
  const url = new URL(normalized);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new ApiProblem(
      422,
      "repository-not-runnable",
      "Repository Not Runnable",
      "AMA sessions require a credential-free HTTPS Git repository URL.",
    );
  return url.toString();
}

async function amaAccessToken(env: Env, tenantId: string, subjectId: string, forceRefresh = false): Promise<string> {
  if (env.AMA_DEV_ACCESS_TOKEN) return Promise.resolve(env.AMA_DEV_ACCESS_TOKEN);
  try {
    return await amaBearerToken(env, tenantId, forceRefresh, subjectId);
  } catch (error) {
    if (error instanceof AmaUserGrantRequired) throw new ApiProblem(401, "ama-grant-required", "AMA Authorization Required", error.message);
    throw error;
  }
}

async function fetchAma(env: Env, tenantId: string, subjectId: string, input: URL, init: RequestInit): Promise<Response> {
  const request = async (forceRefresh: boolean) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${await amaAccessToken(env, tenantId, subjectId, forceRefresh)}`);
    return fetch(input, { ...init, headers });
  };
  let response = await request(false);
  if (response.status === 401 && !env.AMA_DEV_ACCESS_TOKEN) response = await request(true);
  return response;
}

export async function fetchAmaConsole(env: Env, tenantId: string, subjectId: string, path: string, init: RequestInit = {}): Promise<Response> {
  if (!path.startsWith("/api/v1/") || path.startsWith("//"))
    throw new ApiProblem(500, "ama-path-invalid", "AMA Path Invalid", "The configured AMA console path is invalid.");
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  return fetchAma(env, tenantId, subjectId, new URL(path, env.AMA_ORIGIN), {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
}
