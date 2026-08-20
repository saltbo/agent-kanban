// @vitest-environment node

import { randomUUID } from "node:crypto";
import {
  AK_ANNOTATION_KEY_SOURCE_EVENT,
  AK_LABEL_KEY_GITHUB_SUBJECT,
  AMA_ANNOTATION_KEY_IDLE_TIMEOUT_SECONDS,
  MAINTAINER_SESSION_IDLE_TIMEOUT_SECONDS,
} from "@agent-kanban/shared";
import { SignJWT } from "jose";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createTestAgent,
  createTestEnv,
  createTestSubagent,
  linkAmaAccount,
  seedUser,
  setAgentAmaId,
  setupMiniflare,
  signUpVerifiedUser,
} from "./helpers/db";

const BETTER_AUTH_URL = "http://localhost:8788";
const env = createTestEnv();
let mf: Miniflare;

// hey-api's fetch client calls fetch(request) with a single Request object.
// These helpers normalise both call signatures so mocks can match on url,
// method, and body regardless of which form is used.
function reqUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}
function reqMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return input instanceof Request ? input.method : ((init as any)?.method ?? "GET");
}
async function reqBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  return input instanceof Request ? input.clone().text() : String((init as any)?.body ?? "");
}
// hey-api defaults to parseAs:'auto' which infers JSON only when Content-Type
// is application/json. Always include it so the SDK parses the body correctly.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type ListedAgent = {
  id: string;
  username: string;
  version: string | null;
  soul: string | null;
  role: string | null;
  kind: string;
};

function isListedAgent(value: unknown): value is ListedAgent {
  if (!value || typeof value !== "object") return false;
  return (
    "id" in value &&
    typeof value.id === "string" &&
    "username" in value &&
    typeof value.username === "string" &&
    "version" in value &&
    (typeof value.version === "string" || value.version === null) &&
    "soul" in value &&
    (typeof value.soul === "string" || value.soul === null) &&
    "role" in value &&
    (typeof value.role === "string" || value.role === null) &&
    "kind" in value &&
    typeof value.kind === "string"
  );
}

async function readListedAgents(res: Response): Promise<ListedAgent[]> {
  const body: unknown = await res.json();
  expect(Array.isArray(body)).toBe(true);
  if (!Array.isArray(body) || !body.every(isListedAgent)) throw new Error("Expected /api/agents to return listed agents");
  return body;
}

function amaCredential(id: string, activeVersionId?: string) {
  return { metadata: { uid: id }, spec: {}, status: { activeVersionId } };
}

function amaCredentialListItem(id: string, name: string, dataKeys: string[], state = "active") {
  return {
    metadata: { uid: id, name },
    spec: {},
    status: { phase: state, activeVersion: { spec: { dataKeys } } },
  };
}

function amaVault(id: string, projectId = "project_123") {
  return {
    metadata: { uid: id, projectId, name: id, description: null, archivedAt: null },
    spec: { scope: "project" },
    status: {},
  };
}

function amaAgent(id: string, input: { projectId?: string; name?: string; provider?: string; model?: string | null } = {}) {
  return {
    metadata: {
      uid: id,
      projectId: input.projectId ?? "project_123",
      name: input.name ?? "agent",
      description: null,
      archivedAt: null,
    },
    spec: {
      provider: input.provider ?? "openai",
      model: input.model ?? "gpt-5.3-codex",
      systemPrompt: "",
      skills: [],
      subagents: [],
      allowedTools: [],
      mcpConnectors: [],
    },
    status: {},
  };
}

function amaCredentialSecretRef(vaultId: string, credentialId: string, _versionId?: string) {
  return `ama://vaults/${vaultId}/credentials/${credentialId}`;
}

function amaMemoryStore(id: string, name: string, projectId = "project_123") {
  return {
    metadata: { uid: id, projectId, name, description: null, archivedAt: null },
    spec: {},
    status: {},
  };
}

function amaTrigger(id: string, body: any, input: { type?: "schedule" | "http"; intervalSeconds?: number; active?: boolean } = {}) {
  const source =
    input.type === "http"
      ? { type: "http" as const }
      : { type: "schedule" as const, schedule: { intervalSeconds: input.intervalSeconds ?? 3600, windowSeconds: 0 } };
  return {
    metadata: { uid: id, name: body.metadata?.name ?? "trigger", archivedAt: null },
    spec: {
      source,
      suspend: input.active === false,
      template: { metadata: body.spec?.template?.metadata ?? { labels: {}, annotations: {} }, spec: body.spec?.template?.spec ?? {} },
    },
    status: { lastDispatchedAt: null, lastRunId: null },
  };
}

function amaTriggerRun(input: {
  id: string;
  triggerId: string;
  scheduledFor: string | null;
  heartbeatAt: string | null;
  triggeredAt: string;
  phase: string;
  sessionId: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    metadata: { uid: input.id, projectId: "project_123", createdAt: input.createdAt, updatedAt: input.updatedAt },
    spec: { triggerId: input.triggerId, scheduledFor: input.scheduledFor, metadata: input.metadata },
    status: {
      phase: input.phase,
      heartbeatAt: input.heartbeatAt,
      triggeredAt: input.triggeredAt,
      sessionId: input.sessionId,
      errorMessage: input.errorMessage,
    },
  };
}

function amaMemory(input: {
  id: string;
  storeId: string;
  projectId: string;
  path: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    metadata: { uid: input.id, projectId: input.projectId, createdAt: input.createdAt, updatedAt: input.updatedAt },
    spec: { storeId: input.storeId, path: input.path, content: input.content, metadata: input.metadata },
    status: {},
  };
}

function amaSession(
  id: string,
  input: {
    projectId?: string;
    name?: string;
    agentId?: string;
    environmentId?: string | null;
    runtime?: string;
    phase?: string;
    reason?: string | null;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    createdAt?: string;
    updatedAt?: string;
  } = {},
) {
  return {
    metadata: {
      uid: id,
      projectId: input.projectId ?? "project_123",
      name: input.name ?? id,
      labels: input.labels ?? {},
      annotations: input.annotations ?? {},
      archivedAt: null,
      createdAt: input.createdAt ?? new Date().toISOString(),
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    },
    spec: {
      agentId: input.agentId ?? "ama_agent_123",
      environmentId: input.environmentId ?? "env_123",
      runtime: input.runtime ?? "codex",
    },
    status: { phase: input.phase ?? "pending", reason: input.reason ?? null },
  };
}

async function apiRequest(method: string, path: string, body?: unknown, token?: string) {
  const { api } = await import("../apps/web/server/routes");
  const headers: Record<string, string> = { "Content-Type": "application/json", Host: "localhost:8788", "x-forwarded-proto": "http" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined && method !== "GET") init.body = JSON.stringify(body);
  return api.request(path, init, env);
}

beforeAll(async () => {
  ({ mf, db: env.DB } = await setupMiniflare());
});

afterAll(async () => {
  await mf.dispose();
});

describe("routes", () => {
  const userId = "routes-test-user";
  let apiKey: string;
  let userToken: string;
  let userTokenOwnerId: string;
  let machineId: string;
  let agentId: string;
  let sessionId: string;
  let sessionPrivateKey: CryptoKey;
  let amaSessionId: string;
  let leaderAgentId: string;
  let leaderSessionId: string;
  let leaderSessionPrivateKey: CryptoKey;
  let boardId: string;

  async function createApiKeyForUser(userId: string): Promise<string> {
    const { createAuth } = await import("../apps/web/server/betterAuth");
    const auth = createAuth(env);
    const result = await auth.api.createApiKey({ body: { userId } });
    return result.key;
  }

  async function createUserSessionToken(): Promise<{ token: string; userId: string }> {
    const { createAuth } = await import("../apps/web/server/betterAuth");
    const auth = createAuth(env);
    const result = await signUpVerifiedUser(env.DB, auth, {
      name: "Routes Test User",
      email: "routes-session@test.com",
      password: "test-password-123",
    });
    return { token: result.token, userId: result.user.id };
  }

  async function configureAmaOwnerRuntime(ownerId: string, runtime: string, environmentId: string, projectId = "project_123", vaultId = "vault_123") {
    // AK dispatches to AMA as the owner's own linked AMA account; ensure the
    // link exists so the per-user token resolves (idempotent across owners).
    const linked = await env.DB.prepare("SELECT 1 FROM account WHERE userId = ? AND providerId = 'ama'").bind(ownerId).first();
    if (!linked) await linkAmaAccount(env.DB, ownerId);
    // AMA-only fixtures must not accidentally exercise the legacy heartbeat
    // fallback. The runner mock below is the intended availability source.
    const now = new Date(Date.now() - 61_000).toISOString();
    await env.DB.prepare(
      `INSERT INTO ama_owner_integrations (owner_id, ama_project_id, external_tenant_id, session_secret_vault_id, metadata)
       VALUES (?, ?, ?, ?, '{}')
       ON CONFLICT(owner_id) DO UPDATE SET
         ama_project_id = excluded.ama_project_id,
         external_tenant_id = excluded.external_tenant_id,
         session_secret_vault_id = excluded.session_secret_vault_id`,
    )
      .bind(ownerId, projectId, ownerId, vaultId)
      .run();
    await env.DB.prepare(
      `INSERT INTO machines (id, owner_id, device_id, name, os, version, runtimes, status, last_heartbeat_at, created_at, ama_environment_id)
       VALUES (?, ?, ?, ?, 'test', '1.0.0', ?, 'online', ?, ?, ?)
       ON CONFLICT(owner_id, device_id) DO UPDATE SET
         runtimes = excluded.runtimes,
         status = 'online',
         last_heartbeat_at = excluded.last_heartbeat_at,
         ama_environment_id = excluded.ama_environment_id`,
    )
      .bind(
        `machine-${ownerId}-${runtime}`,
        ownerId,
        `ama-test-${ownerId}-${runtime}`,
        `ama-test-${runtime}`,
        JSON.stringify([{ name: runtime, status: "ready", checked_at: now }]),
        now,
        now,
        environmentId,
      )
      .run();
  }

  async function signSessionJWT(): Promise<string> {
    return new SignJWT({ sub: sessionId, aid: agentId, jti: randomUUID(), aud: BETTER_AUTH_URL })
      .setProtectedHeader({ alg: "EdDSA", typ: "agent+jwt" })
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(sessionPrivateKey);
  }

  async function signAmaSessionJWT(): Promise<string> {
    return new SignJWT({ sub: amaSessionId, aid: agentId, jti: randomUUID(), aud: BETTER_AUTH_URL })
      .setProtectedHeader({ alg: "EdDSA", typ: "agent+jwt" })
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(sessionPrivateKey);
  }

  async function signLeaderSessionJWT(): Promise<string> {
    return new SignJWT({ sub: leaderSessionId, aid: leaderAgentId, jti: randomUUID(), aud: BETTER_AUTH_URL })
      .setProtectedHeader({ alg: "EdDSA", typ: "agent+jwt" })
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(leaderSessionPrivateKey);
  }

  beforeAll(async () => {
    await seedUser(env.DB, userId, "routes@test.com");
    apiKey = await createApiKeyForUser(userId);
    const userSession = await createUserSessionToken();
    userToken = userSession.token;
    userTokenOwnerId = userSession.userId;

    const machineRes = await apiRequest(
      "POST",
      "/api/machines",
      {
        name: "routes-machine",
        os: "darwin",
        version: "1.0.0",
        runtimes: [{ name: "claude", status: "ready", checked_at: "2026-03-21T10:00:00Z" }],
        device_id: "test-device-routes",
      },
      apiKey,
    );
    expect(machineRes.status).toBe(201);
    machineId = ((await machineRes.json()) as { id: string }).id;
    const heartbeatRes = await apiRequest("POST", `/api/machines/${machineId}/heartbeat`, {}, apiKey);
    expect(heartbeatRes.status).toBe(200);

    const agent = await createTestAgent(env.DB, userId, { name: "Routes Agent", username: "routes-agent", runtime: "claude" });
    agentId = agent.id;

    sessionId = randomUUID();
    const keypair = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"]);
    sessionPrivateKey = (keypair as any).privateKey;
    const pubJwk = await crypto.subtle.exportKey("jwk", (keypair as any).publicKey);
    await apiRequest(
      "POST",
      `/api/agents/${agentId}/sessions`,
      {
        session_id: sessionId,
        session_public_key: pubJwk.x!,
      },
      apiKey,
    );
    amaSessionId = randomUUID();
    const { createAmaAgentSession } = await import("../apps/web/server/agentSessionRepo");
    await createAmaAgentSession(env.DB, env, {
      ownerId: userId,
      agentId,
      sessionId: amaSessionId,
      sessionPublicKey: pubJwk.x!,
      amaSessionId: `ama-${amaSessionId}`,
    });
    // Create a leader agent and session for complete/cancel/reject tests
    const leaderAgent = await createTestAgent(env.DB, userId, {
      name: "Routes Leader Agent",
      username: "routes-leader-agent",
      runtime: "claude",
      kind: "leader",
    });
    leaderAgentId = leaderAgent.id;

    leaderSessionId = randomUUID();
    const leaderKeypair = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"]);
    leaderSessionPrivateKey = (leaderKeypair as any).privateKey;
    const leaderPubJwk = await crypto.subtle.exportKey("jwk", (leaderKeypair as any).publicKey);
    await apiRequest(
      "POST",
      `/api/agents/${leaderAgentId}/sessions`,
      {
        session_id: leaderSessionId,
        session_public_key: leaderPubJwk.x!,
      },
      apiKey,
    );

    const { createBoard } = await import("../apps/web/server/boardRepo");
    const board = await createBoard(env.DB, userId, "routes-board", "ops");
    boardId = board.id;
  });

  // ─── Auth ───

  it("returns 401 for missing token", async () => {
    const res = await apiRequest("GET", "/api/boards");
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("authenticates with API key", async () => {
    const res = await apiRequest("GET", "/api/boards", undefined, apiKey);
    expect(res.status).toBe(200);
  });

  // ─── Error handler ───

  it("onError returns structured error for HTTPException", async () => {
    const res = await apiRequest("GET", "/api/boards/nonexistent", undefined, apiKey);
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toBeDefined();
    expect(body.error.message).toBe("Board not found");
  });

  // ─── Boards ───

  it("POST /api/boards creates a board", async () => {
    const res = await apiRequest("POST", "/api/boards", { name: "Route Board", type: "dev", description: "Test" }, userToken);
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.name).toBe("Route Board");
    expect(body.description).toBe("Test");
  });

  it("POST /api/boards requires name", async () => {
    const res = await apiRequest("POST", "/api/boards", { description: "No name" }, userToken);
    expect(res.status).toBe(400);
  });

  it("GET /api/boards lists boards", async () => {
    const res = await apiRequest("GET", "/api/boards", undefined, apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/boards?name= finds board by name", async () => {
    const res = await apiRequest("GET", "/api/boards?name=Route Board", undefined, userToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.name).toBe("Route Board");
  });

  it("GET /api/boards?name= returns 404 for unknown name", async () => {
    const res = await apiRequest("GET", "/api/boards?name=Nonexistent", undefined, apiKey);
    expect(res.status).toBe(404);
  });

  it("GET /api/boards/:id returns board with tasks", async () => {
    const res = await apiRequest("GET", `/api/boards/${boardId}`, undefined, apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(boardId);
    expect(Array.isArray(body.tasks)).toBe(true);
  });

  it("GET /api/boards/:id returns 404 for unknown board", async () => {
    const res = await apiRequest("GET", "/api/boards/nonexistent", undefined, apiKey);
    expect(res.status).toBe(404);
  });

  it("PATCH /api/boards/:id updates board", async () => {
    const res = await apiRequest("PATCH", `/api/boards/${boardId}`, { name: "Updated Board" }, userToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.name).toBe("Updated Board");
  });

  it("PATCH /api/boards/:id returns 404 for unknown board", async () => {
    const res = await apiRequest("PATCH", "/api/boards/nonexistent", { name: "X" }, userToken);
    expect(res.status).toBe(404);
  });

  it("DELETE /api/boards/:id deletes board", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const board = await createBoard(env.DB, userId, "Delete Route Board", "dev");
    const res = await apiRequest("DELETE", `/api/boards/${board.id}`, undefined, userToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
  });

  it("DELETE /api/boards/:id returns 404 for unknown board", async () => {
    const res = await apiRequest("DELETE", "/api/boards/nonexistent", undefined, userToken);
    expect(res.status).toBe(404);
  });

  it("GET /api/share/:slug/badge.svg returns AK metric badges", async () => {
    const { createBoard, updateBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const board = await createBoard(env.DB, userId, `badge-board-${Date.now()}`, "ops");
    const publicBoard = await updateBoard(env.DB, board.id, { visibility: "public" });
    const task = await createTask(env.DB, userId, { board_id: board.id, title: "Completed badge task" });
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").bind(task.id).run();
    await env.DB.prepare(
      "UPDATE agent_sessions SET input_tokens = 1000000, output_tokens = 200000, cache_read_tokens = 30000, cache_creation_tokens = 4000 WHERE id = ?",
    )
      .bind(sessionId)
      .run();

    const agentCount = await env.DB.prepare("SELECT COUNT(*) as count FROM agents WHERE owner_id = ? AND COALESCE(version, 'latest') = 'latest'")
      .bind(userId)
      .first<{ count: number }>();

    const agents = await apiRequest("GET", `/api/share/${publicBoard!.share_slug}/badge.svg?type=agents`);
    const tasks = await apiRequest("GET", `/api/share/${publicBoard!.share_slug}/badge.svg?type=tasks`);
    const tokens = await apiRequest("GET", `/api/share/${publicBoard!.share_slug}/badge.svg?type=tokens`);

    expect(await agents.text()).toContain(`${agentCount!.count} agents`);
    expect(await tasks.text()).toContain("1 tasks");
    expect(await tokens.text()).toContain("1.2M tokens");
  });

  // ─── Repositories ───

  it("POST /api/repositories creates a repository", async () => {
    const res = await apiRequest("POST", "/api/repositories", { name: "test-repo", url: "https://github.com/org/test-repo" }, userToken);
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.name).toBe("test-repo");
    expect(body.url).toBe("https://github.com/org/test-repo");
  });

  it("POST /api/repositories requires name and url", async () => {
    const res = await apiRequest("POST", "/api/repositories", { name: "no-url" }, userToken);
    expect(res.status).toBe(400);
  });

  it("GET /api/repositories lists repositories", async () => {
    const res = await apiRequest("GET", "/api/repositories", undefined, userToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/repositories?url= filters by URL", async () => {
    const res = await apiRequest("GET", "/api/repositories?url=https://github.com/org/test-repo", undefined, userToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/repositories?board_id= lists repositories associated with that board", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { recordBoardRepository } = await import("../apps/web/server/boardRepositoryRepo");
    const { createRepository } = await import("../apps/web/server/repositoryRepo");
    const board = await createBoard(env.DB, userTokenOwnerId, `repo-scope-${crypto.randomUUID()}`, "dev");
    const included = await createRepository(env.DB, userTokenOwnerId, {
      name: `included-${crypto.randomUUID()}`,
      url: "https://github.com/scope-org/included-repo",
    });
    await createRepository(env.DB, userTokenOwnerId, {
      name: `excluded-${crypto.randomUUID()}`,
      url: "https://github.com/scope-org/excluded-repo",
    });
    await recordBoardRepository(env.DB, board.id, included.id);

    const res = await apiRequest("GET", `/api/repositories?board_id=${board.id}`, undefined, userToken);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body.map((repo) => repo.id)).toEqual([included.id]);
    expect(body[0]).toMatchObject({ full_name: "scope-org/included-repo", url: "https://github.com/scope-org/included-repo" });
  });

  it("POST /api/repositories/:id/github-token rejects machine identity", async () => {
    const { createRepository } = await import("../apps/web/server/repositoryRepo");
    const repo = await createRepository(env.DB, userId, {
      name: `machine-token-repo-${crypto.randomUUID()}`,
      url: "https://github.com/machine-token-org/repo",
    });

    const res = await apiRequest("POST", `/api/repositories/${repo.id}/github-token`, undefined, apiKey);

    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.message).toBe("user or agent:worker or agent:leader required");
  });

  it("DELETE /api/repositories/:id deletes a repository", async () => {
    const { createRepository } = await import("../apps/web/server/repositoryRepo");
    const repo = await createRepository(env.DB, userId, { name: "del-repo", url: "https://github.com/org/del-repo" });
    const jwt = await signLeaderSessionJWT();
    const res = await apiRequest("DELETE", `/api/repositories/${repo.id}`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
  });

  it("DELETE /api/repositories/:id returns 404 for unknown repo", async () => {
    const jwt = await signLeaderSessionJWT();
    const res = await apiRequest("DELETE", "/api/repositories/nonexistent", undefined, jwt);
    expect(res.status).toBe(404);
  });

  it("POST /api/repositories rejects file:// URL with 400", async () => {
    const res = await apiRequest("POST", "/api/repositories", { name: "x", url: "file:///tmp/x" }, userToken);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toMatch(/file:\/\/\/tmp\/x/);
  });

  // ─── Agents ───

  it("GET /api/agents lists agents", async () => {
    const res = await apiRequest("GET", "/api/agents", undefined, apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body)).toBe(true);
  });

  it("GET /api/agents filters by kind, role, runtime, and availability", async () => {
    await createTestAgent(env.DB, userId, { username: "filter-claude-agent", runtime: "claude", role: "filter-specialist" });
    await createTestAgent(env.DB, userId, { username: "filter-copilot-agent", runtime: "copilot", role: "filter-specialist" });

    const res = await apiRequest("GET", "/api/agents?kind=worker&role=filter-specialist&runtime=claude&available=true", undefined, apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body.map((agent) => agent.username)).toEqual(["filter-claude-agent"]);
  });

  it("GET /api/agents?maintainer=true returns only maintainer worker agents", async () => {
    await createTestAgent(env.DB, userId, { username: "maintainer-filter-agent", runtime: "codex", role: "board-maintainer" });
    await createTestAgent(env.DB, userId, { username: "ordinary-filter-agent", runtime: "codex", role: "implementation" });

    const res = await apiRequest("GET", "/api/agents?kind=worker&maintainer=true", undefined, apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body.map((agent) => agent.username)).toContain("maintainer-filter-agent");
    expect(body.map((agent) => agent.username)).not.toContain("ordinary-filter-agent");
  });

  it("GET /api/agents returns only the latest row for versioned usernames", async () => {
    const username = `latest-list-${randomUUID().slice(0, 8)}`;
    const createRes = await apiRequest("POST", "/api/agents", { username, runtime: "codex", role: "board-maintainer", soul: "historical" }, apiKey);
    expect(createRes.status).toBe(201);
    const updateRes = await apiRequest("POST", "/api/agents", { username, runtime: "codex", role: "board-maintainer", soul: "latest" }, apiKey);
    expect(updateRes.status).toBe(201);

    const agentsRes = await apiRequest("GET", "/api/agents", undefined, apiKey);
    expect(agentsRes.status).toBe(200);
    const agents = await readListedAgents(agentsRes);
    expect(agents.filter((agent) => agent.username === username)).toEqual([
      expect.objectContaining({ kind: "worker", role: "board-maintainer", soul: "latest", version: "latest" }),
    ]);

    const maintainerRes = await apiRequest("GET", "/api/agents?kind=worker&maintainer=true", undefined, apiKey);
    expect(maintainerRes.status).toBe(200);
    const maintainers = await readListedAgents(maintainerRes);
    expect(maintainers.filter((agent) => agent.username === username)).toEqual([
      expect.objectContaining({ kind: "worker", role: "board-maintainer", soul: "latest", version: "latest" }),
    ]);
  });

  // ─── Models ───

  it("GET /api/models requires a valid runtime", async () => {
    const missing = await apiRequest("GET", "/api/models", undefined, apiKey);
    expect(missing.status).toBe(400);

    const invalid = await apiRequest("GET", "/api/models?runtime=not-a-runtime", undefined, apiKey);
    expect(invalid.status).toBe(400);
  });

  it("GET /api/models returns an empty list when no runner is online", async () => {
    const previousAma = {
      AMA_ORIGIN: env.AMA_ORIGIN,
      AMA_OIDC_ISSUER: env.AMA_OIDC_ISSUER,
      AMA_OIDC_CLIENT_ID: env.AMA_OIDC_CLIENT_ID,
      AMA_OIDC_CLIENT_SECRET: env.AMA_OIDC_CLIENT_SECRET,
    };
    Object.assign(env, {
      AMA_ORIGIN: "https://ama.test",
      AMA_OIDC_ISSUER: "https://auth.test",
      AMA_OIDC_CLIENT_ID: "ak-app",
      AMA_OIDC_CLIENT_SECRET: "ak-secret",
    });
    await configureAmaOwnerRuntime(userId, "hermes", "env_models_empty");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") {
        return jsonResponse({ access_token: "oauth-token" });
      }
      // hermes is a self-hosted runtime: AMA returns no cloud models, falling through to runner discovery
      if (url === "https://ama.test/api/v1/runtimes/hermes/models") {
        return jsonResponse({ data: [] });
      }
      if (url === "https://ama.test/api/v1/runners?environmentId=env_models_empty&limit=100") {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await apiRequest("GET", "/api/models?runtime=hermes", undefined, apiKey);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual([]);
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
    }
  });

  it("GET /api/agents rejects invalid filters", async () => {
    const invalidRole = await apiRequest("GET", "/api/agents?role=BadRole", undefined, apiKey);
    expect(invalidRole.status).toBe(400);

    const invalidKind = await apiRequest("GET", "/api/agents?kind=manager", undefined, apiKey);
    expect(invalidKind.status).toBe(400);

    const invalidAvailable = await apiRequest("GET", "/api/agents?available=yes", undefined, apiKey);
    expect(invalidAvailable.status).toBe(400);
  });

  it("GET /api/agents/:id returns agent with logs", async () => {
    const res = await apiRequest("GET", `/api/agents/${agentId}`, undefined, apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(agentId);
    expect(body).toHaveProperty("logs");
  });

  it("GET /api/agents/:id returns 404 for unknown agent", async () => {
    const res = await apiRequest("GET", "/api/agents/nonexistent", undefined, apiKey);
    expect(res.status).toBe(404);
  });

  it("POST /api/agents creates an agent", async () => {
    const res = await apiRequest("POST", "/api/agents", { name: "New Route Agent", username: "new-route-agent", runtime: "claude" }, apiKey);
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.name).toBe("New Route Agent");
    expect(body.runtime).toBe("claude");
  });

  it("POST /api/agents allows leader-only runtimes for leaders", async () => {
    const res = await apiRequest(
      "POST",
      "/api/agents",
      { name: "OpenCode Leader", username: "opencode-route-leader", runtime: "opencode", kind: "leader" },
      apiKey,
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ runtime: "opencode", kind: "leader" });
  });

  it("POST /api/agents allows Antigravity as a leader runtime", async () => {
    const res = await apiRequest(
      "POST",
      "/api/agents",
      { name: "Antigravity Leader", username: "antigravity-route-leader", runtime: "antigravity", kind: "leader" },
      apiKey,
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ runtime: "antigravity", kind: "leader" });
  });

  it("POST /api/agents allows Pi for leaders and rejects it for workers", async () => {
    const leaderRes = await apiRequest(
      "POST",
      "/api/agents",
      { name: "Pi Leader", username: "pi-route-leader", runtime: "pi", kind: "leader" },
      apiKey,
    );
    expect(leaderRes.status).toBe(201);
    expect(await leaderRes.json()).toMatchObject({ runtime: "pi", kind: "leader" });

    const workerRes = await apiRequest("POST", "/api/agents", { username: "pi-route-worker", runtime: "pi" }, apiKey);
    expect(workerRes.status).toBe(400);
    const body = (await workerRes.json()) as any;
    expect(body.error.message).toContain('Invalid worker runtime "pi"');
  });

  it("POST /api/agents rejects leader-only runtimes for workers", async () => {
    const res = await apiRequest("POST", "/api/agents", { username: "opencode-route-worker", runtime: "opencode" }, apiKey);

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain('Invalid worker runtime "opencode"');
  });

  it("POST /api/agents requires username", async () => {
    const res = await apiRequest("POST", "/api/agents", { runtime: "claude" }, apiKey);
    expect(res.status).toBe(400);
  });

  it("POST /api/agents requires runtime", async () => {
    const res = await apiRequest("POST", "/api/agents", { username: "no-runtime-agent" }, apiKey);
    expect(res.status).toBe(400);
  });

  it("POST /api/agents rejects invalid username format", async () => {
    const res = await apiRequest("POST", "/api/agents", { username: "My Invalid Agent!", runtime: "claude" }, apiKey);
    expect(res.status).toBe(400);
  });

  it("POST /api/agents cannot update an existing leader by username", async () => {
    const leader = await createTestAgent(env.DB, userId, {
      name: "Immutable Goose Leader",
      username: "immutable-goose-leader",
      runtime: "goose",
      kind: "leader",
    });

    const nameRes = await apiRequest(
      "POST",
      "/api/agents",
      { name: "Mutated Goose Leader", username: leader.username, runtime: "goose", kind: "leader" },
      apiKey,
    );
    expect(nameRes.status).toBe(409);
    const nameBody = (await nameRes.json()) as any;
    expect(nameBody.error.message).toBe("Leader agents cannot be modified");

    const runtimeRes = await apiRequest(
      "POST",
      "/api/agents",
      { name: "Immutable Goose Leader", username: leader.username, runtime: "cursor", kind: "leader" },
      apiKey,
    );
    expect(runtimeRes.status).toBe(409);
    const runtimeBody = (await runtimeRes.json()) as any;
    expect(runtimeBody.error.message).toBe("Leader agents cannot be modified");

    const persisted = await env.DB.prepare("SELECT name, kind, runtime FROM agents WHERE id = ? AND version = 'latest'")
      .bind(leader.id)
      .first<{ name: string; kind: string; runtime: string }>();
    expect(persisted).toEqual({ name: "Immutable Goose Leader", kind: "leader", runtime: "goose" });

    await env.DB.prepare("DELETE FROM agents WHERE id = ?").bind(leader.id).run();
  });

  it("POST /api/agents cannot replace an existing leader with a worker", async () => {
    const leader = await createTestAgent(env.DB, userId, {
      name: "Immutable Qwen Post Leader",
      username: "immutable-qwen-post-leader",
      runtime: "qwen",
      kind: "leader",
    });

    const res = await apiRequest("POST", "/api/agents", { name: "Replacement Worker", username: leader.username, runtime: "codex" }, apiKey);
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error.message).toBe("Leader agents cannot be modified");

    const persisted = await env.DB.prepare("SELECT name, kind, runtime FROM agents WHERE id = ? AND version = 'latest'")
      .bind(leader.id)
      .first<{ name: string; kind: string; runtime: string }>();
    expect(persisted).toEqual({ name: "Immutable Qwen Post Leader", kind: "leader", runtime: "qwen" });

    await env.DB.prepare("DELETE FROM agents WHERE id = ?").bind(leader.id).run();
  });

  it("POST /api/agents cannot convert an existing worker into a leader", async () => {
    const worker = await createTestAgent(env.DB, userId, {
      name: "Stable Worker Kind",
      username: "stable-worker-kind",
      runtime: "codex",
    });

    const res = await apiRequest(
      "POST",
      "/api/agents",
      { name: "Converted Leader", username: worker.username, runtime: "codex", kind: "leader" },
      apiKey,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error.message).toBe("Agent kind cannot be changed");

    const persisted = await env.DB.prepare("SELECT name, kind, runtime FROM agents WHERE id = ? AND version = 'latest'")
      .bind(worker.id)
      .first<{ name: string; kind: string; runtime: string }>();
    expect(persisted).toEqual({ name: "Stable Worker Kind", kind: "worker", runtime: "codex" });
  });

  it("POST /api/agents updates latest and snapshots the previous latest for an existing username", async () => {
    const r1 = await apiRequest("POST", "/api/agents", { name: "Worker Before Upsert", username: "dupe-agent", runtime: "claude" }, apiKey);
    expect(r1.status).toBe(201);
    const r2 = await apiRequest(
      "POST",
      "/api/agents",
      { name: "Worker After Upsert", username: "dupe-agent", runtime: "claude", soul: "second" },
      apiKey,
    );
    expect(r2.status).toBe(201);
    const first = (await r1.json()) as any;
    const second = (await r2.json()) as any;
    expect(first.version).toBe("latest");
    expect(second.id).toBe(first.id);
    expect(second.version).toBe("latest");
    expect(second).toMatchObject({ name: "Worker After Upsert", kind: "worker", runtime: "claude" });
    expect(second.soul).toBe("second");

    const persisted = await env.DB.prepare("SELECT name, kind, runtime FROM agents WHERE id = ? AND version = 'latest'")
      .bind(first.id)
      .first<{ name: string; kind: string; runtime: string }>();
    expect(persisted).toEqual({ name: "Worker After Upsert", kind: "worker", runtime: "claude" });

    const snapshots = await env.DB.prepare("SELECT version FROM agents WHERE username = ? AND version != 'latest'").bind("dupe-agent").all<any>();
    expect(snapshots.results).toHaveLength(1);
    expect(snapshots.results[0].version).toMatch(/^[a-f0-9]{10}$/);
  });

  it("POST /api/agents returns username in response", async () => {
    const res = await apiRequest("POST", "/api/agents", { username: "username-check-agent", runtime: "claude" }, apiKey);
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.username).toBe("username-check-agent");
  });

  it("POST /api/agents rejects a second leader for the same runtime", async () => {
    const res = await apiRequest(
      "POST",
      "/api/agents",
      { username: "second-routes-leader", name: "Second Routes Leader", runtime: "claude", kind: "leader" },
      apiKey,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain('Leader agent for runtime "claude" already exists');
  });

  it("GET /api/agents returns email derived from username", async () => {
    const res = await apiRequest("GET", "/api/agents", undefined, apiKey);
    expect(res.status).toBe(200);
    const agents = (await res.json()) as any[];
    for (const agent of agents) {
      if (agent.username) {
        expect(agent.email).toBe(`${agent.username}@mails.agent-kanban.dev`);
      }
    }
  });

  it("GET /api/agents/:id returns email derived from username", async () => {
    const res = await apiRequest("GET", `/api/agents/${agentId}`, undefined, apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.username).toBeTruthy();
    expect(body.email).toBe(`${body.username}@mails.agent-kanban.dev`);
  });

  it("POST /api/agents rejects reserved role", async () => {
    const res = await apiRequest(
      "POST",
      "/api/agents",
      { name: "Bad Role", username: "bad-role", runtime: "claude", role: "quality-goalkeeper" },
      apiKey,
    );
    expect(res.status).toBe(403);
  });

  it("POST /api/agents rejects non-kebab-case role", async () => {
    const res = await apiRequest(
      "POST",
      "/api/agents",
      { name: "Bad Role Format", username: "bad-role-format", runtime: "claude", role: "Frontend Reviewer" },
      apiKey,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("role must be kebab-case");
  });

  it("POST /api/agents rejects non-kebab-case handoff roles", async () => {
    const res = await apiRequest(
      "POST",
      "/api/agents",
      { name: "Bad Handoff Role", username: "bad-handoff-role", runtime: "claude", handoff_to: ["QA Reviewer"] },
      apiKey,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("handoff_to must be an array of kebab-case agent roles");
  });

  it("POST /api/agents rejects malformed skill refs", async () => {
    const res = await apiRequest(
      "POST",
      "/api/agents",
      { name: "Bad Skill", username: "bad-skill", runtime: "claude", skills: ["agent-kanban"] },
      apiKey,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain('Invalid skill "agent-kanban"');
  });

  it("POST /api/subagents creates subagent profiles with model mappings and no identity", async () => {
    const res = await apiRequest(
      "POST",
      "/api/subagents",
      {
        name: "Reusable Test Writer",
        username: "reusable-test-writer",
        role: "test-writer",
        models: { claude: "sonnet", codex: "gpt-5.1-codex" },
      },
      apiKey,
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.models).toEqual({ claude: "sonnet", codex: "gpt-5.1-codex" });
    expect(body).not.toHaveProperty("public_key");
    expect(body).not.toHaveProperty("fingerprint");
  });

  it("POST /api/agents stores registered subagent IDs", async () => {
    const subagent = await createTestSubagent(env.DB, userId, {
      name: "Create Route Subagent",
      username: "create-route-subagent",
    });
    const res = await apiRequest(
      "POST",
      "/api/agents",
      {
        name: "Subagent Route Agent",
        username: "subagent-route-agent",
        runtime: "claude",
        subagents: [subagent.id],
      },
      apiKey,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.subagents).toEqual([subagent.id]);
  });

  it.each(["copilot"] as const)("POST /api/agents allows %s agents with subagents", async (runtime) => {
    const subagent = await createTestSubagent(env.DB, userId, {
      name: `Create ${runtime} Route Subagent`,
      username: `create-${runtime}-route-subagent`,
    });
    const res = await apiRequest(
      "POST",
      "/api/agents",
      {
        name: `${runtime} Subagent Route Agent`,
        username: `${runtime}-subagent-route-agent`,
        runtime,
        subagents: [subagent.id],
      },
      apiKey,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.subagents).toEqual([subagent.id]);
  });

  it("POST /api/agents rejects worker agent IDs as subagents", async () => {
    const worker = await createTestAgent(env.DB, userId, {
      name: "Worker Used As Subagent",
      username: "worker-used-as-subagent",
      runtime: "codex",
    });
    const res = await apiRequest(
      "POST",
      "/api/agents",
      { name: "Worker Subagent Parent", username: "worker-subagent-parent", runtime: "claude", subagents: [worker.id] },
      apiKey,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("is not registered");
  });

  it("POST /api/agents rejects nonexistent subagent IDs", async () => {
    const res = await apiRequest(
      "POST",
      "/api/agents",
      { name: "Missing Subagent", username: "missing-subagent", runtime: "claude", subagents: [randomUUID()] },
      apiKey,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("is not registered");
  });

  it("POST /api/agents rejects leader subagent IDs", async () => {
    const res = await apiRequest(
      "POST",
      "/api/agents",
      { name: "Leader Subagent", username: "leader-subagent", runtime: "claude", subagents: [leaderAgentId] },
      apiKey,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("is not registered");
  });

  it("POST /api/agents rejects cross-owner subagent IDs", async () => {
    const otherAgent = await createTestAgent(env.DB, userTokenOwnerId, {
      name: "Other Owner Subagent",
      username: "other-owner-subagent",
      runtime: "claude",
    });
    const res = await apiRequest(
      "POST",
      "/api/agents",
      { name: "Cross Owner Subagent", username: "cross-owner-subagent", runtime: "claude", subagents: [otherAgent.id] },
      apiKey,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("is not registered");
  });

  it.each(["gemini", "hermes"] as const)("POST /api/agents rejects unsupported %s subagents", async (runtime) => {
    const subagent = await createTestSubagent(env.DB, userId, {
      name: `Unsupported ${runtime} Runtime Subagent`,
      username: `unsupported-${runtime}-runtime-subagent`,
    });
    const res = await apiRequest(
      "POST",
      "/api/agents",
      { name: `${runtime} Subagents`, username: `${runtime}-subagents`, runtime, subagents: [subagent.id] },
      apiKey,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain(`Runtime "${runtime}" does not support subagents yet`);
  });

  it("PATCH /api/agents/:id rejects malformed skill refs", async () => {
    const jwt = await signLeaderSessionJWT();
    const res = await apiRequest("PATCH", `/api/agents/${agentId}`, { skills: ["trailofbits/skills"] }, jwt);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain('Invalid skill "trailofbits/skills"');
  });

  it("PATCH /api/agents/:id rejects invalid runtime", async () => {
    const jwt = await signLeaderSessionJWT();
    const res = await apiRequest("PATCH", `/api/agents/${agentId}`, { runtime: "bogus" }, jwt);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain('Invalid worker runtime "bogus"');
  });

  it("PATCH /api/agents/:id rejects all leader edits without changing the database", async () => {
    const leaderRes = await apiRequest(
      "POST",
      "/api/agents",
      { name: "Immutable Qwen Leader", username: "qwen-route-leader", runtime: "qwen", kind: "leader" },
      apiKey,
    );
    expect(leaderRes.status).toBe(201);
    const leader = (await leaderRes.json()) as any;
    const jwt = await signLeaderSessionJWT();

    for (const update of [{ name: "Mutated Leader" }, { runtime: "cursor" }]) {
      const res = await apiRequest("PATCH", `/api/agents/${leader.id}`, update, jwt);
      expect(res.status).toBe(403);
      const body = (await res.json()) as any;
      expect(body.error.message).toBe("Leader agents cannot be modified");
    }

    const persisted = await env.DB.prepare("SELECT name, runtime FROM agents WHERE id = ?")
      .bind(leader.id)
      .first<{ name: string; runtime: string }>();
    expect(persisted).toEqual({ name: "Immutable Qwen Leader", runtime: "qwen" });
  });

  it("PATCH /api/agents/:id still allows worker edits", async () => {
    const worker = await createTestAgent(env.DB, userId, {
      name: "Editable Worker Before",
      username: "editable-route-worker",
      runtime: "codex",
    });
    const jwt = await signLeaderSessionJWT();

    const res = await apiRequest("PATCH", `/api/agents/${worker.id}`, { name: "Editable Worker After" }, jwt);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "Editable Worker After", runtime: "codex", kind: "worker" });

    const persisted = await env.DB.prepare("SELECT name, runtime FROM agents WHERE id = ?")
      .bind(worker.id)
      .first<{ name: string; runtime: string }>();
    expect(persisted).toEqual({ name: "Editable Worker After", runtime: "codex" });
  });

  it.each([null, "name-only", 7])("PATCH /api/agents/:id rejects %s JSON body", async (body) => {
    const jwt = await signLeaderSessionJWT();
    const res = await apiRequest("PATCH", `/api/agents/${agentId}`, body, jwt);

    expect(res.status).toBe(400);
    const payload = (await res.json()) as any;
    expect(payload.error.message).toBe("agent update must be a JSON object");
  });

  it("PATCH /api/agents/:id stores registered subagent IDs", async () => {
    const jwt = await signLeaderSessionJWT();
    const subagent = await createTestSubagent(env.DB, userId, {
      name: "Patch Route Subagent",
      username: "patch-route-subagent",
    });
    const res = await apiRequest("PATCH", `/api/agents/${agentId}`, { subagents: [subagent.id] }, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.subagents).toEqual([subagent.id]);
    expect(body).not.toHaveProperty("private_key");
    expect(body).not.toHaveProperty("mailbox_token");
  });

  it("PATCH /api/agents/:id rejects non-kebab-case role", async () => {
    const jwt = await signLeaderSessionJWT();
    const res = await apiRequest("PATCH", `/api/agents/${agentId}`, { role: "Release Manager" }, jwt);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("role must be kebab-case");
  });

  it("PATCH /api/agents/:id rejects non-kebab-case handoff roles", async () => {
    const jwt = await signLeaderSessionJWT();
    const res = await apiRequest("PATCH", `/api/agents/${agentId}`, { handoff_to: ["Release Manager"] }, jwt);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("handoff_to must be an array of kebab-case agent roles");
  });

  it("PATCH /api/agents/:id rejects agent snapshots", async () => {
    await apiRequest("POST", "/api/agents", { username: "patch-snapshot-agent", runtime: "claude", soul: "before" }, userToken);
    await apiRequest("POST", "/api/agents", { username: "patch-snapshot-agent", runtime: "claude", soul: "after" }, userToken);
    const snapshot = await env.DB.prepare("SELECT id FROM agents WHERE username = ? AND version != 'latest'")
      .bind("patch-snapshot-agent")
      .first<any>();

    const res = await apiRequest("PATCH", `/api/agents/${snapshot.id}`, { soul: "mutated" }, userToken);

    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("snapshots cannot be modified");
  });

  it.each(["copilot"] as const)("PATCH /api/agents/:id allows %s agents with subagents", async (runtime) => {
    const jwt = await signLeaderSessionJWT();
    const agent = await createTestAgent(env.DB, userId, {
      name: `Patch ${runtime} Route Agent`,
      username: `patch-${runtime}-route-agent`,
      runtime,
    });
    const subagent = await createTestSubagent(env.DB, userId, {
      name: `Patch ${runtime} Route Subagent`,
      username: `patch-${runtime}-route-subagent`,
    });
    const res = await apiRequest("PATCH", `/api/agents/${agent.id}`, { subagents: [subagent.id] }, jwt);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.runtime).toBe(runtime);
    expect(body.subagents).toEqual([subagent.id]);
  });

  it.each(["gemini", "hermes"] as const)("PATCH /api/agents/:id rejects unsupported %s subagents", async (runtime) => {
    const jwt = await signLeaderSessionJWT();
    const agent = await createTestAgent(env.DB, userId, {
      name: `Patch Unsupported ${runtime} Route Agent`,
      username: `patch-unsupported-${runtime}-route-agent`,
      runtime,
    });
    const subagent = await createTestSubagent(env.DB, userId, {
      name: `Patch Unsupported ${runtime} Route Subagent`,
      username: `patch-unsupported-${runtime}-route-subagent`,
    });
    const res = await apiRequest("PATCH", `/api/agents/${agent.id}`, { subagents: [subagent.id] }, jwt);

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain(`Runtime "${runtime}" does not support subagents yet`);
  });

  it("PATCH /api/agents/:id rejects worker agent IDs as subagents", async () => {
    const jwt = await signLeaderSessionJWT();
    const worker = await createTestAgent(env.DB, userId, {
      name: "Patch Worker Used As Subagent",
      username: "patch-worker-used-as-subagent",
      runtime: "codex",
    });
    const res = await apiRequest("PATCH", `/api/agents/${agentId}`, { subagents: [worker.id] }, jwt);

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("is not registered");
  });

  it("PATCH /api/agents/:id rejects self-reference as a subagent", async () => {
    const jwt = await signLeaderSessionJWT();
    const res = await apiRequest("PATCH", `/api/agents/${agentId}`, { subagents: [agentId] }, jwt);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("Agent cannot include itself as a subagent");
  });

  // ─── Tasks ───

  it("POST /api/tasks creates an unassigned pending task", async () => {
    const jwt = await signSessionJWT();
    const res = await apiRequest("POST", "/api/tasks", { title: "Route Task", board_id: boardId }, jwt);
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.title).toBe("Route Task");
    expect(body.assigned_to).toBeNull();
    expect(body.status).toBe("todo");
  });

  it("POST /api/tasks requires title", async () => {
    const jwt = await signSessionJWT();
    const res = await apiRequest("POST", "/api/tasks", { board_id: boardId }, jwt);
    expect(res.status).toBe(400);
  });

  it("POST /api/tasks keeps description when both description and detail are present", async () => {
    const jwt = await signSessionJWT();
    const res = await apiRequest(
      "POST",
      "/api/tasks",
      {
        title: "Description Wins Task",
        board_id: boardId,
        assigned_to: agentId,
        description: "Use this description",
        detail: "Ignore this detail alias",
      },
      jwt,
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.description).toBe("Use this description");
    expect(body).not.toHaveProperty("detail");
  });

  it("POST /api/tasks rejects non-string detail", async () => {
    const jwt = await signSessionJWT();
    const res = await apiRequest(
      "POST",
      "/api/tasks",
      { title: "Bad Detail", board_id: boardId, assigned_to: agentId, detail: { text: "not a string" } },
      jwt,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toBe("detail must be a string");
  });

  it("POST /api/tasks rejects non-object input", async () => {
    const jwt = await signSessionJWT();
    const res = await apiRequest("POST", "/api/tasks", { title: "Bad Input", board_id: boardId, input: "string" }, jwt);
    expect(res.status).toBe(400);
  });

  it("GET /api/tasks lists tasks", async () => {
    const res = await apiRequest("GET", "/api/tasks", undefined, apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body)).toBe(true);
  });

  it("GET /api/tasks exposes only legacy-owned tasks to a machine identity", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const legacyTask = await createTask(env.DB, userId, {
      title: "Legacy polling task",
      board_id: boardId,
      metadata: { annotations: { "runtime.source": "legacy" } },
    });
    const amaTask = await createTask(env.DB, userId, {
      title: "AMA polling task",
      board_id: boardId,
      metadata: { annotations: { "runtime.source": "ama" } },
    });

    const res = await apiRequest("GET", "/api/tasks", undefined, apiKey);
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as Array<{ id: string }>).map((task) => task.id);
    expect(ids).toContain(legacyTask.id);
    expect(ids).not.toContain(amaTask.id);
  });

  it("GET /api/tasks/:id returns a task", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Get Task", board_id: boardId });
    const res = await apiRequest("GET", `/api/tasks/${task.id}`, undefined, apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(task.id);
  });

  it("GET /api/tasks/:id returns 404 for unknown task", async () => {
    const res = await apiRequest("GET", "/api/tasks/nonexistent", undefined, apiKey);
    expect(res.status).toBe(404);
  });

  it("PATCH /api/tasks/:id updates a task", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Patch Task", board_id: boardId });
    const jwt = await signLeaderSessionJWT();
    const res = await apiRequest("PATCH", `/api/tasks/${task.id}`, { title: "Patched" }, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.title).toBe("Patched");
  });

  it("PATCH /api/tasks/:id returns 404 for unknown task", async () => {
    const jwt = await signLeaderSessionJWT();
    const res = await apiRequest("PATCH", "/api/tasks/nonexistent", { title: "X" }, jwt);
    expect(res.status).toBe(404);
  });

  it("PATCH /api/tasks/:id rejects non-object input", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Bad Patch", board_id: boardId });
    const jwt = await signLeaderSessionJWT();
    const res = await apiRequest("PATCH", `/api/tasks/${task.id}`, { input: 42 }, jwt);
    expect(res.status).toBe(400);
  });

  it("DELETE /api/tasks/:id deletes a task", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Delete Task", board_id: boardId });
    const jwt = await signLeaderSessionJWT();
    const res = await apiRequest("DELETE", `/api/tasks/${task.id}`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
  });

  it("DELETE /api/tasks/:id returns 404 for unknown task", async () => {
    const jwt = await signLeaderSessionJWT();
    const res = await apiRequest("DELETE", "/api/tasks/nonexistent", undefined, jwt);
    expect(res.status).toBe(404);
  });

  // ─── Task Lifecycle ───

  it("POST /api/tasks/:id/assign assigns a task to a worker agent via leader", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Assign Task", board_id: boardId });
    const leaderJwt = await signLeaderSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/assign`, { agent_id: agentId }, leaderJwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.assigned_to).toBe(agentId);
    expect(body).not.toHaveProperty("board_owner_id");
  });

  it("POST /api/tasks/:id/assign rejects leader agents (400)", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Leader Assign Task", board_id: boardId });
    const leaderJwt = await signLeaderSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/assign`, {}, leaderJwt);
    expect(res.status).toBe(400);
  });

  it("POST /api/tasks/:id/complete completes a task", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Complete Task", board_id: boardId });
    await env.DB.prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").bind(task.id).run();
    const leaderJwt = await signLeaderSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/complete`, {}, leaderJwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("done");
  });

  it("POST /api/tasks/:id/release releases a task", async () => {
    const { createTask, assignTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Release Task", board_id: boardId });
    await assignTask(env.DB, task.id, agentId, "machine", "system");
    await env.DB.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").bind(task.id).run();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/release`, {}, apiKey);
    expect(res.status).toBe(200);
  });

  it("POST /api/tasks/:id/release allows leader agents", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Leader Release Task", board_id: boardId });
    await env.DB.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").bind(task.id).run();
    const leaderJwt = await signLeaderSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/release`, {}, leaderJwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("todo");
  });

  it("POST /api/tasks/:id/cancel cancels a task", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Cancel Task", board_id: boardId });
    await env.DB.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").bind(task.id).run();
    const leaderJwt = await signLeaderSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/cancel`, {}, leaderJwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("cancelled");
  });

  it("POST /api/tasks/:id/reject rejects a task in review", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Reject Task", board_id: boardId });
    await env.DB.prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").bind(task.id).run();
    const leaderJwt = await signLeaderSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/reject`, {}, leaderJwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("in_progress");
  });

  // ─── Task Notes ───

  it("POST /api/tasks/:id/notes creates a note", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Note Task", board_id: boardId });
    const jwt = await signSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/notes`, { detail: "A note entry" }, jwt);
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.detail).toBe("A note entry");
  });

  it("POST /api/tasks/:id/notes requires detail", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Note Task 2", board_id: boardId });
    const jwt = await signSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/notes`, {}, jwt);
    expect(res.status).toBe(400);
  });

  it("POST /api/tasks/:id/notes returns 404 for unknown task", async () => {
    const jwt = await signSessionJWT();
    const res = await apiRequest("POST", "/api/tasks/nonexistent/notes", { detail: "X" }, jwt);
    expect(res.status).toBe(404);
  });

  it("GET /api/tasks/:id/notes returns notes", async () => {
    const { createTask, addTaskAction } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Get Notes Task", board_id: boardId });
    await addTaskAction(env.DB, task.id, "machine", "system", "commented", "Test note");
    const res = await apiRequest("GET", `/api/tasks/${task.id}/notes`, undefined, apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/tasks/:id/notes returns 404 for unknown task", async () => {
    const res = await apiRequest("GET", "/api/tasks/nonexistent/notes", undefined, apiKey);
    expect(res.status).toBe(404);
  });

  // ─── Messages ───

  it("POST /api/tasks/:id/messages creates a message", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const userBoard = await createBoard(env.DB, userTokenOwnerId, "msg-board", "ops");
    const task = await createTask(env.DB, userTokenOwnerId, { title: "Msg Task", board_id: userBoard.id });
    const res = await apiRequest(
      "POST",
      `/api/tasks/${task.id}/messages`,
      {
        sender_type: "user",
        content: "Hello",
      },
      userToken,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.content).toBe("Hello");
    expect(body.sender_type).toBe("user");
  });

  it("GET /api/sessions/:sessionId/ws returns a browser socket URL by session id", async () => {
    const previousAma = {
      AMA_ORIGIN: env.AMA_ORIGIN,
      AMA_OIDC_ISSUER: env.AMA_OIDC_ISSUER,
      AMA_OIDC_CLIENT_ID: env.AMA_OIDC_CLIENT_ID,
      AMA_OIDC_CLIENT_SECRET: env.AMA_OIDC_CLIENT_SECRET,
    };
    Object.assign(env, {
      AMA_ORIGIN: "https://ama.test",
      AMA_OIDC_ISSUER: "https://auth.test",
      AMA_OIDC_CLIENT_ID: "ak-app",
      AMA_OIDC_CLIENT_SECRET: "ak-secret",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = reqUrl(input);
        if (url === "https://auth.test/.well-known/openid-configuration") return jsonResponse({ access_token: "user-token" });
        return jsonResponse({ error: "unexpected", url }, 500);
      }),
    );

    try {
      await configureAmaOwnerRuntime(userId, "codex", "env_direct_session_ws", "project_direct_session_ws");
      const res = await apiRequest("GET", "/api/sessions/session_direct_ws/ws", undefined, apiKey);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string };
      const url = new URL(body.url);
      expect(url.origin).toBe("wss://ama.test");
      expect(url.pathname).toBe("/api/v1/sessions/session_direct_ws/socket");
      expect(url.searchParams.get("access_token")).toBe("test.jwt.token");
      expect(url.searchParams.get("x-ama-project-id")).toBe("project_direct_session_ws");
    } finally {
      Object.assign(env, previousAma);
    }
  });

  it("POST /api/tasks/:id/messages requires sender_type and content", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const userBoard = await createBoard(env.DB, userTokenOwnerId, "msg-board-2", "ops");
    const task = await createTask(env.DB, userTokenOwnerId, { title: "Msg Task 2", board_id: userBoard.id });
    const res = await apiRequest("POST", `/api/tasks/${task.id}/messages`, { content: "No sender" }, userToken);
    expect(res.status).toBe(400);
  });

  it("POST /api/tasks/:id/messages rejects invalid sender_type", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const userBoard = await createBoard(env.DB, userTokenOwnerId, "msg-board-3", "ops");
    const task = await createTask(env.DB, userTokenOwnerId, { title: "Msg Task 3", board_id: userBoard.id });
    const res = await apiRequest(
      "POST",
      `/api/tasks/${task.id}/messages`,
      {
        sender_type: "bot",
        content: "Bad type",
      },
      userToken,
    );
    expect(res.status).toBe(400);
  });

  it("POST /api/tasks/:id/messages returns 404 for unknown task", async () => {
    const res = await apiRequest(
      "POST",
      "/api/tasks/nonexistent/messages",
      {
        sender_type: "user",
        content: "X",
      },
      userToken,
    );
    expect(res.status).toBe(404);
  });

  it("GET /api/tasks/:id/messages returns messages", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const { createMessage } = await import("../apps/web/server/messageRepo");
    const task = await createTask(env.DB, userId, { title: "Get Msg Task", board_id: boardId });
    await createMessage(env.DB, task.id, "user", userId, "Test msg");
    const res = await apiRequest("GET", `/api/tasks/${task.id}/messages`, undefined, apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/tasks/:id/messages returns 404 for unknown task", async () => {
    const res = await apiRequest("GET", "/api/tasks/nonexistent/messages", undefined, apiKey);
    expect(res.status).toBe(404);
  });

  // ─── SSE Stream ───

  it("GET /api/tasks/:id/stream returns SSE response", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Stream Task", board_id: boardId });
    const res = await apiRequest("GET", `/api/tasks/${task.id}/stream`, undefined, apiKey);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });

  // ─── Local Runtime Tunnel ───

  it("GET /api/tunnel/ws identifies the local daemon relay without deprecation headers", async () => {
    const previous = env.TUNNEL_RELAY;
    const relayFetch = vi.fn(async () => new Response("ok"));
    Object.assign(env, {
      TUNNEL_RELAY: {
        idFromName: vi.fn(() => "relay-id"),
        get: vi.fn(() => ({ fetch: relayFetch })),
      },
    });

    try {
      const res = await apiRequest("GET", "/api/tunnel/ws?role=browser&sessionId=test-session", undefined, apiKey);

      expect(res.status).toBe(200);
      expect(res.headers.get("Deprecation")).toBeNull();
      expect(res.headers.get("Sunset")).toBeNull();
      expect(res.headers.get("X-AK-Runtime-Surface")).toBe("local-daemon");
      expect(await res.text()).toBe("ok");
      expect(relayFetch).toHaveBeenCalledOnce();
    } finally {
      env.TUNNEL_RELAY = previous;
    }
  });

  // ─── Machines ───

  it("GET /api/machines/:id returns a machine", async () => {
    const res = await apiRequest("GET", `/api/machines/${machineId}`, undefined, apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(machineId);
    expect(body).not.toHaveProperty("ama_environment_id");
  });

  it("GET /api/machines/:id marks stale machines offline", async () => {
    const previousAma = {
      AMA_ORIGIN: env.AMA_ORIGIN,
      AMA_OIDC_ISSUER: env.AMA_OIDC_ISSUER,
      AMA_OIDC_CLIENT_ID: env.AMA_OIDC_CLIENT_ID,
      AMA_OIDC_CLIENT_SECRET: env.AMA_OIDC_CLIENT_SECRET,
    };
    Object.assign(env, {
      AMA_ORIGIN: undefined,
      AMA_OIDC_ISSUER: undefined,
      AMA_OIDC_CLIENT_ID: undefined,
      AMA_OIDC_CLIENT_SECRET: undefined,
    });
    await env.DB.prepare("UPDATE machines SET status = 'online', last_heartbeat_at = ? WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", machineId)
      .run();

    try {
      const res = await apiRequest("GET", `/api/machines/${machineId}`, undefined, apiKey);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.status).toBe("offline");
    } finally {
      Object.assign(env, previousAma);
    }
  });

  it("GET /api/machines/:id returns 404 for unknown machine", async () => {
    const res = await apiRequest("GET", "/api/machines/nonexistent", undefined, apiKey);
    expect(res.status).toBe(404);
  });

  it("POST /api/machines/:id/heartbeat updates machine", async () => {
    const res = await apiRequest("POST", `/api/machines/${machineId}/heartbeat`, { version: "2.0.0" }, apiKey);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-AK-Runtime-Surface")).toBe("local-daemon");
    expect(res.headers.get("Deprecation")).toBeNull();
    expect(res.headers.get("Sunset")).toBeNull();
    await expect(res.json()).resolves.not.toHaveProperty("ama_environment_id");
  });

  it("POST /api/machines/:id/heartbeat rejects a machine API key bound to another machine without mutating the target", async () => {
    const { upsertMachine } = await import("../apps/web/server/machineRepo");
    const target = await upsertMachine(env.DB, userId, {
      name: "routes-target-machine",
      os: "linux",
      version: "1.0.0",
      runtimes: [{ name: "codex", status: "ready", checked_at: "2026-03-21T10:00:00Z" }],
      device_id: `routes-target-device-${randomUUID()}`,
    });
    const before = await env.DB.prepare("SELECT status, version, runtimes, last_heartbeat_at FROM machines WHERE id = ?")
      .bind(target.id)
      .first<any>();

    const res = await apiRequest(
      "POST",
      `/api/machines/${target.id}/heartbeat`,
      {
        version: "9.9.9",
        runtimes: [{ name: "claude", status: "limited", reset_at: "2026-03-21T11:00:00Z", checked_at: "2026-03-21T10:30:00Z" }],
      },
      apiKey,
    );
    const body = (await res.json()) as any;
    const after = await env.DB.prepare("SELECT status, version, runtimes, last_heartbeat_at FROM machines WHERE id = ?").bind(target.id).first<any>();

    expect(res.status).toBe(403);
    expect(body.error.message).toContain("API key is bound to a different machine");
    expect(after).toEqual(before);
  });

  it("POST /api/machines/:id/heartbeat rejects invalid runtime status with 400", async () => {
    const res = await apiRequest(
      "POST",
      `/api/machines/${machineId}/heartbeat`,
      { runtimes: [{ name: "claude", status: "busy", checked_at: "2026-03-21T10:00:00Z" }] },
      apiKey,
    );
    const body = (await res.json()) as any;

    expect(res.status).toBe(400);
    expect(body.error.message).toContain('Invalid runtime status "busy"');
  });

  it("POST /api/machines/:id/heartbeat rejects invalid runtime name with 400", async () => {
    const res = await apiRequest(
      "POST",
      `/api/machines/${machineId}/heartbeat`,
      { runtimes: [{ name: "bad-runtime", status: "ready", checked_at: "2026-03-21T10:00:00Z" }] },
      apiKey,
    );
    const body = (await res.json()) as any;

    expect(res.status).toBe(400);
    expect(body.error.message).toContain('Invalid runtime "bad-runtime"');
  });

  it("POST /api/machines/:id/heartbeat returns 404 for unknown machine", async () => {
    const unboundApiKey = await createApiKeyForUser(userId);
    const res = await apiRequest("POST", "/api/machines/nonexistent/heartbeat", { version: "1.0.0" }, unboundApiKey);
    expect(res.status).toBe(404);
  });

  it("POST /api/machines requires name, os, version, runtimes", async () => {
    const res = await apiRequest("POST", "/api/machines", { name: "incomplete" }, apiKey);
    expect(res.status).toBe(400);
    expect(res.headers.get("X-AK-Runtime-Surface")).toBe("local-daemon");
    expect(res.headers.get("Deprecation")).toBeNull();
    expect(res.headers.get("Sunset")).toBeNull();
  });

  it("POST /api/machines rejects invalid runtime status with 400", async () => {
    const res = await apiRequest(
      "POST",
      "/api/machines",
      {
        name: "invalid-runtime-status-machine",
        os: "darwin",
        version: "1.0.0",
        runtimes: [{ name: "claude", status: "busy", checked_at: "2026-03-21T10:00:00Z" }],
        device_id: "invalid-runtime-status-device",
      },
      apiKey,
    );
    const body = (await res.json()) as any;

    expect(res.status).toBe(400);
    expect(body.error.message).toContain('Invalid runtime status "busy"');
  });

  it("POST /api/machines rejects invalid runtime name with 400", async () => {
    const res = await apiRequest(
      "POST",
      "/api/machines",
      {
        name: "invalid-runtime-name-machine",
        os: "darwin",
        version: "1.0.0",
        runtimes: [{ name: "bad-runtime", status: "ready", checked_at: "2026-03-21T10:00:00Z" }],
        device_id: "invalid-runtime-name-device",
      },
      apiKey,
    );
    const body = (await res.json()) as any;

    expect(res.status).toBe(400);
    expect(body.error.message).toContain('Invalid runtime "bad-runtime"');
  });

  // ─── Agent Sessions ───

  it("GET /api/agents/:agentId/sessions lists sessions", async () => {
    const res = await apiRequest("GET", `/api/agents/${agentId}/sessions`, undefined, apiKey);
    expect(res.status).toBe(200);
    expect(res.headers.get("Deprecation")).toBeNull();
    expect(res.headers.get("Sunset")).toBeNull();
    expect(res.headers.get("X-AK-Runtime-Surface")).toBe("local-daemon");
    const body = (await res.json()) as any;
    expect(Array.isArray(body)).toBe(true);
  });

  it("POST /api/agents/:agentId/sessions requires fields", async () => {
    const res = await apiRequest("POST", `/api/agents/${agentId}/sessions`, {}, apiKey);
    expect(res.status).toBe(400);
    expect(res.headers.get("X-AK-Runtime-Surface")).toBe("local-daemon");
    expect(res.headers.get("Deprecation")).toBeNull();
    expect(res.headers.get("Sunset")).toBeNull();
  });

  it("DELETE /api/agents/:agentId/sessions/:sessionId closes session", async () => {
    const res = await apiRequest("DELETE", `/api/agents/${agentId}/sessions/${sessionId}`, undefined, apiKey);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-AK-Runtime-Surface")).toBe("local-daemon");
    expect(res.headers.get("Deprecation")).toBeNull();
    expect(res.headers.get("Sunset")).toBeNull();
  });

  it("POST /api/agents/:agentId/sessions/:sessionId/reopen reopens session", async () => {
    const res = await apiRequest("POST", `/api/agents/${agentId}/sessions/${sessionId}/reopen`, {}, apiKey);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-AK-Runtime-Surface")).toBe("local-daemon");
    expect(res.headers.get("Deprecation")).toBeNull();
    expect(res.headers.get("Sunset")).toBeNull();
  });

  it("POST /api/agents/:agentId/sessions/:sessionId/reopen returns 404 for nonexistent session", async () => {
    const nonexistentSessionId = randomUUID();
    const res = await apiRequest("POST", `/api/agents/${agentId}/sessions/${nonexistentSessionId}/reopen`, {}, apiKey);
    expect(res.status).toBe(404);
  });

  it("POST /api/agents/:agentId/sessions/:sessionId/reopen is idempotent when session is already active", async () => {
    // Create a fresh session that starts active (status='active', closed_at=NULL)
    const freshSessionId = randomUUID();
    const freshKeypair = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"]);
    const freshPubJwk = await crypto.subtle.exportKey("jwk", (freshKeypair as any).publicKey);
    await apiRequest("POST", `/api/agents/${agentId}/sessions`, { session_id: freshSessionId, session_public_key: freshPubJwk.x! }, apiKey);

    // Inject a sentinel closed_at while keeping status='active'. This state is not reachable
    // via the public API — it exists solely to discriminate the no-op path from an erroneous
    // UPDATE: if reopen runs the UPDATE it would set closed_at to NULL, failing the assertion;
    // if it correctly skips the UPDATE the sentinel value survives unchanged.
    const sentinelClosedAt = "2000-01-01T00:00:00.000Z";
    await env.DB.prepare("UPDATE agent_sessions SET closed_at = ? WHERE id = ?").bind(sentinelClosedAt, freshSessionId).run();

    const res = await apiRequest("POST", `/api/agents/${agentId}/sessions/${freshSessionId}/reopen`, {}, apiKey);
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT status, closed_at FROM agent_sessions WHERE id = ?")
      .bind(freshSessionId)
      .first<{ status: string; closed_at: string | null }>();
    expect(row?.status).toBe("active");
    // The sentinel must survive — proves the UPDATE branch was skipped entirely
    expect(row?.closed_at).toBe(sentinelClosedAt);
  });

  it("POST /api/agents/:agentId/sessions/:sessionId/reopen clears closed_at after close", async () => {
    // Create a session, close it, then reopen and verify closed_at is cleared
    const freshSessionId = randomUUID();
    const freshKeypair = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"]);
    const freshPubJwk = await crypto.subtle.exportKey("jwk", (freshKeypair as any).publicKey);
    await apiRequest("POST", `/api/agents/${agentId}/sessions`, { session_id: freshSessionId, session_public_key: freshPubJwk.x! }, apiKey);

    await apiRequest("DELETE", `/api/agents/${agentId}/sessions/${freshSessionId}`, undefined, apiKey);

    const closedRow = await env.DB.prepare("SELECT status, closed_at FROM agent_sessions WHERE id = ?")
      .bind(freshSessionId)
      .first<{ status: string; closed_at: string | null }>();
    expect(closedRow?.status).toBe("closed");
    expect(closedRow?.closed_at).not.toBeNull();

    const res = await apiRequest("POST", `/api/agents/${agentId}/sessions/${freshSessionId}/reopen`, {}, apiKey);
    expect(res.status).toBe(200);

    const reopenedRow = await env.DB.prepare("SELECT status, closed_at FROM agent_sessions WHERE id = ?")
      .bind(freshSessionId)
      .first<{ status: string; closed_at: string | null }>();
    expect(reopenedRow?.status).toBe("active");
    expect(reopenedRow?.closed_at).toBeNull();
  });

  // ─── Agent PATCH/DELETE ───

  it("PATCH /api/agents/:id returns 404 for nonexistent agent", async () => {
    const res = await apiRequest("PATCH", "/api/agents/nonexistent", { name: "X" }, userToken);
    expect(res.status).toBe(404);
  });

  it("DELETE /api/agents/:id deletes the agent", async () => {
    const tempAgent = await createTestAgent(env.DB, userTokenOwnerId, {
      name: "Temp Agent For Delete",
      username: "temp-agent-for-delete",
      runtime: "claude",
    });
    const res = await apiRequest("DELETE", `/api/agents/${tempAgent.id}`, undefined, userToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
  });

  it("DELETE /api/agents/:id deletes latest and all snapshots for the agent", async () => {
    const first = await createTestAgent(env.DB, userTokenOwnerId, {
      name: "Versioned Delete Agent",
      username: "versioned-delete-agent",
      runtime: "claude",
      soul: "first",
    });
    await createTestAgent(env.DB, userTokenOwnerId, {
      name: "Versioned Delete Agent",
      username: "versioned-delete-agent",
      runtime: "claude",
      soul: "second",
    });

    const res = await apiRequest("DELETE", `/api/agents/${first.id}`, undefined, userToken);

    expect(res.status).toBe(200);
    const remaining = await env.DB.prepare("SELECT id FROM agents WHERE username = ?").bind("versioned-delete-agent").all<any>();
    expect(remaining.results).toHaveLength(0);
  });

  it("DELETE /api/agents/:id rejects agent snapshots", async () => {
    await createTestAgent(env.DB, userTokenOwnerId, {
      name: "Snapshot Delete Agent",
      username: "snapshot-delete-agent",
      runtime: "claude",
      soul: "first",
    });
    await createTestAgent(env.DB, userTokenOwnerId, {
      name: "Snapshot Delete Agent",
      username: "snapshot-delete-agent",
      runtime: "claude",
      soul: "second",
    });
    const snapshot = await env.DB.prepare("SELECT id FROM agents WHERE username = ? AND version != 'latest'")
      .bind("snapshot-delete-agent")
      .first<any>();

    const res = await apiRequest("DELETE", `/api/agents/${snapshot.id}`, undefined, userToken);

    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("snapshots cannot be deleted directly");
  });

  it("DELETE /api/subagents/:id rejects referenced subagents", async () => {
    const referenced = await createTestSubagent(env.DB, userTokenOwnerId, {
      name: "Referenced Delete Subagent",
      username: "referenced-delete-subagent",
    });
    await createTestAgent(env.DB, userTokenOwnerId, {
      name: "Referencing Delete Agent",
      username: "referencing-delete-agent",
      runtime: "claude",
      subagents: [referenced.id],
    });

    const res = await apiRequest("DELETE", `/api/subagents/${referenced.id}`, undefined, userToken);
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("referenced by agent");
  });

  // ─── Task claim forbidden for machine identity ───

  it("POST /api/tasks/:id/claim returns 403 for machine identity", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Claim Task", board_id: boardId });
    const res = await apiRequest("POST", `/api/tasks/${task.id}/claim`, {}, apiKey);
    expect(res.status).toBe(403);
  });

  // ─── Agent JWT claim flow ───

  it("POST /api/tasks/:id/claim works with agent JWT", async () => {
    await apiRequest("POST", `/api/agents/${agentId}/sessions/${sessionId}/reopen`, {}, apiKey);

    const { createTask, assignTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, {
      title: "Agent Claim Task",
      board_id: boardId,
      metadata: { annotations: { "runtime.source": "legacy" } },
    });
    await assignTask(env.DB, task.id, agentId, "machine", "system");
    const jwt = await signSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/claim`, {}, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("in_progress");
  });

  it("POST /api/tasks/:id/claim enforces the authenticated session runtime source", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const createAssigned = (title: string, source: "ama" | "legacy") =>
      createTask(env.DB, userId, {
        title,
        board_id: boardId,
        assigned_to: agentId,
        metadata: { annotations: { "runtime.source": source } },
        skipRuntimeAvailability: true,
      });
    const legacyJwt = await signSessionJWT();
    const amaJwt = await signAmaSessionJWT();
    const amaForLegacy = await createAssigned("AMA task for legacy claim", "ama");
    const legacyForAma = await createAssigned("Legacy task for AMA claim", "legacy");
    const amaMatch = await createAssigned("AMA matching claim", "ama");

    const legacyMismatch = await apiRequest("POST", `/api/tasks/${amaForLegacy.id}/claim`, {}, legacyJwt);
    expect(legacyMismatch.status).toBe(409);
    await expect(legacyMismatch.json()).resolves.toMatchObject({ error: { message: "Task is routed to a different runtime source" } });

    const amaMismatch = await apiRequest("POST", `/api/tasks/${legacyForAma.id}/claim`, {}, amaJwt);
    expect(amaMismatch.status).toBe(409);
    await expect(amaMismatch.json()).resolves.toMatchObject({ error: { message: "Task is routed to a different runtime source" } });

    const matching = await apiRequest("POST", `/api/tasks/${amaMatch.id}/claim`, {}, amaJwt);
    expect(matching.status).toBe(200);
    await expect(matching.json()).resolves.toMatchObject({ id: amaMatch.id, status: "in_progress" });
  });

  it("POST /api/tasks/:id/review works with agent JWT", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Agent Review Task", board_id: boardId });
    await env.DB.prepare("UPDATE tasks SET status = 'in_progress', assigned_to = ? WHERE id = ?").bind(agentId, task.id).run();
    const jwt = await signSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/review`, {}, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("in_review");
  });

  // ─── Task assign with stale detection ───

  it("POST /api/tasks/:id/assign triggers stale detection", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Assign Stale Task", board_id: boardId });
    const leaderJwt = await signLeaderSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/assign`, { agent_id: agentId }, leaderJwt);
    expect(res.status).toBe(200);
  });
});
