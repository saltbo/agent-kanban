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

  it("creates, updates, lists, and deletes board maintainers through AMA triggers and memory stores", async () => {
    const previousAma = {
      AMA_ORIGIN: env.AMA_ORIGIN,
      AMA_OIDC_ISSUER: env.AMA_OIDC_ISSUER,
      AMA_OIDC_CLIENT_ID: env.AMA_OIDC_CLIENT_ID,
      AMA_OIDC_CLIENT_SECRET: env.AMA_OIDC_CLIENT_SECRET,
      AK_API_URL: env.AK_API_URL,
    };
    Object.assign(env, {
      AMA_ORIGIN: "https://ama.test",
      AMA_OIDC_ISSUER: "https://auth.test",
      AMA_OIDC_CLIENT_ID: "ak-app",
      AMA_OIDC_CLIENT_SECRET: "ak-secret",
      AK_API_URL: "https://ak.test",
    });
    await configureAmaOwnerRuntime(userTokenOwnerId, "codex", "env_123");

    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { recordBoardRepository } = await import("../apps/web/server/boardRepositoryRepo");
    const { createRepository } = await import("../apps/web/server/repositoryRepo");
    const maintainerBoard = await createBoard(env.DB, userTokenOwnerId, `maintainer-board-${crypto.randomUUID()}`, "dev");
    const maintainerRepository = await createRepository(env.DB, userTokenOwnerId, {
      name: `maintainer-repo-${crypto.randomUUID()}`,
      url: "https://github.com/maintainer-org/maintainer-repo",
    });
    await recordBoardRepository(env.DB, maintainerBoard.id, maintainerRepository.id);
    const maintainerAgent = await createTestAgent(env.DB, userTokenOwnerId, {
      name: "Daily maintainer",
      username: `daily-maintainer-${crypto.randomUUID()}`,
      runtime: "codex",
      kind: "worker",
      role: "board-maintainer",
      handoff_to: ["worker"],
      skills: ["saltbo/agent-kanban@agent-kanban"],
    });
    // The AMA agent is created eagerly at agent creation; the maintainer route
    // now reads the stored ama_agent_id and reconciles config (read + update).
    await setAgentAmaId(env.DB, maintainerAgent.id, "ama_agent_maintainer");
    const boardVaultRequests: any[] = [];
    const memoryStoreRequests: any[] = [];
    const memoryRequests: any[] = [];
    const sessionSecretRequests: any[] = [];
    const userVariableRequests: any[] = [];
    const userVariableUpdateRequests: any[] = [];
    let maintainerApiKey: string | null = null;
    let userVariablesCreated = false;
    const triggerRequests: any[] = [];
    const updateRequests: Array<{ triggerId: string; body: any }> = [];
    const archiveRequests: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = reqUrl(input);
      const method = reqMethod(input, init);
      if (url === "https://auth.test/.well-known/openid-configuration") {
        return jsonResponse({ access_token: "oauth-token" });
      }
      if (url === "https://ama.test/api/v1/projects/project_123") {
        return jsonResponse({ id: "project_123", name: "Workspace" });
      }
      if (url === "https://ama.test/api/v1/providers?limit=100") {
        return jsonResponse({ data: [{ id: "provider_codex", type: "openai", status: "active" }] });
      }
      if (url === "https://ama.test/api/v1/providers/provider_codex/models?limit=100") {
        return jsonResponse({ data: [{ modelId: "gpt-5.3-codex", availability: "available", metadata: { runtime: "codex" } }] });
      }
      if (url === "https://ama.test/api/v1/providers/provider_codex/models" && reqMethod(input, init) === "POST") {
        return jsonResponse({ ok: true });
      }
      // ensureAmaAgentForAkAgent reads the stored ama_agent_id then updates its
      // config (the AMA agent was created eagerly at agent creation).
      if (url === "https://ama.test/api/v1/agents/ama_agent_maintainer" && (reqMethod(input, init) ?? "GET") === "GET") {
        return jsonResponse(amaAgent("ama_agent_maintainer", { projectId: "project_123", provider: "openai", model: "gpt-5.3-codex" }));
      }
      if (url === "https://ama.test/api/v1/agents/ama_agent_maintainer" && reqMethod(input, init) === "PATCH") {
        const body = JSON.parse(await reqBody(input, init)) as Record<string, any>;
        expect(body.spec.skills).toEqual(["saltbo/agent-kanban@agent-kanban", "saltbo/agent-kanban@ak-maintainer"]);
        return jsonResponse(amaAgent("ama_agent_maintainer", { projectId: "project_123", provider: "openai", model: "gpt-5.3-codex" }));
      }
      if (url === "https://ama.test/api/v1/vaults" && method === "POST") {
        const body = JSON.parse(await reqBody(input, init)) as Record<string, any>;
        boardVaultRequests.push(body);
        expect(body.metadata).toEqual({
          name: `ak-boarder-${maintainerBoard.id}`,
          description: `Runtime variables for AK board ${maintainerBoard.id}.`,
        });
        expect(body.spec).toEqual({ scope: "project" });
        return jsonResponse(amaVault("vault_maintainer_board"), 201);
      }
      if (url === "https://ama.test/api/v1/vaults/vault_maintainer_board/credentials" && method === "POST") {
        const body = JSON.parse(await reqBody(input, init)) as Record<string, any>;
        if (body.name === "user-variables") {
          userVariableRequests.push(body);
          expect(body.type).toBe("opaque");
          expect(body.metadata).toEqual({
            boardId: maintainerBoard.id,
            maintainerId: expect.any(String),
          });
          expect(body.secret.referenceName).toBe("user-variables");
          expect(body.secret.stringData).toEqual({ GH_TOKEN: "ghp_secret", FEATURE_FLAG: "true" });
          userVariablesCreated = true;
          return jsonResponse(amaCredential("vaultcred_user_variables", "vaultver_user_variables"), 201);
        }
        sessionSecretRequests.push(body);
        expect(body.name).toBe("ak-variables");
        expect(body.type).toBe("opaque");
        expect(body.metadata).toEqual({
          boardId: maintainerBoard.id,
          maintainerId: expect.any(String),
          agentId: maintainerAgent.id,
        });
        expect(body.secret.referenceName).toBe("ak-variables");
        expect(body.secret.stringData.AK_API_KEY).toMatch(/^ak_maint_/);
        maintainerApiKey = body.secret.stringData.AK_API_KEY;
        return jsonResponse(amaCredential("vaultcred_maintainer", "vaultver_maintainer"), 201);
      }
      if (url === "https://ama.test/api/v1/vaults/vault_maintainer_board/credentials/vaultcred_user_variables" && method === "PUT") {
        const body = JSON.parse(await reqBody(input, init)) as Record<string, any>;
        userVariableUpdateRequests.push(body);
        expect(body.referenceName).toBe("user-variables");
        expect(body.stringData).toEqual({ GH_TOKEN: "ghp_rotated" });
        return jsonResponse(amaCredential("vaultcred_user_variables", "vaultver_user_variables_2"), 200);
      }
      if (url === "https://ama.test/api/v1/vaults/vault_maintainer_board/credentials?limit=100" && method === "GET") {
        return jsonResponse({
          data: [
            amaCredentialListItem("vaultcred_maintainer", "ak-variables", ["AK_API_KEY"]),
            ...(userVariablesCreated ? [amaCredentialListItem("vaultcred_user_variables", "user-variables", ["FEATURE_FLAG", "GH_TOKEN"])] : []),
          ],
        });
      }
      if (url === "https://ama.test/api/v1/memory-stores" && method === "POST") {
        const body = JSON.parse(await reqBody(input, init)) as Record<string, any>;
        memoryStoreRequests.push(body);
        expect(body.metadata.name).toBe(`ak-boarder-${maintainerBoard.id}`);
        return jsonResponse(amaMemoryStore("mem_maintainer", body.metadata.name), 201);
      }
      if (url === "https://ama.test/api/v1/memory-stores/mem_maintainer/memories" && method === "POST") {
        const body = JSON.parse(await reqBody(input, init)) as Record<string, any>;
        memoryRequests.push(body);
        return jsonResponse({ id: "memory_unexpected", ...body }, 201);
      }
      if (url === "https://ama.test/api/v1/triggers" && method === "POST") {
        const body = JSON.parse(await reqBody(input, init)) as Record<string, any>;
        triggerRequests.push(body);
        const template = body.spec.template;
        const spec = template.spec;
        const labels = template.metadata.labels;
        expect(body.metadata.name).toBe(
          body.spec.source.type === "http" ? `ak-boarder-${maintainerBoard.id}-http` : `ak-boarder-${maintainerBoard.id}-schedule`,
        );
        expect(labels).toEqual({ maintainerId: expect.any(String) });
        expect(template.metadata.annotations).toEqual({
          [AMA_ANNOTATION_KEY_IDLE_TIMEOUT_SECONDS]: String(MAINTAINER_SESSION_IDLE_TIMEOUT_SECONDS),
        });
        expect(spec.agentId).toBe("ama_agent_maintainer");
        expect(spec.skills).toBeUndefined();
        expect(spec.environmentId).toBeUndefined();
        expect(spec.volumes).toEqual([{ name: "memory", type: "memory", memoryRef: "ama://memories/mem_maintainer" }]);
        expect(spec.volumeMounts).toEqual([{ name: "memory", mountPath: "/workspace/.ama/memory-stores/mem_maintainer", readOnly: false }]);
        expect(spec.env).toMatchObject({
          AK_WORKER: "1",
          AK_BOARD_ID: maintainerBoard.id,
          AK_MAINTAINER_ID: labels.maintainerId,
          AK_API_URL: "https://ak.test",
        });
        expect(spec.env).not.toHaveProperty("AK_BOARD_REPOSITORIES");
        expect(spec.env.AK_AGENT_ID).toBe(maintainerAgent.id);
        expect(spec.env).not.toHaveProperty("AK_REPOSITORY_ID");
        expect(spec.env).not.toHaveProperty("AK_REPOSITORY_FULL_NAME");
        expect(spec.env).not.toHaveProperty("AK_SESSION_ID");
        expect(spec.env).not.toHaveProperty("AK_AGENT_KEY");
        expect(spec.env).not.toHaveProperty("GH_CONFIG_DIR");
        expect(spec.envFrom).toEqual([
          {
            type: "secret",
            secretRef: amaCredentialSecretRef("vault_maintainer_board", "vaultcred_maintainer"),
          },
        ]);
        expect(spec.promptTemplate).not.toContain("maintainer-org/maintainer-repo");
        expect(spec.promptTemplate).not.toContain("Maintainer instructions:");
        expect(spec.promptTemplate).not.toContain("Do not use pre-existing gh login state or human GitHub tokens");
        if (body.spec.source.type === "http") {
          expect(body.metadata.name).toBe(`ak-boarder-${maintainerBoard.id}-http`);
          expect(body.spec.source).toEqual({ type: "http", concurrency: { mode: "serial" } });
          expect(spec.promptTemplate).toContain("{% if .ama.run.session_reused == false %}");
          expect(spec.promptTemplate).toContain("# AK Maintainer GitHub Event");
          expect(spec.promptTemplate).toContain("# GitHub Event");
          expect(spec.promptTemplate).toContain("## Event");
          expect(spec.promptTemplate).toContain("{{ .body.event }}.{{ .body.action }}");
          expect(spec.promptTemplate).toContain("{{ .body.repository.full_name }}");
          expect(spec.promptTemplate).toContain('{% if .body.subject.type == "issue" %}');
          expect(spec.promptTemplate).toContain('{% if .body.subject.type == "pull_request" %}');
          expect(spec.promptTemplate).toContain("{% if .body.comment.id %}");
          expect(spec.promptTemplate).toContain("{% if .body.review.id %}");
          expect(spec.promptTemplate).not.toContain("{{ .subject.id }}");
          expect(spec.promptTemplate).not.toContain("{{ .subject.node_id }}");
          expect(spec.promptTemplate).toContain("{{ .body.subject.number }}");
          expect(spec.promptTemplate).toContain("{{ .body.comment.id }}");
          expect(spec.promptTemplate).toContain("{{ .body.comment.node_id }}");
          expect(spec.promptTemplate).toContain("{{ .body.review.id }}");
          expect(spec.promptTemplate).toContain("{{ .body.review.node_id }}");
          expect(spec.promptTemplate).not.toContain("{{ .body.subject.title }}");
          expect(spec.promptTemplate).not.toContain("{{ .body.subject.body }}");
          expect(spec.promptTemplate).not.toContain("{{ .body.comment.body }}");
          expect(spec.promptTemplate).not.toContain("{{ .body.review.body }}");
          expect(spec.promptTemplate).not.toContain("event_context_json");
          return jsonResponse(amaTrigger("http_maintainer", body, { type: "http" }), 201);
        }
        expect(spec.promptTemplate).toContain(`AK board ${maintainerBoard.id}`);
        expect(spec.promptTemplate).toContain(`Discover the current repository scope with AK`);
        expect(spec.promptTemplate).toContain(`Every repository currently attached to board ${maintainerBoard.id} is in your maintenance scope.`);
        expect(spec.promptTemplate).toContain("saltbo/agent-kanban@ak-maintainer");
        expect(body.spec.source).toEqual({ type: "schedule", schedule: { type: "interval", intervalSeconds: 3600 } });
        return jsonResponse(amaTrigger("sched_maintainer", body, { type: "schedule", intervalSeconds: 3600 }), 201);
      }
      if (
        (url === "https://ama.test/api/v1/triggers/sched_maintainer" || url === "https://ama.test/api/v1/triggers/http_maintainer") &&
        method === "DELETE"
      ) {
        archiveRequests.push(url);
        return new Response(null, { status: 204 });
      }
      if (url === "https://ama.test/api/v1/memory-stores/mem_maintainer" && method === "PATCH") {
        const body = JSON.parse(await reqBody(input, init)) as Record<string, any>;
        archiveRequests.push(url);
        expect(body).toEqual({ archived: true });
        return jsonResponse(amaMemoryStore("mem_maintainer", "memory"), 200);
      }
      if (
        (url === "https://ama.test/api/v1/triggers/sched_maintainer" || url === "https://ama.test/api/v1/triggers/http_maintainer") &&
        method === "PATCH"
      ) {
        const body = JSON.parse(await reqBody(input, init)) as Record<string, any>;
        const triggerId = url.endsWith("/http_maintainer") ? "http_maintainer" : "sched_maintainer";
        updateRequests.push({ triggerId, body });
        if (body.spec?.template?.metadata) {
          expect(body.spec.template.metadata.labels).toEqual({ maintainerId: expect.any(String) });
          expect(body.spec.template.metadata.annotations).toEqual({
            [AMA_ANNOTATION_KEY_IDLE_TIMEOUT_SECONDS]: String(MAINTAINER_SESSION_IDLE_TIMEOUT_SECONDS),
          });
        }
        return jsonResponse(
          amaTrigger(triggerId, body, {
            type: triggerId === "sched_maintainer" ? "schedule" : "http",
            intervalSeconds: body.spec?.source?.schedule?.intervalSeconds ?? 3600,
            active: body.spec?.suspend !== true,
          }),
        );
      }
      if (url.startsWith("https://ama.test/api/v1/triggers/sched_maintainer/runs?")) {
        const limit = Number(new URL(url).searchParams.get("limit") ?? 20);
        return jsonResponse({
          data: [
            amaTriggerRun({
              id: "run_maintainer_1",
              triggerId: "sched_maintainer",
              scheduledFor: "2026-06-08T12:00:00.000Z",
              heartbeatAt: "2026-06-08T12:00:03.000Z",
              triggeredAt: "2026-06-08T12:00:00.000Z",
              phase: "completed",
              sessionId: "session_maintainer_1",
              errorMessage: null,
              metadata: { attempt: 1 },
              createdAt: "2026-06-08T12:00:00.000Z",
              updatedAt: "2026-06-08T12:00:04.000Z",
            }),
          ],
          pagination: { limit, hasMore: false },
        });
      }
      if (url.startsWith("https://ama.test/api/v1/triggers/http_maintainer/runs?")) {
        const limit = Number(new URL(url).searchParams.get("limit") ?? 20);
        return jsonResponse({
          data: [
            amaTriggerRun({
              id: "run_maintainer_http_1",
              triggerId: "http_maintainer",
              scheduledFor: null,
              heartbeatAt: null,
              triggeredAt: "2026-06-08T12:10:00.000Z",
              phase: "dispatched",
              sessionId: "session_maintainer_http_1",
              errorMessage: null,
              metadata: {
                labels: { [AK_LABEL_KEY_GITHUB_SUBJECT]: "github:maintainer-org/maintainer-repo:issue:42" },
                annotations: { [AK_ANNOTATION_KEY_SOURCE_EVENT]: "issues.opened" },
              },
              createdAt: "2026-06-08T12:09:59.000Z",
              updatedAt: "2026-06-08T12:10:00.000Z",
            }),
            amaTriggerRun({
              id: "run_maintainer_http_queued",
              triggerId: "http_maintainer",
              scheduledFor: null,
              heartbeatAt: null,
              triggeredAt: "2026-06-08T12:09:00.000Z",
              phase: "queued",
              sessionId: null,
              errorMessage: null,
              metadata: {
                labels: { [AK_LABEL_KEY_GITHUB_SUBJECT]: "github:maintainer-org/maintainer-repo:issue:43" },
                annotations: { [AK_ANNOTATION_KEY_SOURCE_EVENT]: "issues.opened" },
              },
              createdAt: "2026-06-08T12:09:00.000Z",
              updatedAt: "2026-06-08T12:09:00.000Z",
            }),
            amaTriggerRun({
              id: "run_maintainer_http_dispatching",
              triggerId: "http_maintainer",
              scheduledFor: null,
              heartbeatAt: null,
              triggeredAt: "2026-06-08T12:08:00.000Z",
              phase: "dispatching",
              sessionId: null,
              errorMessage: null,
              metadata: {
                labels: { [AK_LABEL_KEY_GITHUB_SUBJECT]: "github:maintainer-org/maintainer-repo:issue:44" },
                annotations: { [AK_ANNOTATION_KEY_SOURCE_EVENT]: "issues.opened" },
              },
              createdAt: "2026-06-08T12:08:00.000Z",
              updatedAt: "2026-06-08T12:08:00.000Z",
            }),
          ],
          pagination: { limit, hasMore: false },
        });
      }
      if (url.startsWith("https://ama.test/api/v1/memory-stores/mem_maintainer/memories?") && method === "GET") {
        const requestUrl = new URL(url);
        const limit = Number(requestUrl.searchParams.get("limit") ?? 100);
        return jsonResponse({
          data: [
            amaMemory({
              id: "memory_heartbeat",
              storeId: "mem_maintainer",
              projectId: "project_123",
              path: "HEARTBEAT.md",
              content: "# Maintainer Scheduled Heartbeat\n\nReview open work.",
              metadata: { purpose: "ak-board-maintainer-heartbeat", boardId: maintainerBoard.id },
              createdAt: "2026-06-08T11:00:00.000Z",
              updatedAt: "2026-06-08T11:30:00.000Z",
            }),
            amaMemory({
              id: "memory_notes",
              storeId: "mem_maintainer",
              projectId: "project_123",
              path: "notes/2026-06-08.md",
              content: "Follow up on stale issues.",
              metadata: { purpose: "ak-board-maintainer-note" },
              createdAt: "2026-06-08T11:10:00.000Z",
              updatedAt: "2026-06-08T11:40:00.000Z",
            }),
          ],
          pagination: { limit, hasMore: false },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const invalidRes = await apiRequest(
        "POST",
        `/api/boards/${maintainerBoard.id}/maintainers`,
        {
          agent_id: maintainerAgent.id,
          interval_seconds: 3599,
        },
        userToken,
      );
      expect(invalidRes.status).toBe(400);
      await expect(invalidRes.json()).resolves.toMatchObject({ error: { message: "interval_seconds must be an integer >= 3600" } });

      const ordinaryAgent = await createTestAgent(env.DB, userTokenOwnerId, {
        name: "Ordinary worker",
        username: `ordinary-worker-${crypto.randomUUID()}`,
        runtime: "codex",
        kind: "worker",
        role: "implementation",
      });
      await setAgentAmaId(env.DB, ordinaryAgent.id, "ama_agent_ordinary");
      const nonMaintainerAgentRes = await apiRequest(
        "POST",
        `/api/boards/${maintainerBoard.id}/maintainers`,
        {
          agent_id: ordinaryAgent.id,
          interval_seconds: 3600,
        },
        userToken,
      );
      expect(nonMaintainerAgentRes.status).toBe(400);
      await expect(nonMaintainerAgentRes.json()).resolves.toMatchObject({ error: { message: "Board maintainers must use a maintainer agent" } });

      const createRes = await apiRequest(
        "POST",
        `/api/boards/${maintainerBoard.id}/maintainers`,
        {
          agent_id: maintainerAgent.id,
          interval_seconds: 3600,
        },
        userToken,
      );
      expect(createRes.status).toBe(201);
      const maintainer = (await createRes.json()) as any;
      expect(maintainer).toMatchObject({
        board_id: maintainerBoard.id,
        agent_id: maintainerAgent.id,
        status: "active",
        heartbeat_enabled: true,
      });
      expect(maintainer).not.toHaveProperty("repository_id");
      expect(maintainer).not.toHaveProperty("ama_schedule_id");
      expect(maintainer).not.toHaveProperty("last_ama_session_id");
      expect(maintainer).not.toHaveProperty("ama_board_vault_id");
      expect(maintainer).not.toHaveProperty("api_key_id");
      expect(maintainer).not.toHaveProperty("api_key_credential_id");
      expect(maintainer).not.toHaveProperty("api_key_credential_version_id");
      expect(maintainer).not.toHaveProperty("name");
      const updatedMaintainerAgent = await env.DB.prepare("SELECT skills, taints FROM agents WHERE id = ?").bind(maintainerAgent.id).first<{
        skills: string;
        taints: string;
      }>();
      expect(JSON.parse(updatedMaintainerAgent!.skills)).toEqual(["saltbo/agent-kanban@agent-kanban", "saltbo/agent-kanban@ak-maintainer"]);
      expect(JSON.parse(updatedMaintainerAgent!.taints)).toContainEqual({
        key: "agent-kanban.dev/maintainer",
        value: "board-maintainer",
        effect: "NoSchedule",
      });
      expect(maintainer).toMatchObject({
        last_run_at: "2026-06-08T12:10:00.000Z",
        last_session_id: "session_maintainer_http_1",
        latest_run: {
          id: "run_maintainer_http_1",
          scheduled_for: null,
          heartbeat_at: null,
          triggered_at: "2026-06-08T12:10:00.000Z",
          status: "dispatched",
          session_id: "session_maintainer_http_1",
          error_message: null,
          metadata: {
            labels: { [AK_LABEL_KEY_GITHUB_SUBJECT]: "github:maintainer-org/maintainer-repo:issue:42" },
            annotations: { [AK_ANNOTATION_KEY_SOURCE_EVENT]: "issues.opened" },
          },
        },
      });
      expect(maintainer.latest_run).not.toHaveProperty("sessionId");
      expect(maintainer.latest_run).not.toHaveProperty("scheduledFor");
      expect(boardVaultRequests).toHaveLength(1);
      expect(memoryStoreRequests).toHaveLength(1);
      expect(memoryRequests).toHaveLength(0);
      expect(sessionSecretRequests).toHaveLength(1);
      expect(userVariableRequests).toHaveLength(0);
      expect(triggerRequests).toHaveLength(2);
      expect(triggerRequests.map((request) => request.spec.source.type).sort()).toEqual(["http", "schedule"]);
      expect(triggerRequests[0].spec.template.metadata.labels).toEqual({ maintainerId: maintainer.id });
      expect(triggerRequests[1].spec.template.metadata.labels).toEqual(triggerRequests[0].spec.template.metadata.labels);
      expect(triggerRequests[0].spec.template.metadata.annotations).toEqual({
        [AMA_ANNOTATION_KEY_IDLE_TIMEOUT_SECONDS]: String(MAINTAINER_SESSION_IDLE_TIMEOUT_SECONDS),
      });
      expect(triggerRequests[1].spec.template.metadata.annotations).toEqual(triggerRequests[0].spec.template.metadata.annotations);
      expect(triggerRequests[0].spec.template.spec.env).toMatchObject({
        AK_AGENT_ID: maintainerAgent.id,
        AK_BOARD_ID: maintainerBoard.id,
        AK_MAINTAINER_ID: maintainer.id,
      });
      expect(triggerRequests[0].spec.template.spec.env).not.toHaveProperty("AK_SESSION_ID");
      expect(triggerRequests[1].spec.template.spec.env).not.toHaveProperty("AK_SESSION_ID");
      expect(triggerRequests[0].spec.template.spec.envFrom).toEqual(triggerRequests[1].spec.template.spec.envFrom);

      const duplicateRes = await apiRequest(
        "POST",
        `/api/boards/${maintainerBoard.id}/maintainers`,
        {
          agent_id: maintainerAgent.id,
          interval_seconds: 3600,
        },
        userToken,
      );
      expect(duplicateRes.status).toBe(409);
      await expect(duplicateRes.json()).resolves.toMatchObject({ error: { message: "Board already has a maintainer" } });
      expect(memoryStoreRequests).toHaveLength(1);
      expect(memoryRequests).toHaveLength(0);
      expect(triggerRequests).toHaveLength(2);

      const sessionBeforeLogin = await env.DB.prepare("SELECT COUNT(*) AS count FROM ama_agent_sessions WHERE agent_id = ? AND owner_id = ?")
        .bind(maintainerAgent.id, userTokenOwnerId)
        .first<{ count: number }>();
      expect(sessionBeforeLogin?.count).toBe(0);
      const maintainerRow = await env.DB.prepare(
        "SELECT ama_schedule_id, ama_http_trigger_id, ama_http_trigger_serialized, ama_memory_store_id, ama_board_vault_id, heartbeat_enabled, api_key_id FROM board_maintainers WHERE id = ?",
      )
        .bind(maintainer.id)
        .first<{
          ama_schedule_id: string;
          ama_http_trigger_id: string;
          ama_http_trigger_serialized: number;
          ama_memory_store_id: string;
          ama_board_vault_id: string;
          heartbeat_enabled: number;
          api_key_id: string;
        }>();
      expect(maintainerRow).toMatchObject({
        ama_schedule_id: "sched_maintainer",
        ama_http_trigger_id: "http_maintainer",
        ama_http_trigger_serialized: 1,
        ama_memory_store_id: "mem_maintainer",
        ama_board_vault_id: "vault_maintainer_board",
        heartbeat_enabled: 1,
        api_key_id: expect.any(String),
      });
      expect(maintainerApiKey).toEqual(expect.any(String));

      const variablesBeforeRes = await apiRequest(
        "GET",
        `/api/boards/${maintainerBoard.id}/maintainers/${maintainer.id}/variables`,
        undefined,
        userToken,
      );
      expect(variablesBeforeRes.status).toBe(200);
      await expect(variablesBeforeRes.json()).resolves.toMatchObject({ data: [], credential_id: null, updated_at: null });

      const emptyVariablesRes = await apiRequest(
        "PUT",
        `/api/boards/${maintainerBoard.id}/maintainers/${maintainer.id}/variables`,
        { variables: {} },
        userToken,
      );
      expect(emptyVariablesRes.status).toBe(400);
      await expect(emptyVariablesRes.json()).resolves.toMatchObject({ error: { message: "variables must contain at least one key" } });

      const variablesRes = await apiRequest(
        "PUT",
        `/api/boards/${maintainerBoard.id}/maintainers/${maintainer.id}/variables`,
        { variables: { GH_TOKEN: "ghp_secret", FEATURE_FLAG: "true" } },
        userToken,
      );
      expect(variablesRes.status).toBe(200);
      await expect(variablesRes.json()).resolves.toMatchObject({
        data: [{ name: "FEATURE_FLAG" }, { name: "GH_TOKEN" }],
        credential_id: "vaultcred_user_variables",
      });
      expect(userVariableRequests).toHaveLength(1);
      const variableSyncRequests = updateRequests.slice(-2);
      expect(variableSyncRequests.map((request) => request.triggerId).sort()).toEqual(["http_maintainer", "sched_maintainer"]);
      for (const request of variableSyncRequests) {
        expect(request.body.spec.template.spec.envFrom).toEqual([
          {
            type: "secret",
            secretRef: amaCredentialSecretRef("vault_maintainer_board", "vaultcred_maintainer"),
          },
          {
            type: "secret",
            secretRef: amaCredentialSecretRef("vault_maintainer_board", "vaultcred_user_variables"),
          },
        ]);
      }
      expect(fetchMock.mock.calls.map(([request]) => reqUrl(request as RequestInfo | URL)).some((url) => url.includes("/api/v1/sessions"))).toBe(
        false,
      );

      const updateRequestCountAfterFirstVariablesSave = updateRequests.length;
      const rotatedVariablesRes = await apiRequest(
        "PUT",
        `/api/boards/${maintainerBoard.id}/maintainers/${maintainer.id}/variables`,
        { variables: { GH_TOKEN: "ghp_rotated" } },
        userToken,
      );
      expect(rotatedVariablesRes.status).toBe(200);
      expect(userVariableUpdateRequests).toHaveLength(1);
      expect(updateRequests).toHaveLength(updateRequestCountAfterFirstVariablesSave);

      const { publicKey } = (await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"])) as CryptoKeyPair;
      const pubJwk = await crypto.subtle.exportKey("jwk", publicKey);
      const maintainerSessionId = crypto.randomUUID();
      const sessionRes = await apiRequest(
        "POST",
        `/api/boards/${maintainerBoard.id}/maintainers/${maintainer.id}/sessions`,
        { session_id: maintainerSessionId, session_public_key: pubJwk.x, ama_session_id: "ama_maintainer_session_1" },
        maintainerApiKey!,
      );
      expect(sessionRes.status).toBe(201);
      await expect(sessionRes.json()).resolves.toMatchObject({
        agent_id: maintainerAgent.id,
        session_id: maintainerSessionId,
        delegation_proof: expect.any(String),
      });
      const maintainerSession = await env.DB.prepare(
        "SELECT agent_id, ama_session_id, status, secret_ref FROM ama_agent_sessions WHERE id = ? AND owner_id = ?",
      )
        .bind(maintainerSessionId, userTokenOwnerId)
        .first<{ agent_id: string; ama_session_id: string; status: string; secret_ref: string | null }>();
      expect(maintainerSession).toEqual({
        agent_id: maintainerAgent.id,
        ama_session_id: "ama_maintainer_session_1",
        status: "active",
        secret_ref: null,
      });
      const maintainerKeyBoardsRes = await apiRequest("GET", "/api/boards", undefined, maintainerApiKey!);
      expect(maintainerKeyBoardsRes.status).toBe(403);

      const listRes = await apiRequest("GET", `/api/boards/${maintainerBoard.id}/maintainers`, undefined, userToken);
      expect(listRes.status).toBe(200);
      await expect(listRes.json()).resolves.toEqual([
        expect.objectContaining({
          id: maintainer.id,
          last_run_at: "2026-06-08T12:10:00.000Z",
          last_session_id: "session_maintainer_http_1",
          heartbeat_enabled: true,
        }),
      ]);

      const detailRes = await apiRequest("GET", `/api/boards/${maintainerBoard.id}/maintainers/${maintainer.id}`, undefined, userToken);
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as any;
      expect(detail).toEqual(
        expect.objectContaining({
          id: maintainer.id,
          last_run_at: "2026-06-08T12:10:00.000Z",
          last_session_id: "session_maintainer_http_1",
          heartbeat_enabled: true,
        }),
      );
      expect(detail).not.toHaveProperty("ama_schedule_id");
      expect(detail).not.toHaveProperty("ama_http_trigger_id");
      expect(detail).not.toHaveProperty("ama_memory_store_id");
      expect(detail).not.toHaveProperty("ama_board_vault_id");
      expect(detail).not.toHaveProperty("api_key_id");
      expect(detail).not.toHaveProperty("api_key_credential_id");
      expect(detail).not.toHaveProperty("api_key_credential_version_id");

      const pauseRes = await apiRequest("PATCH", `/api/boards/${maintainerBoard.id}/maintainers/${maintainer.id}`, { status: "paused" }, userToken);
      expect(pauseRes.status).toBe(200);
      await expect(pauseRes.json()).resolves.toEqual(expect.objectContaining({ id: maintainer.id, status: "paused" }));
      for (const request of updateRequests.slice(-2)) {
        expect(request.body).toMatchObject({
          spec: {
            suspend: true,
            template: {
              metadata: { labels: { maintainerId: maintainer.id } },
              spec: {
                agentId: "ama_agent_maintainer",
                runtime: "codex",
                volumes: [{ name: "memory", type: "memory", memoryRef: "ama://memories/mem_maintainer" }],
                volumeMounts: [{ name: "memory", mountPath: "/workspace/.ama/memory-stores/mem_maintainer", readOnly: false }],
                env: {
                  AK_WORKER: "1",
                  AK_AGENT_ID: maintainerAgent.id,
                  AK_BOARD_ID: maintainerBoard.id,
                  AK_MAINTAINER_ID: maintainer.id,
                  AK_API_URL: "https://ak.test",
                },
                envFrom: [
                  {
                    type: "secret",
                    secretRef: amaCredentialSecretRef("vault_maintainer_board", "vaultcred_maintainer"),
                  },
                  {
                    type: "secret",
                    secretRef: amaCredentialSecretRef("vault_maintainer_board", "vaultcred_user_variables"),
                  },
                ],
              },
            },
          },
        });
        expect(request.body.spec.template.spec.env).toMatchObject({
          AK_WORKER: "1",
          AK_AGENT_ID: maintainerAgent.id,
          AK_BOARD_ID: maintainerBoard.id,
          AK_MAINTAINER_ID: maintainer.id,
          AK_API_URL: "https://ak.test",
        });
        expect(request.body.spec.template.spec.env).not.toHaveProperty("GH_CONFIG_DIR");
        expect(request.body.spec.template.spec.env).not.toHaveProperty("AK_SESSION_ID");
        expect(request.body.spec.template.spec.env).not.toHaveProperty("AK_AGENT_KEY");
        expect(request.body.spec.template.spec.env).not.toHaveProperty("AK_BOARD_REPOSITORIES");
      }
      expect(updateRequests.slice(-2).find((request) => request.triggerId === "http_maintainer")?.body.spec.source).toEqual({
        type: "http",
        concurrency: { mode: "serial" },
      });

      const heartbeatOffRes = await apiRequest(
        "PATCH",
        `/api/boards/${maintainerBoard.id}/maintainers/${maintainer.id}`,
        { status: "active", heartbeat_enabled: false },
        userToken,
      );
      expect(heartbeatOffRes.status).toBe(200);
      await expect(heartbeatOffRes.json()).resolves.toEqual(
        expect.objectContaining({ id: maintainer.id, status: "active", heartbeat_enabled: false }),
      );
      const heartbeatOffRequests = updateRequests.slice(-2);
      expect(heartbeatOffRequests.find((request) => request.triggerId === "sched_maintainer")?.body.spec.suspend).toBe(true);
      expect(heartbeatOffRequests.find((request) => request.triggerId === "http_maintainer")?.body.spec.suspend).toBe(false);

      const heartbeatOnRes = await apiRequest(
        "PATCH",
        `/api/boards/${maintainerBoard.id}/maintainers/${maintainer.id}`,
        { heartbeat_enabled: true },
        userToken,
      );
      expect(heartbeatOnRes.status).toBe(200);
      await expect(heartbeatOnRes.json()).resolves.toEqual(expect.objectContaining({ id: maintainer.id, status: "active", heartbeat_enabled: true }));
      const heartbeatOnRequests = updateRequests.slice(-2);
      expect(heartbeatOnRequests).toHaveLength(2);
      expect(heartbeatOnRequests.find((request) => request.triggerId === "sched_maintainer")).toMatchObject({
        body: { spec: { suspend: false } },
      });
      expect(heartbeatOnRequests.find((request) => request.triggerId === "http_maintainer")?.body.spec?.template?.spec?.promptTemplate).toContain(
        "# GitHub Event",
      );

      const updateRes = await apiRequest(
        "PATCH",
        `/api/boards/${maintainerBoard.id}/maintainers/${maintainer.id}`,
        { interval_seconds: 7200 },
        userToken,
      );
      expect(updateRes.status).toBe(200);
      await expect(updateRes.json()).resolves.toEqual(expect.objectContaining({ interval_seconds: 7200 }));
      expect(
        updateRequests.find((request) => request.triggerId === "sched_maintainer" && request.body.spec?.source?.schedule?.intervalSeconds === 7200)
          ?.body,
      ).toMatchObject({
        spec: { source: { type: "schedule", schedule: { type: "interval", intervalSeconds: 7200 } } },
      });
      expect(
        updateRequests.find((request) => request.triggerId === "sched_maintainer" && request.body.spec?.source?.schedule?.intervalSeconds === 7200)
          ?.body.spec?.template?.spec?.skills,
      ).toBeUndefined();
      expect(
        updateRequests.find((request) => request.triggerId === "sched_maintainer" && request.body.spec?.source?.schedule?.intervalSeconds === 7200)
          ?.body.spec?.template?.spec?.promptTemplate,
      ).toContain(`AK board ${maintainerBoard.id}`);
      expect(
        updateRequests.find(
          (request) =>
            request.triggerId === "http_maintainer" && request.body.spec?.template?.spec?.promptTemplate?.includes("{{ .body.comment.id }}"),
        )?.body.name,
      ).toBeUndefined();
      expect(
        updateRequests.find(
          (request) =>
            request.triggerId === "http_maintainer" && request.body.spec?.template?.spec?.promptTemplate?.includes("{{ .body.comment.id }}"),
        )?.body.skills,
      ).toBeUndefined();
      expect(
        updateRequests.find(
          (request) =>
            request.triggerId === "http_maintainer" && request.body.spec?.template?.spec?.promptTemplate?.includes("{{ .body.comment.id }}"),
        )?.body.spec?.template?.spec?.promptTemplate,
      ).toContain("# GitHub Event");

      const runsRes = await apiRequest("GET", `/api/boards/${maintainerBoard.id}/maintainers/${maintainer.id}/runs?limit=4`, undefined, userToken);
      expect(runsRes.status).toBe(200);
      const runs = (await runsRes.json()) as any;
      expect(runs).toEqual({
        data: [
          expect.objectContaining({
            id: "run_maintainer_http_1",
            scheduled_for: null,
            heartbeat_at: null,
            triggered_at: "2026-06-08T12:10:00.000Z",
            status: "dispatched",
            session_id: "session_maintainer_http_1",
            error_message: null,
            metadata: {
              labels: { [AK_LABEL_KEY_GITHUB_SUBJECT]: "github:maintainer-org/maintainer-repo:issue:42" },
              annotations: { [AK_ANNOTATION_KEY_SOURCE_EVENT]: "issues.opened" },
            },
          }),
          expect.objectContaining({
            id: "run_maintainer_http_queued",
            scheduled_for: null,
            heartbeat_at: null,
            triggered_at: "2026-06-08T12:09:00.000Z",
            status: "queued",
            session_id: null,
            error_message: null,
          }),
          expect.objectContaining({
            id: "run_maintainer_http_dispatching",
            scheduled_for: null,
            heartbeat_at: null,
            triggered_at: "2026-06-08T12:08:00.000Z",
            status: "dispatching",
            session_id: null,
            error_message: null,
          }),
          expect.objectContaining({
            id: "run_maintainer_1",
            scheduled_for: "2026-06-08T12:00:00.000Z",
            heartbeat_at: "2026-06-08T12:00:03.000Z",
            triggered_at: expect.any(String),
            status: "completed",
            session_id: "session_maintainer_1",
            error_message: null,
            metadata: { attempt: 1 },
          }),
        ],
        pagination: { limit: 4, hasMore: false },
      });
      expect(runs.data[0]).not.toHaveProperty("projectId");
      expect(runs.data[0]).not.toHaveProperty("triggerId");
      expect(runs.data[0]).not.toHaveProperty("sessionId");
      expect(runs.data[0]).not.toHaveProperty("scheduledFor");

      const memoriesRes = await apiRequest(
        "GET",
        `/api/boards/${maintainerBoard.id}/maintainers/${maintainer.id}/memories?limit=2`,
        undefined,
        userToken,
      );
      expect(memoriesRes.status).toBe(200);
      const memories = (await memoriesRes.json()) as any;
      expect(memories).toEqual({
        data: [
          {
            id: "memory_heartbeat",
            path: "HEARTBEAT.md",
            content: "# Maintainer Scheduled Heartbeat\n\nReview open work.",
            metadata: { purpose: "ak-board-maintainer-heartbeat", boardId: maintainerBoard.id },
            created_at: "2026-06-08T11:00:00.000Z",
            updated_at: "2026-06-08T11:30:00.000Z",
          },
          {
            id: "memory_notes",
            path: "notes/2026-06-08.md",
            content: "Follow up on stale issues.",
            metadata: { purpose: "ak-board-maintainer-note" },
            created_at: "2026-06-08T11:10:00.000Z",
            updated_at: "2026-06-08T11:40:00.000Z",
          },
        ],
        pagination: { limit: 2, hasMore: false },
      });
      expect(memories.data[0]).not.toHaveProperty("storeId");
      expect(memories.data[0]).not.toHaveProperty("projectId");

      const archiveRes = await apiRequest("DELETE", `/api/boards/${maintainerBoard.id}/maintainers/${maintainer.id}`, undefined, userToken);
      expect(archiveRes.status).toBe(200);
      await expect(archiveRes.json()).resolves.toEqual({ ok: true });
      expect(archiveRequests).toEqual([
        "https://ama.test/api/v1/triggers/sched_maintainer",
        "https://ama.test/api/v1/triggers/http_maintainer",
        "https://ama.test/api/v1/memory-stores/mem_maintainer",
      ]);
      // The maintainer row is hard-deleted.
      const goneRes = await apiRequest("GET", `/api/boards/${maintainerBoard.id}/maintainers`, undefined, userToken);
      const remaining = (await goneRes.json()) as Array<{ id: string }>;
      expect(remaining.find((m) => m.id === maintainer.id)).toBeUndefined();
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it("PATCH /api/boards/:id/maintainers/:maintainerId sends x-ama-project-id header to AMA", async () => {
    const amaProjectId = "project_patch_test";
    const previousAma = {
      AMA_ORIGIN: env.AMA_ORIGIN,
      AMA_OIDC_ISSUER: env.AMA_OIDC_ISSUER,
      AMA_OIDC_CLIENT_ID: env.AMA_OIDC_CLIENT_ID,
      AMA_OIDC_CLIENT_SECRET: env.AMA_OIDC_CLIENT_SECRET,
      AK_API_URL: env.AK_API_URL,
    };
    Object.assign(env, {
      AMA_ORIGIN: "https://ama.test",
      AMA_OIDC_ISSUER: "https://auth.test",
      AMA_OIDC_CLIENT_ID: "ak-app",
      AMA_OIDC_CLIENT_SECRET: "ak-secret",
      AK_API_URL: "https://ak.test",
    });
    const { createAuth } = await import("../apps/web/server/betterAuth");
    const auth = createAuth(env);
    const patchUser = await signUpVerifiedUser(env.DB, auth, {
      name: "Patch Header User",
      email: "patch-header@test.com",
      password: "test-password-123",
    });
    const patchOwnerId = patchUser.user.id;
    const patchToken = patchUser.token;
    await configureAmaOwnerRuntime(patchOwnerId, "codex", "env_patch_test", amaProjectId);

    const { createBoard } = await import("../apps/web/server/boardRepo");
    const patchBoard = await createBoard(env.DB, patchOwnerId, `patch-header-board-${crypto.randomUUID()}`, "ops");
    const patchAgent = await createTestAgent(env.DB, patchOwnerId, {
      name: "Patch header agent",
      username: `patch-header-agent-${crypto.randomUUID()}`,
      runtime: "codex",
      kind: "worker",
      role: "board-maintainer",
      handoff_to: ["worker"],
      skills: ["saltbo/agent-kanban@agent-kanban"],
    });
    await setAgentAmaId(env.DB, patchAgent.id, "ama_agent_patch");

    const capturedPatchHeaders: Record<string, string>[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") {
        return jsonResponse({ access_token: "oauth-token" });
      }
      if (url === "https://ama.test/api/v1/projects/project_patch_test") {
        return jsonResponse({ id: "project_patch_test", name: "Workspace" });
      }
      if (url === "https://ama.test/api/v1/providers?limit=100") {
        return jsonResponse({ data: [{ id: "provider_codex_patch", type: "openai", status: "active" }] });
      }
      if (url === "https://ama.test/api/v1/providers/provider_codex_patch/models?limit=100") {
        return jsonResponse({ data: [{ modelId: "gpt-5.3-codex", availability: "available", metadata: { runtime: "codex" } }] });
      }
      if (url === "https://ama.test/api/v1/providers/provider_codex_patch/models" && reqMethod(input, init) === "POST") {
        return jsonResponse({ ok: true });
      }
      // Maintainer route reconciles the eagerly-created AMA agent (read + patch).
      if (url === "https://ama.test/api/v1/agents/ama_agent_patch" && (reqMethod(input, init) ?? "GET") === "GET") {
        return jsonResponse(amaAgent("ama_agent_patch", { projectId: amaProjectId, provider: "openai", model: "gpt-5.3-codex" }));
      }
      if (url === "https://ama.test/api/v1/agents/ama_agent_patch" && reqMethod(input, init) === "PATCH") {
        return jsonResponse(amaAgent("ama_agent_patch", { projectId: amaProjectId, provider: "openai", model: "gpt-5.3-codex" }));
      }
      if (url === "https://ama.test/api/v1/vaults" && reqMethod(input, init) === "POST") {
        return jsonResponse(amaVault("vault_patch_board", amaProjectId), 201);
      }
      if (url === "https://ama.test/api/v1/vaults/vault_patch_board/credentials" && reqMethod(input, init) === "POST") {
        return jsonResponse(amaCredential("vaultcred_patch", "vaultver_patch"), 201);
      }
      if (url === "https://ama.test/api/v1/vaults/vault_patch_board/credentials?limit=100" && reqMethod(input, init) === "GET") {
        return jsonResponse({ data: [amaCredentialListItem("vaultcred_patch", "ak-variables", ["AK_API_KEY"])] });
      }
      if (url === "https://ama.test/api/v1/memory-stores" && reqMethod(input, init) === "POST") {
        const body = JSON.parse(await reqBody(input, init)) as Record<string, any>;
        return jsonResponse(amaMemoryStore("mem_patch", body.metadata?.name ?? "Patch header agent memory", amaProjectId), 201);
      }
      if (url === "https://ama.test/api/v1/memory-stores/mem_patch/memories" && reqMethod(input, init) === "POST") {
        return jsonResponse({ id: "memory_patch" }, 201);
      }
      if (url === "https://ama.test/api/v1/triggers" && reqMethod(input, init) === "POST") {
        const body = JSON.parse(await reqBody(input, init)) as Record<string, any>;
        const id = body.spec.source.type === "http" ? "http_patch" : "sched_patch";
        return jsonResponse(amaTrigger(id, body, { type: body.spec.source.type === "http" ? "http" : "schedule", intervalSeconds: 3600 }), 201);
      }
      if (
        (url === "https://ama.test/api/v1/triggers/sched_patch" || url === "https://ama.test/api/v1/triggers/http_patch") &&
        reqMethod(input, init) === "PATCH"
      ) {
        const headersObj = input instanceof Request ? Object.fromEntries(input.headers.entries()) : { ...(init?.headers as Record<string, string>) };
        capturedPatchHeaders.push(headersObj);
        const triggerId = url.endsWith("/http_patch") ? "http_patch" : "sched_patch";
        return jsonResponse(
          amaTrigger(triggerId, JSON.parse(await reqBody(input, init)), { type: url.endsWith("/http_patch") ? "http" : "schedule", active: false }),
        );
      }
      if (
        url.startsWith("https://ama.test/api/v1/triggers/sched_patch/runs?") ||
        url.startsWith("https://ama.test/api/v1/triggers/http_patch/runs?")
      ) {
        return jsonResponse({ data: [], pagination: { limit: 20, hasMore: false } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const createRes = await apiRequest(
        "POST",
        `/api/boards/${patchBoard.id}/maintainers`,
        {
          agent_id: patchAgent.id,
          name: "Patch header agent",
          interval_seconds: 3600,
        },
        patchToken,
      );
      expect(createRes.status).toBe(201);
      const maintainer = (await createRes.json()) as any;

      const patchRes = await apiRequest("PATCH", `/api/boards/${patchBoard.id}/maintainers/${maintainer.id}`, { status: "paused" }, patchToken);
      expect(patchRes.status).toBe(200);

      expect(capturedPatchHeaders).toHaveLength(2);
      expect(capturedPatchHeaders.every((headers) => headers["x-ama-project-id"] === amaProjectId)).toBe(true);
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
    }
  });

  it("DELETE /api/boards/:id/maintainers/:maintainerId sends x-ama-project-id header to AMA", async () => {
    const amaProjectId = "project_delete_test";
    const previousAma = {
      AMA_ORIGIN: env.AMA_ORIGIN,
      AMA_OIDC_ISSUER: env.AMA_OIDC_ISSUER,
      AMA_OIDC_CLIENT_ID: env.AMA_OIDC_CLIENT_ID,
      AMA_OIDC_CLIENT_SECRET: env.AMA_OIDC_CLIENT_SECRET,
      AK_API_URL: env.AK_API_URL,
    };
    Object.assign(env, {
      AMA_ORIGIN: "https://ama.test",
      AMA_OIDC_ISSUER: "https://auth.test",
      AMA_OIDC_CLIENT_ID: "ak-app",
      AMA_OIDC_CLIENT_SECRET: "ak-secret",
      AK_API_URL: "https://ak.test",
    });
    const { createAuth: createAuthForDelete } = await import("../apps/web/server/betterAuth");
    const authForDelete = createAuthForDelete(env);
    const deleteUser = await signUpVerifiedUser(env.DB, authForDelete, {
      name: "Delete Header User",
      email: "delete-header@test.com",
      password: "test-password-123",
    });
    const deleteOwnerId = deleteUser.user.id;
    const deleteToken = deleteUser.token;
    await configureAmaOwnerRuntime(deleteOwnerId, "codex", "env_delete_test", amaProjectId);

    const { createBoard } = await import("../apps/web/server/boardRepo");
    const deleteBoard = await createBoard(env.DB, deleteOwnerId, `delete-header-board-${crypto.randomUUID()}`, "ops");
    const deleteAgent = await createTestAgent(env.DB, deleteOwnerId, {
      name: "Delete header agent",
      username: `delete-header-agent-${crypto.randomUUID()}`,
      runtime: "codex",
      kind: "worker",
      role: "board-maintainer",
      handoff_to: ["worker"],
      skills: ["saltbo/agent-kanban@agent-kanban"],
    });
    await setAgentAmaId(env.DB, deleteAgent.id, "ama_agent_delete");

    const capturedDeleteHeaders: Record<string, string>[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") {
        return jsonResponse({ access_token: "oauth-token" });
      }
      if (url === "https://ama.test/api/v1/projects/project_delete_test") {
        return jsonResponse({ id: "project_delete_test", name: "Workspace" });
      }
      if (url === "https://ama.test/api/v1/providers?limit=100") {
        return jsonResponse({ data: [{ id: "provider_codex_delete", type: "openai", status: "active" }] });
      }
      if (url === "https://ama.test/api/v1/providers/provider_codex_delete/models?limit=100") {
        return jsonResponse({ data: [{ modelId: "gpt-5.3-codex", availability: "available", metadata: { runtime: "codex" } }] });
      }
      if (url === "https://ama.test/api/v1/providers/provider_codex_delete/models" && reqMethod(input, init) === "POST") {
        return jsonResponse({ ok: true });
      }
      // Maintainer route reconciles the eagerly-created AMA agent (read + patch).
      if (url === "https://ama.test/api/v1/agents/ama_agent_delete" && (reqMethod(input, init) ?? "GET") === "GET") {
        return jsonResponse(amaAgent("ama_agent_delete", { projectId: amaProjectId, provider: "openai", model: "gpt-5.3-codex" }));
      }
      if (url === "https://ama.test/api/v1/agents/ama_agent_delete" && reqMethod(input, init) === "PATCH") {
        return jsonResponse(amaAgent("ama_agent_delete", { projectId: amaProjectId, provider: "openai", model: "gpt-5.3-codex" }));
      }
      if (url === "https://ama.test/api/v1/vaults" && reqMethod(input, init) === "POST") {
        return jsonResponse(amaVault("vault_delete_board", amaProjectId), 201);
      }
      if (url === "https://ama.test/api/v1/vaults/vault_delete_board/credentials" && reqMethod(input, init) === "POST") {
        return jsonResponse(amaCredential("vaultcred_delete", "vaultver_delete"), 201);
      }
      if (url === "https://ama.test/api/v1/vaults/vault_delete_board/credentials?limit=100" && reqMethod(input, init) === "GET") {
        return jsonResponse({ data: [amaCredentialListItem("vaultcred_delete", "ak-variables", ["AK_API_KEY"])] });
      }
      if (url === "https://ama.test/api/v1/memory-stores" && reqMethod(input, init) === "POST") {
        const body = JSON.parse(await reqBody(input, init)) as Record<string, any>;
        return jsonResponse(amaMemoryStore("mem_delete", body.metadata?.name ?? "Delete header agent memory", amaProjectId), 201);
      }
      if (url === "https://ama.test/api/v1/memory-stores/mem_delete/memories" && reqMethod(input, init) === "POST") {
        return jsonResponse({ id: "memory_delete" }, 201);
      }
      if (url === "https://ama.test/api/v1/triggers" && reqMethod(input, init) === "POST") {
        const body = JSON.parse(await reqBody(input, init)) as Record<string, any>;
        const id = body.spec.source.type === "http" ? "http_delete" : "sched_delete";
        return jsonResponse(amaTrigger(id, body, { type: body.spec.source.type === "http" ? "http" : "schedule", intervalSeconds: 3600 }), 201);
      }
      if (
        (url === "https://ama.test/api/v1/triggers/sched_delete" || url === "https://ama.test/api/v1/triggers/http_delete") &&
        reqMethod(input, init) === "DELETE"
      ) {
        const headersObj = input instanceof Request ? Object.fromEntries(input.headers.entries()) : { ...(init?.headers as Record<string, string>) };
        capturedDeleteHeaders.push(headersObj);
        return new Response(null, { status: 204 });
      }
      if (url === "https://ama.test/api/v1/memory-stores/mem_delete" && reqMethod(input, init) === "PATCH") {
        return jsonResponse(amaMemoryStore("mem_delete", "Delete header agent memory", amaProjectId));
      }
      if (
        url.startsWith("https://ama.test/api/v1/triggers/sched_delete/runs?") ||
        url.startsWith("https://ama.test/api/v1/triggers/http_delete/runs?")
      ) {
        return jsonResponse({ data: [], pagination: { limit: 20, hasMore: false } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const createRes = await apiRequest(
        "POST",
        `/api/boards/${deleteBoard.id}/maintainers`,
        {
          agent_id: deleteAgent.id,
          name: "Delete header agent",
          interval_seconds: 3600,
        },
        deleteToken,
      );
      expect(createRes.status).toBe(201);
      const maintainer = (await createRes.json()) as any;

      const archiveRes = await apiRequest("DELETE", `/api/boards/${deleteBoard.id}/maintainers/${maintainer.id}`, undefined, deleteToken);
      expect(archiveRes.status).toBe(200);
      await expect(archiveRes.json()).resolves.toEqual({ ok: true });

      expect(capturedDeleteHeaders).toHaveLength(2);
      expect(capturedDeleteHeaders.every((headers) => headers["x-ama-project-id"] === amaProjectId)).toBe(true);
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
    }
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

  it("GET /api/agents uses runnable AMA runtime state without treating full capacity as unavailable", async () => {
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
    await configureAmaOwnerRuntime(userId, "claude", "env_available");
    await configureAmaOwnerRuntime(userId, "codex", "env_full");
    await configureAmaOwnerRuntime(userId, "copilot", "env_limited");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") {
        return jsonResponse({ access_token: "oauth-token" });
      }
      if (url === "https://ama.test/api/v1/runners?environmentId=env_available&limit=100") {
        return jsonResponse({
          data: [
            {
              id: "runner_available",
              environmentId: "env_available",
              state: "active",
              runtimes: [{ runtime: "claude-code", models: ["claude-sonnet-4-6"], state: "ready" }],
              currentLoad: 0,
              maxConcurrent: 5,
              lastHeartbeatAt: new Date().toISOString(),
            },
          ],
        });
      }
      if (url === "https://ama.test/api/v1/runners?environmentId=env_full&limit=100") {
        return jsonResponse({
          data: [
            {
              id: "runner_full",
              environmentId: "env_full",
              state: "active",
              runtimes: [{ runtime: "codex", models: ["gpt-5.3-codex"], state: "ready" }],
              currentLoad: 2,
              maxConcurrent: 2,
              lastHeartbeatAt: new Date().toISOString(),
            },
          ],
        });
      }
      if (url === "https://ama.test/api/v1/runners?environmentId=env_limited&limit=100") {
        return jsonResponse({
          data: [
            {
              id: "runner_limited",
              environmentId: "env_limited",
              state: "active",
              runtimes: [{ runtime: "copilot", models: [], state: "limited", detail: "Runtime authorization unavailable" }],
              currentLoad: 0,
              maxConcurrent: 5,
              lastHeartbeatAt: new Date().toISOString(),
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await createTestAgent(env.DB, userId, { username: "ama-available-agent", runtime: "claude", role: "ama-runtime-source" });
      await createTestAgent(env.DB, userId, { username: "ama-full-agent", runtime: "codex", role: "ama-runtime-source" });
      await createTestAgent(env.DB, userId, { username: "ama-limited-agent", runtime: "copilot", role: "ama-runtime-source" });
      const res = await apiRequest("GET", "/api/agents?kind=worker&role=ama-runtime-source&available=true", undefined, apiKey);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any[];
      expect(body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ username: "ama-available-agent", status: expect.objectContaining({ schedulable: true }) }),
          expect.objectContaining({ username: "ama-full-agent", status: expect.objectContaining({ schedulable: true }) }),
        ]),
      );
      expect(body.map((agent) => agent.username)).not.toContain("ama-limited-agent");

      const unavailableRes = await apiRequest("GET", "/api/agents?kind=worker&role=ama-runtime-source&available=false", undefined, apiKey);
      expect(unavailableRes.status).toBe(200);
      await expect(unavailableRes.json()).resolves.toEqual([
        expect.objectContaining({ username: "ama-limited-agent", status: expect.objectContaining({ schedulable: false }) }),
      ]);
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
    }
  });

  it("GET /api/agents filters AMA-backed agents out when no active runner can serve their runtime", async () => {
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
    await configureAmaOwnerRuntime(userId, "codex", "env_unavailable");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = reqUrl(input);
        if (url === "https://auth.test/.well-known/openid-configuration") {
          return jsonResponse({ access_token: "oauth-token" });
        }
        if (url === "https://ama.test/api/v1/runners?environmentId=env_available&limit=100") {
          return jsonResponse({
            data: [
              {
                id: "runner_available",
                environmentId: "env_available",
                state: "active",
                runtimes: [{ runtime: "claude-code", models: ["claude-sonnet-4-6"], state: "ready" }],
                currentLoad: 0,
                maxConcurrent: 5,
                lastHeartbeatAt: new Date().toISOString(),
              },
            ],
          });
        }
        if (url === "https://ama.test/api/v1/runners?environmentId=env_full&limit=100") {
          return jsonResponse({
            data: [
              {
                id: "runner_full",
                environmentId: "env_full",
                state: "active",
                runtimes: [{ runtime: "codex", models: ["gpt-5.3-codex"], state: "ready" }],
                currentLoad: 2,
                maxConcurrent: 2,
                lastHeartbeatAt: new Date().toISOString(),
              },
            ],
          });
        }
        if (url === "https://ama.test/api/v1/runners?environmentId=env_limited&limit=100") {
          return jsonResponse({
            data: [
              {
                id: "runner_limited",
                environmentId: "env_limited",
                state: "active",
                runtimes: [{ runtime: "copilot", models: [], state: "limited" }],
                currentLoad: 0,
                maxConcurrent: 5,
                lastHeartbeatAt: new Date().toISOString(),
              },
            ],
          });
        }
        if (url === "https://ama.test/api/v1/runners?environmentId=env_unavailable&limit=100") {
          return jsonResponse({ data: [] });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    try {
      await createTestAgent(env.DB, userId, { username: "ama-unavailable-agent", runtime: "codex", role: "ama-runtime-unavailable" });
      const availableRes = await apiRequest("GET", "/api/agents?role=ama-runtime-unavailable&available=true", undefined, apiKey);
      expect(availableRes.status).toBe(200);
      expect(await availableRes.json()).toEqual([]);

      const unavailableRes = await apiRequest("GET", "/api/agents?role=ama-runtime-unavailable&available=false", undefined, apiKey);
      expect(unavailableRes.status).toBe(200);
      await expect(unavailableRes.json()).resolves.toEqual([
        expect.objectContaining({
          username: "ama-unavailable-agent",
          status: expect.objectContaining({ schedulable: false }),
        }),
      ]);
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
    }
  });

  // ─── Models ───

  it("GET /api/models requires a valid runtime", async () => {
    const missing = await apiRequest("GET", "/api/models", undefined, apiKey);
    expect(missing.status).toBe(400);

    const invalid = await apiRequest("GET", "/api/models?runtime=not-a-runtime", undefined, apiKey);
    expect(invalid.status).toBe(400);
  });

  it("GET /api/models returns the cloud catalog for the ama runtime fetched from AMA", async () => {
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") {
        return jsonResponse({ access_token: "oauth-token", expires_in: 3600 });
      }
      // AMA's global model catalog endpoint (replaced the old per-runtime endpoint)
      if (url === "https://ama.test/api/v1/providers/models") {
        return jsonResponse({
          data: [
            // Non-preferred model first — must be sorted after preferred ones
            {
              providerId: "meta",
              modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
              displayName: "Llama 3.3 70B (Workers AI)",
              availability: "available",
            },
            // Preferred models in reverse order to prove sorting works
            { providerId: "openai", modelId: "@cf/openai/gpt-oss-120b", displayName: "GPT-OSS 120B (Workers AI)", availability: "available" },
            {
              providerId: "moonshotai",
              modelId: "@cf/moonshotai/kimi-k2.7-code",
              displayName: "Kimi K2.7 Code (Workers AI)",
              availability: "available",
            },
            {
              providerId: "anthropic",
              modelId: "anthropic/claude-haiku-4-5",
              displayName: "Claude Haiku 4.5",
              availability: "available",
            },
            // Unavailable model must be excluded
            {
              providerId: "meta",
              modelId: "@cf/meta/llama-4-scout-17b-16e-instruct",
              displayName: "Llama 4 Scout (Workers AI)",
              availability: "disabled",
            },
          ],
          pagination: { nextCursor: null },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await apiRequest("GET", "/api/models?runtime=ama", undefined, apiKey);
      expect(res.status).toBe(200);
      const body = await res.json();
      // Preferred models come first in the declared order
      expect(body[0]).toEqual({ id: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5" });
      expect(body[1]).toEqual({ id: "@cf/openai/gpt-oss-120b", name: "GPT-OSS 120B (Workers AI)" });
      expect(body[2]).toEqual({ id: "@cf/moonshotai/kimi-k2.7-code", name: "Kimi K2.7 Code (Workers AI)" });
      // Non-preferred available model follows
      expect(body[3]).toEqual({ id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", name: "Llama 3.3 70B (Workers AI)" });
      // Unavailable model excluded
      expect(body).not.toContainEqual(expect.objectContaining({ id: "@cf/meta/llama-4-scout-17b-16e-instruct" }));
      expect(body).toHaveLength(4);
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
    }
  });

  it("GET /api/models returns an empty list for machine runtimes when AMA dispatch is not configured", async () => {
    const res = await apiRequest("GET", "/api/models?runtime=codex", undefined, apiKey);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
  });

  it("GET /api/models lists models declared by live AMA runners for machine runtimes", async () => {
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
    await configureAmaOwnerRuntime(userId, "gemini", "env_models");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") {
        return jsonResponse({ access_token: "oauth-token" });
      }
      // gemini is a self-hosted runtime: model discovery goes directly to runner runtime reports
      if (url === "https://ama.test/api/v1/runners?environmentId=env_models&limit=100") {
        return jsonResponse({
          data: [
            {
              id: "runner_models_1",
              environmentId: "env_models",
              state: "active",
              runtimes: [
                {
                  runtime: "gemini",
                  models: ["gemini-3-pro", "models/gemini:exp"],
                  state: "ready",
                },
                { runtime: "codex", models: ["gpt-5.3-codex"], state: "ready" },
              ],
              currentLoad: 0,
              maxConcurrent: 2,
              lastHeartbeatAt: new Date().toISOString(),
            },
            {
              id: "runner_models_2",
              environmentId: "env_models",
              state: "active",
              // Limited runtimes remain discoverable, and duplicate models are deduped.
              runtimes: [
                {
                  runtime: "gemini",
                  models: ["gemini-3-pro"],
                  state: "limited",
                  detail: "Daily quota exhausted",
                },
              ],
              currentLoad: 2,
              maxConcurrent: 2,
              lastHeartbeatAt: new Date().toISOString(),
            },
            {
              id: "runner_models_offline",
              environmentId: "env_models",
              state: "draining",
              runtimes: [{ runtime: "gemini", models: ["offline-model"], state: "ready" }],
              currentLoad: 0,
              maxConcurrent: 2,
              lastHeartbeatAt: null,
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await apiRequest("GET", "/api/models?runtime=gemini", undefined, apiKey);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual([{ id: "gemini-3-pro" }, { id: "models/gemini:exp" }]);
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
    }
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

  it("GET /api/agents/:id includes AMA runtime session status and usage", async () => {
    const amaAgent = await createTestAgent(env.DB, userId, { username: `ama-session-agent-${randomUUID()}`, runtime: "claude" });
    await env.DB.prepare(
      `INSERT INTO ama_agent_sessions (
        id, owner_id, agent_id, ama_session_id, status, public_key, delegation_proof,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_micro_usd, created_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "runtime-session-agent-detail",
        userId,
        amaAgent.id,
        "ama-session-agent-detail",
        "pub",
        "proof",
        1000,
        2000,
        300,
        40,
        5000,
        new Date().toISOString(),
      )
      .run();

    const res = await apiRequest("GET", `/api/agents/${amaAgent.id}`, undefined, apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toEqual({
      schedulable: true,
      tasks: {
        todo: 0,
        in_progress: 0,
        in_review: 0,
        done: 0,
        cancelled: 0,
      },
    });
    expect(body.input_tokens).toBe(1000);
    expect(body.output_tokens).toBe(2000);
    expect(body.cache_read_tokens).toBe(300);
    expect(body.cache_creation_tokens).toBe(40);
    expect(body.cost_micro_usd).toBe(5000);
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

  it("POST /api/tasks keeps unassigned task creation compatible when AMA dispatch is configured", async () => {
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
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      const jwt = await signSessionJWT();
      const res = await apiRequest("POST", "/api/tasks", { title: "Unassigned compatibility task", board_id: boardId }, jwt);

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.title).toBe("Unassigned compatibility task");
      expect(body.status).toBe("todo");
      expect(body.assigned_to).toBeNull();
      expect(body.metadata?.annotations?.["ama.sessionId"]).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
    }
  });

  it("POST /api/tasks keeps assigned task creation on the legacy path when AMA mode is partially configured", async () => {
    const previousAma = {
      AMA_ORIGIN: env.AMA_ORIGIN,
      AMA_OIDC_ISSUER: env.AMA_OIDC_ISSUER,
      AMA_OIDC_CLIENT_ID: env.AMA_OIDC_CLIENT_ID,
      AMA_OIDC_CLIENT_SECRET: env.AMA_OIDC_CLIENT_SECRET,
    };
    Object.assign(env, {
      AMA_ORIGIN: "https://ama.test",
      AMA_OIDC_ISSUER: undefined,
      AMA_OIDC_CLIENT_ID: undefined,
      AMA_OIDC_CLIENT_SECRET: undefined,
    });

    try {
      const jwt = await signSessionJWT();
      const res = await apiRequest(
        "POST",
        "/api/tasks",
        { title: "Assigned with incomplete AMA runtime", board_id: boardId, assigned_to: agentId },
        jwt,
      );

      const body = (await res.json()) as any;
      expect(res.status).toBe(201);
      expect(body.title).toBe("Assigned with incomplete AMA runtime");
      expect(body.assigned_to).toBe(agentId);
      expect(body.status).toBe("todo");
      expect(body.metadata?.annotations?.["ama.sessionId"]).toBeUndefined();
    } finally {
      Object.assign(env, previousAma);
    }
  });

  it("POST /api/tasks dispatches assigned tasks to AMA and stores AK-owned annotations", async () => {
    const previousAma = {
      AMA_ORIGIN: env.AMA_ORIGIN,
      AMA_OIDC_ISSUER: env.AMA_OIDC_ISSUER,
      AMA_OIDC_CLIENT_ID: env.AMA_OIDC_CLIENT_ID,
      AMA_OIDC_CLIENT_SECRET: env.AMA_OIDC_CLIENT_SECRET,
      AK_API_URL: env.AK_API_URL,
    };
    Object.assign(env, {
      AMA_ORIGIN: "https://ama.test",
      AMA_OIDC_ISSUER: "https://auth.test",
      AMA_OIDC_CLIENT_ID: "ak-app",
      AMA_OIDC_CLIENT_SECRET: "ak-secret",
      AK_API_URL: "https://ak.test",
    });
    await configureAmaOwnerRuntime(userId, "claude", "env_123");
    const { updateAgent } = await import("../apps/web/server/agentRepo");
    const { createSubagent } = await import("../apps/web/server/subagentRepo");
    const reviewer = await createSubagent(env.DB, userId, {
      name: "Review Agent",
      username: "reviewer",
      role: "reviewer",
      soul: "Review implementation quality.",
      models: { claude: "claude-sonnet-4-6" },
      skills: ["saltbo/agent-kanban@agent-kanban"],
    });
    await updateAgent(env.DB, agentId, {
      handoff_to: ["enduser"],
      skills: ["saltbo/agent-kanban@agent-kanban"],
      subagents: [reviewer.id],
    });
    // The AMA agent is created eagerly at agent creation; dispatch reads the
    // stored ama_agent_id rather than creating one.
    await setAgentAmaId(env.DB, agentId, "ama_agent_123");

    const taskDetail = "Use the detail alias in the task dispatch prompt.";
    let runtimePrivateKeyJwk: JsonWebKey | null = null;
    let createdAmaSessionCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") {
        return jsonResponse({ access_token: "oauth-token" });
      }
      if (url === "https://ama.test/api/v1/projects/project_123") {
        return jsonResponse({ id: "project_123", name: "Workspace" });
      }
      if (url === "https://ama.test/api/v1/runners?environmentId=env_123&limit=100") {
        return jsonResponse({
          data: [
            {
              id: "runner_123",
              environmentId: "env_123",
              state: "active",
              runtimes: [{ runtime: "claude-code", models: ["claude-sonnet-4-6"], state: "ready" }],
              currentLoad: 0,
              maxConcurrent: 1,
              lastHeartbeatAt: new Date().toISOString(),
            },
          ],
        });
      }
      if (url === "https://ama.test/api/v1/vaults/vault_123/credentials") {
        const body = JSON.parse(await reqBody(input, init)) as Record<string, any>;
        expect(body.name).toMatch(/^ak-session-/);
        expect(body.secret.stringData.AK_AGENT_KEY).toContain('"kty":"OKP"');
        runtimePrivateKeyJwk = JSON.parse(body.secret.stringData.AK_AGENT_KEY) as JsonWebKey;
        return jsonResponse(amaCredential("vaultcred_123", "vaultver_123"), 201);
      }
      if (url === "https://ama.test/api/v1/sessions") {
        createdAmaSessionCount += 1;
        const body = JSON.parse(await reqBody(input, init)) as Record<string, any>;
        expect(body.metadata.name).toContain(createdAmaSessionCount === 1 ? "Immediate AMA assignment" : "AMA dispatched task");
        expect(body.spec.agentId).toBe("ama_agent_123");
        expect(body.spec.environmentId).toBe("env_123");
        expect(body.spec.runtime).toBe("claude-code");
        expect(body.spec.env).toMatchObject({
          AK_WORKER: "1",
          AK_AGENT_ID: agentId,
          AK_API_URL: "https://ak.test",
        });
        expect(body.spec.env.AK_SESSION_ID).toEqual(expect.any(String));
        expect(body.spec.envFrom).toEqual([
          { type: "secret", name: "AK_AGENT_KEY", secretRef: amaCredentialSecretRef("vault_123", "vaultcred_123"), key: "AK_AGENT_KEY" },
        ]);
        expect(body.prompt).toContain(`ak describe task`);
        expect(body.prompt).toContain("do not use the ak-task leader workflow");
        expect(body.prompt).toContain("create a draft PR");
        expect(body.prompt).toContain("mark it ready");
        expect(body.prompt.toLowerCase()).toContain("do not end the session without submitting review");
        expect(body.prompt).not.toContain(taskDetail);
        expect(body.prompt).not.toContain("Task detail:");
        expect(JSON.stringify(body)).not.toContain("board_");
        const sessionId = createdAmaSessionCount === 1 ? "session_ama_assign_success" : "session_ama_123";
        return jsonResponse(amaSession(sessionId, { agentId: body.spec.agentId, environmentId: "env_123", runtime: body.spec.runtime }), 201);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { createTask } = await import("../apps/web/server/taskRepo");
      const scheduled = await createTask(env.DB, userId, {
        title: "Scheduled AMA assignment",
        board_id: boardId,
        scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const leaderJwt = await signLeaderSessionJWT();
      const scheduledAssign = await apiRequest("POST", `/api/tasks/${scheduled.id}/assign`, { agent_id: agentId }, leaderJwt);
      expect(scheduledAssign.status).toBe(200);
      const scheduledBody = (await scheduledAssign.json()) as any;
      expect(scheduledBody.metadata.annotations["runtime.source"]).toBe("ama");
      expect(scheduledBody.metadata.annotations["ama.sessionId"]).toBeUndefined();
      expect(scheduledBody.metadata.annotations["runtime.assignmentToken"]).toBeUndefined();
      const persistedScheduled = await env.DB.prepare("SELECT metadata FROM tasks WHERE id = ?").bind(scheduled.id).first<{ metadata: string }>();
      const persistedScheduledMetadata = JSON.parse(persistedScheduled!.metadata);
      expect(persistedScheduledMetadata.annotations["runtime.source"]).toBe("ama");
      expect(persistedScheduledMetadata.annotations["runtime.assignmentToken"]).toBeUndefined();

      const sameAgentAssign = await apiRequest("POST", `/api/tasks/${scheduled.id}/assign`, { agent_id: agentId }, leaderJwt);
      expect(sameAgentAssign.status).toBe(200);
      const sameAgentBody = (await sameAgentAssign.json()) as any;
      expect(sameAgentBody.metadata.annotations["runtime.source"]).toBe("ama");
      expect(sameAgentBody.metadata.annotations["runtime.assignmentToken"]).toBeUndefined();

      const immediate = await createTask(env.DB, userId, { title: "Immediate AMA assignment", board_id: boardId });
      const immediateAssign = await apiRequest("POST", `/api/tasks/${immediate.id}/assign`, { agent_id: agentId }, leaderJwt);
      expect(immediateAssign.status).toBe(200);
      const immediateBody = (await immediateAssign.json()) as any;
      expect(immediateBody.metadata.annotations).toMatchObject({
        "runtime.source": "ama",
        "ama.sessionId": "session_ama_assign_success",
        "ama.dispatch.result": "accepted",
      });
      expect(immediateBody.metadata.annotations).not.toHaveProperty("runtime.assignmentToken");
      const persistedImmediate = await env.DB.prepare("SELECT metadata FROM tasks WHERE id = ?").bind(immediate.id).first<{ metadata: string }>();
      expect(JSON.parse(persistedImmediate!.metadata).annotations).not.toHaveProperty("runtime.assignmentToken");

      const jwt = await signSessionJWT();
      const res = await apiRequest(
        "POST",
        "/api/tasks",
        {
          title: "AMA dispatched task",
          board_id: boardId,
          assigned_to: agentId,
          detail: taskDetail,
        },
        jwt,
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.description).toBe(taskDetail);
      expect(body.metadata.annotations).toMatchObject({
        "ama.projectId": "project_123",
        agentId,
        "ama.agentId": "ama_agent_123",
        "ama.environmentId": "env_123",
        "ama.runtime": "claude-code",
        "ama.sessionId": "session_ama_123",
        "ama.dispatch.result": "accepted",
      });
      expect(body.metadata.annotations).not.toHaveProperty("ama.runtimeSecretEnv.AK_AGENT_KEY");
      expect(body.metadata.annotations).not.toHaveProperty("runtime.assignmentToken");
      expect(body.metadata.annotations.agentSessionId).toEqual(expect.any(String));
      const taskRow = await env.DB.prepare("SELECT description, metadata FROM tasks WHERE id = ?")
        .bind(body.id)
        .first<{ description: string; metadata: string }>();
      expect(taskRow?.description).toBe(taskDetail);
      expect(JSON.parse(taskRow!.metadata).annotations).not.toHaveProperty("runtime.assignmentToken");

      const sessionRow = await env.DB.prepare("SELECT ama_session_id, status FROM ama_agent_sessions WHERE id = ?")
        .bind(body.metadata.annotations.agentSessionId)
        .first<{ ama_session_id: string; status: string }>();
      expect(sessionRow).toMatchObject({ ama_session_id: "session_ama_123", status: "active" });
      const bridgeMachine = await env.DB.prepare("SELECT id FROM machines WHERE device_id = 'ama-runtime-bridge'").first<{ id: string }>();
      expect(bridgeMachine).toBeNull();
      const calledUrls = fetchMock.mock.calls.map(([url]) => reqUrl(url));
      // Dispatch no longer creates the AMA agent (created eagerly at agent
      // creation); it reads the stored id and only creates the session.
      expect(calledUrls).not.toContain("https://ama.test/api/v1/agents");
      expect(calledUrls).toContain("https://ama.test/api/v1/sessions");

      expect(runtimePrivateKeyJwk).toBeTruthy();
      const runtimePrivateKey = await crypto.subtle.importKey("jwk", runtimePrivateKeyJwk!, { name: "Ed25519" } as any, true, ["sign"]);
      const runtimeJwt = await new SignJWT({
        sub: body.metadata.annotations.agentSessionId,
        aid: agentId,
        jti: randomUUID(),
        aud: BETTER_AUTH_URL,
      })
        .setProtectedHeader({ alg: "EdDSA", typ: "agent+jwt" })
        .setIssuedAt()
        .setExpirationTime("60s")
        .sign(runtimePrivateKey);
      const claimRes = await apiRequest("POST", `/api/tasks/${body.id}/claim`, undefined, runtimeJwt);
      expect(claimRes.status).toBe(200);
      const claimed = (await claimRes.json()) as any;
      expect(claimed.status).toBe("in_progress");
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
    }
  });

  it("cleans up local task and runtime session rows when initial AMA dispatch fails", async () => {
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
    await configureAmaOwnerRuntime(userId, "codex", "env_123");
    const tempAgent = await createTestAgent(env.DB, userId, {
      name: `Failed Dispatch Agent ${randomUUID()}`,
      username: `failed-dispatch-${randomUUID()}`,
      runtime: "codex",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") {
        return jsonResponse({ access_token: "oauth-token" });
      }
      if (url === "https://ama.test/api/v1/environments/env_123") {
        return jsonResponse({
          metadata: { uid: "env_123", projectId: "project_123", name: "env_123", description: null, archivedAt: null },
          spec: {},
          status: {},
        });
      }
      if (url === "https://ama.test/api/v1/providers?limit=100") {
        return jsonResponse({ data: [{ id: "provider_codex", status: "active" }] });
      }
      if (url === "https://ama.test/api/v1/providers/provider_codex/models?limit=100") {
        return jsonResponse({ data: [{ modelId: "gpt-5.3-codex", availability: "available", metadata: { runtime: "codex" } }] });
      }
      if (url === "https://ama.test/api/v1/agents") {
        return jsonResponse(amaAgent("ama_agent_123", { projectId: "project_123", provider: "openai", model: "gpt-5.3-codex" }), 201);
      }
      if (url === "https://ama.test/api/v1/vaults/vault_123/credentials") {
        return jsonResponse(amaCredential("vaultcred_123", "vaultver_123"), 201);
      }
      if (url === "https://ama.test/api/v1/sessions") {
        return jsonResponse({ error: "runtime unavailable" }, 503);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const jwt = await signSessionJWT();
      const res = await apiRequest(
        "POST",
        "/api/tasks",
        {
          title: "Failed AMA dispatch task",
          board_id: boardId,
          assigned_to: tempAgent.id,
          metadata: { annotations: { "ama.agentId": "ama_agent_123" } },
        },
        jwt,
      );
      expect(res.status).toBe(500);
      const taskRow = await env.DB.prepare("SELECT id FROM tasks WHERE title = ?").bind("Failed AMA dispatch task").first();
      expect(taskRow).toBeNull();
      const activeSessions = await env.DB.prepare("SELECT COUNT(*) as count FROM ama_agent_sessions WHERE agent_id = ? AND status = 'active'")
        .bind(tempAgent.id)
        .first<{ count: number }>();
      expect(activeSessions?.count).toBe(0);
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
    }
  });

  it("does not assign when AMA dispatch fails while assigning an existing task", async () => {
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
    await configureAmaOwnerRuntime(userId, "codex", "env_123");
    const tempAgent = await createTestAgent(env.DB, userId, {
      name: `Assign Failure Agent ${randomUUID()}`,
      username: `assign-failure-${randomUUID()}`,
      runtime: "codex",
    });
    await setAgentAmaId(env.DB, tempAgent.id, "ama_agent_assign_failure");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") {
        return jsonResponse({ access_token: "oauth-token" });
      }
      if (url === "https://ama.test/api/v1/projects/project_123") {
        return jsonResponse({ id: "project_123", name: "Workspace" });
      }
      if (url === "https://ama.test/api/v1/runners?environmentId=env_123&limit=100") {
        return jsonResponse({
          data: [
            {
              id: "runner_assign_failure",
              environmentId: "env_123",
              state: "active",
              runtimes: [{ runtime: "codex", models: [], state: "ready" }],
              currentLoad: 0,
              maxConcurrent: 1,
              lastHeartbeatAt: new Date().toISOString(),
            },
          ],
        });
      }
      if (url === "https://ama.test/api/v1/vaults/vault_123/credentials") {
        return jsonResponse(amaCredential("vaultcred_123", "vaultver_123"), 201);
      }
      if (url === "https://ama.test/api/v1/sessions") {
        return jsonResponse({ error: "runtime unavailable" }, 503);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { createTask } = await import("../apps/web/server/taskRepo");
      const originalMetadata = { annotations: { retained: "original" }, request: { source: "regression" } };
      const task = await createTask(env.DB, userId, {
        title: "Assign dispatch failure",
        board_id: boardId,
        metadata: originalMetadata,
      });
      const leaderJwt = await signLeaderSessionJWT();
      const res = await apiRequest("POST", `/api/tasks/${task.id}/assign`, { agent_id: tempAgent.id }, leaderJwt);
      expect(res.status).toBe(500);
      const row = await env.DB.prepare("SELECT assigned_to, metadata, updated_at FROM tasks WHERE id = ?")
        .bind(task.id)
        .first<{ assigned_to: string | null; metadata: string; updated_at: string }>();
      expect(row?.assigned_to).toBeNull();
      expect(JSON.parse(row!.metadata)).toEqual(originalMetadata);
      expect(row?.updated_at).toBe(task.updated_at);
      expect(JSON.parse(row!.metadata).annotations).not.toHaveProperty("runtime.assignmentToken");
      const assignedActions = await env.DB.prepare("SELECT COUNT(*) AS count FROM task_actions WHERE task_id = ? AND action = 'assigned'")
        .bind(task.id)
        .first<{ count: number }>();
      expect(assignedActions?.count).toBe(0);
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
    }
  });

  it("POST /api/tasks/:id/release redispatches assigned AMA tasks", async () => {
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
    await configureAmaOwnerRuntime(userId, "codex", "env_release");
    const tempAgent = await createTestAgent(env.DB, userId, {
      name: `Release Redispatch Agent ${randomUUID()}`,
      username: `release-redispatch-${randomUUID()}`,
      runtime: "codex",
    });
    await setAgentAmaId(env.DB, tempAgent.id, "ama_agent_release");

    let sessionCreateCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") {
        return jsonResponse({ access_token: "oauth-token" });
      }
      if (url === "https://ama.test/api/v1/projects/project_123") {
        return jsonResponse({ id: "project_123", name: "Workspace" });
      }
      if (url === "https://ama.test/api/v1/runners?environmentId=env_release&limit=100") {
        return jsonResponse({
          data: [
            {
              id: "runner_release",
              environmentId: "env_release",
              state: "active",
              runtimes: [{ runtime: "codex", models: ["gpt-5.3-codex"], state: "ready" }],
              currentLoad: 0,
              maxConcurrent: 1,
              lastHeartbeatAt: new Date().toISOString(),
            },
          ],
        });
      }
      if (url === "https://ama.test/api/v1/providers?limit=100") {
        return jsonResponse({
          data: [{ id: "provider_codex", type: "openai", status: "active" }],
          pagination: { limit: 100, hasMore: false, nextCursor: null },
        });
      }
      if (url === "https://ama.test/api/v1/providers/provider_codex/models?limit=100") {
        return jsonResponse({
          data: [{ modelId: "gpt-5.3-codex", availability: "available", metadata: { runtime: "codex" } }],
          pagination: { limit: 100, hasMore: false, nextCursor: null },
        });
      }
      if (url === "https://ama.test/api/v1/agents/ama_agent_release") {
        return jsonResponse(amaAgent("ama_agent_release", { projectId: "project_123", provider: "openai", model: "gpt-5.3-codex" }));
      }
      if (url === "https://ama.test/api/v1/agents") {
        return jsonResponse(amaAgent("ama_agent_release", { projectId: "project_123", provider: "openai", model: "gpt-5.3-codex" }), 201);
      }
      if (url === "https://ama.test/api/v1/vaults/vault_123/credentials") {
        return jsonResponse(amaCredential("vaultcred_release", "vaultver_release"), 201);
      }
      if (url === "https://ama.test/api/v1/vaults/vault_123/credentials/vaultcred_release" && reqMethod(input, init) === "PATCH") {
        return jsonResponse({ id: "vaultcred_release", state: "revoked" });
      }
      if (url === "https://ama.test/api/v1/sessions/session_release_old" && reqMethod(input, init) === "PATCH") {
        return jsonResponse({ id: "session_release_old", state: "closed" });
      }
      if (url === "https://ama.test/api/v1/sessions/session_release_1" && reqMethod(input, init) === "PATCH") {
        return jsonResponse({ id: "session_release_1", state: "closed" });
      }
      if (url.startsWith("https://ama.test/api/v1/usage-records?")) {
        return jsonResponse({ data: [], pagination: { limit: 100, hasMore: false, nextCursor: null } });
      }
      if (url === "https://ama.test/api/v1/sessions") {
        const body = JSON.parse(await reqBody(input, init)) as Record<string, any>;
        expect(body.spec.agentId).toBe("ama_agent_release");
        expect(body.spec.environmentId).toBe("env_release");
        expect(body.spec.runtime).toBe("codex");
        expect(body.prompt).toContain("AK task");
        expect(body.prompt).toContain("ak describe task");
        expect(body.prompt).toContain("do not use the ak-task leader workflow");
        expect(body.prompt).toContain("create a draft PR");
        expect(body.prompt).toContain("mark it ready");
        sessionCreateCount += 1;
        return jsonResponse(
          amaSession(`session_release_${sessionCreateCount}`, {
            agentId: body.spec.agentId,
            environmentId: "env_release",
            runtime: body.spec.runtime,
          }),
          201,
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { createTask } = await import("../apps/web/server/taskRepo");
      const task = await createTask(env.DB, userId, {
        title: "Release redispatch task",
        board_id: boardId,
        assigned_to: tempAgent.id,
        metadata: { annotations: { "runtime.source": "ama", "ama.sessionId": "session_release_old", "ama.projectId": "project_123" } },
        skipRuntimeAvailability: true,
      });
      await env.DB.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").bind(task.id).run();

      const leaderJwt = await signLeaderSessionJWT();
      const res = await apiRequest("POST", `/api/tasks/${task.id}/release`, {}, leaderJwt);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.status).toBe("todo");
      expect(body.assigned_to).toBe(tempAgent.id);
      expect(body.metadata.annotations).toMatchObject({
        "ama.environmentId": "env_release",
        "ama.sessionId": "session_release_1",
        "ama.dispatch.result": "accepted",
      });
      expect(body.metadata.annotations.agentSessionId).toEqual(expect.any(String));
      expect(fetchMock.mock.calls.map(([url]) => reqUrl(url))).toContain("https://ama.test/api/v1/sessions");

      const assignRes = await apiRequest("POST", `/api/tasks/${task.id}/assign`, { agent_id: tempAgent.id }, leaderJwt);
      expect(assignRes.status).toBe(200);
      const reassigned = (await assignRes.json()) as any;
      expect(reassigned.status).toBe("todo");
      expect(reassigned.assigned_to).toBe(tempAgent.id);
      expect(reassigned.metadata.annotations).toMatchObject({
        "ama.environmentId": "env_release",
        "ama.sessionId": "session_release_2",
        "ama.dispatch.result": "accepted",
      });
      expect(sessionCreateCount).toBe(2);
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
    }
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

  it("routes task messages, rejects, and cancels to bound AMA sessions", async () => {
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

    const runtimeMessages: string[] = [];
    const stops: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") {
        return jsonResponse({ access_token: "oauth-token" });
      }
      if (url === "https://ama.test/api/v1/sessions/session_123/messages") {
        const body = JSON.parse(await reqBody(input, init)) as { content: string };
        expect(reqMethod(input, init)).toBe("POST");
        expect(body).toMatchObject({ type: "prompt" });
        runtimeMessages.push(body.content);
        return jsonResponse({ id: "msg_1" }, 201);
      }
      if (url === "https://ama.test/api/v1/sessions/session_123" && reqMethod(input, init) === "PATCH") {
        stops.push(url);
        return jsonResponse({ id: "session_123", state: "closed" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { createTask } = await import("../apps/web/server/taskRepo");
      const metadata = { annotations: { "ama.projectId": "project_123", "ama.sessionId": "session_123" } };
      const messageTask = await createTask(env.DB, userId, { title: "AMA message task", board_id: boardId, metadata });
      const jwt = await signSessionJWT();
      const messageRes = await apiRequest("POST", `/api/tasks/${messageTask.id}/messages`, { sender_type: "user", content: "Please continue" }, jwt);
      expect(messageRes.status).toBe(201);

      const noteTask = await createTask(env.DB, userId, { title: "AMA note task", board_id: boardId, assigned_to: agentId, metadata });
      await env.DB.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").bind(noteTask.id).run();
      const leaderJwt = await signLeaderSessionJWT();
      const noteRes = await apiRequest("POST", `/api/tasks/${noteTask.id}/notes`, { detail: "Leader says continue" }, leaderJwt);
      expect(noteRes.status).toBe(201);

      const workerNoteRes = await apiRequest("POST", `/api/tasks/${noteTask.id}/notes`, { detail: "Worker progress only" }, jwt);
      expect(workerNoteRes.status).toBe(201);

      const rejectTask = await createTask(env.DB, userId, { title: "AMA reject task", board_id: boardId, assigned_to: agentId, metadata });
      await env.DB.prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").bind(rejectTask.id).run();
      const rejectRes = await apiRequest("POST", `/api/tasks/${rejectTask.id}/reject`, { reason: "Fix tests" }, leaderJwt);
      expect(rejectRes.status).toBe(200);
      const rejected = (await rejectRes.json()) as any;
      expect(rejected.metadata.annotations).toMatchObject({ "ama.lastCommand": "reject_resume", "ama.lastCommand.result": "accepted" });

      const cancelTask = await createTask(env.DB, userId, { title: "AMA cancel task", board_id: boardId, assigned_to: agentId, metadata });
      await env.DB.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").bind(cancelTask.id).run();
      const cancelRes = await apiRequest("POST", `/api/tasks/${cancelTask.id}/cancel`, {}, leaderJwt);
      expect(cancelRes.status).toBe(200);
      const cancelled = (await cancelRes.json()) as any;
      // cancel stops AMA before mutating the task; after success the active
      // binding annotations are cleared and the AMA session id remains queryable.
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.metadata.annotations["ama.sessionId"]).toBe("session_123");
      expect(cancelled.metadata.annotations["ama.dispatch.result"]).toBeNull();

      expect(runtimeMessages).toEqual([
        "Please continue",
        "Leader says continue",
        expect.stringContaining("Task was rejected by reviewer. Reason: Fix tests"),
      ]);
      expect(runtimeMessages[2]).toContain("Fix the reviewer rejection");
      expect(runtimeMessages[2]).toContain(`ak task review ${rejectTask.id}`);
      expect(runtimeMessages[2]).not.toContain("Do not inspect files");
      expect(stops).toHaveLength(1);
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
    }
  });

  it("does not mutate task state when AMA reject or cancel command delivery fails", async () => {
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") {
        return jsonResponse({ access_token: "oauth-token" });
      }
      if (url === "https://ama.test/api/v1/sessions/session_failed/messages") {
        return jsonResponse({ error: "command failed" }, 502);
      }
      if (url === "https://ama.test/api/v1/sessions/session_failed" && reqMethod(input, init) === "PATCH") {
        return jsonResponse({ error: "stop failed" }, 502);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { createTask } = await import("../apps/web/server/taskRepo");
      const metadata = { annotations: { "ama.projectId": "project_123", "ama.sessionId": "session_failed" } };
      const rejectTarget = await createTask(env.DB, userId, { title: "Failed reject command", board_id: boardId, assigned_to: agentId, metadata });
      await env.DB.prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").bind(rejectTarget.id).run();
      const cancelTarget = await createTask(env.DB, userId, { title: "Failed cancel command", board_id: boardId, assigned_to: agentId, metadata });
      await env.DB.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").bind(cancelTarget.id).run();

      const leaderJwt = await signLeaderSessionJWT();
      const rejectRes = await apiRequest("POST", `/api/tasks/${rejectTarget.id}/reject`, { reason: "try again" }, leaderJwt);
      const cancelRes = await apiRequest("POST", `/api/tasks/${cancelTarget.id}/cancel`, {}, leaderJwt);
      expect(rejectRes.status).toBe(500);
      expect(cancelRes.status).toBe(500);

      const rejectRow = await env.DB.prepare("SELECT status FROM tasks WHERE id = ?").bind(rejectTarget.id).first<{ status: string }>();
      expect(rejectRow?.status).toBe("in_review");
      const cancelRow = await env.DB.prepare("SELECT status FROM tasks WHERE id = ?").bind(cancelTarget.id).first<{ status: string }>();
      expect(cancelRow?.status).toBe("in_progress");
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
    }
  });

  it("updates AMA runtime session usage and closes runtime sessions on terminal lifecycle states", async () => {
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") {
        return jsonResponse({ access_token: "oauth-token" });
      }
      if (url.startsWith("https://ama.test/api/v1/usage-records?")) {
        return jsonResponse({ data: [], pagination: { limit: 100, hasMore: false, nextCursor: null } });
      }
      if (url === "https://ama.test/api/v1/sessions/session_usage_123" && reqMethod(input, init) === "PATCH") {
        return jsonResponse({ id: "session_usage_123", state: "closed" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { createAmaAgentSession } = await import("../apps/web/server/agentSessionRepo");
      const runtimeSessionId = randomUUID();
      const keypair = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"]);
      const privateKey = (keypair as any).privateKey;
      const pubJwk = await crypto.subtle.exportKey("jwk", (keypair as any).publicKey);
      await createAmaAgentSession(env.DB, env, {
        ownerId: userId,
        agentId,
        sessionId: runtimeSessionId,
        sessionPublicKey: pubJwk.x!,
        amaSessionId: "session_usage_123",
      });
      const runtimeJwt = await new SignJWT({ sub: runtimeSessionId, aid: agentId, jti: randomUUID(), aud: BETTER_AUTH_URL })
        .setProtectedHeader({ alg: "EdDSA", typ: "agent+jwt" })
        .setIssuedAt()
        .setExpirationTime("60s")
        .sign(privateKey);
      const usageRes = await apiRequest(
        "PATCH",
        `/api/agents/${agentId}/sessions/${runtimeSessionId}/usage`,
        { input_tokens: 10, output_tokens: 20, cache_read_tokens: 3, cache_creation_tokens: 4, cost_micro_usd: 50 },
        runtimeJwt,
      );
      expect(usageRes.status).toBe(200);
      const usage = await env.DB.prepare("SELECT input_tokens, output_tokens, cost_micro_usd FROM ama_agent_sessions WHERE id = ?")
        .bind(runtimeSessionId)
        .first<{ input_tokens: number; output_tokens: number; cost_micro_usd: number }>();
      expect(usage).toMatchObject({ input_tokens: 10, output_tokens: 20, cost_micro_usd: 50 });

      const { createTask } = await import("../apps/web/server/taskRepo");
      const task = await createTask(env.DB, userId, {
        title: "Close runtime on complete",
        board_id: boardId,
        assigned_to: agentId,
        metadata: { annotations: { agentSessionId: runtimeSessionId, "ama.sessionId": "session_usage_123" } },
      });
      await env.DB.prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").bind(task.id).run();
      const leaderJwt = await signLeaderSessionJWT();
      const completeRes = await apiRequest("POST", `/api/tasks/${task.id}/complete`, {}, leaderJwt);
      expect(completeRes.status).toBe(200);
      const closed = await env.DB.prepare("SELECT status, closed_at FROM ama_agent_sessions WHERE id = ?")
        .bind(runtimeSessionId)
        .first<{ status: string; closed_at: string | null }>();
      expect(closed?.status).toBe("closed");
      expect(closed?.closed_at).toEqual(expect.any(String));
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
    }
  });

  it("GET /api/tasks/:id/session returns session metadata for a bound AMA session", async () => {
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") return jsonResponse({ access_token: "user-token" });
      if (url === "https://ama.test/api/v1/sessions/session_runtime_123") {
        return jsonResponse(amaSession("session_runtime_123", { projectId: "project_runtime_123", name: "Finished task", phase: "closed" }));
      }
      return jsonResponse({ error: "unexpected", url }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { createTask } = await import("../apps/web/server/taskRepo");
      const task = await createTask(env.DB, userId, {
        title: "AMA session metadata",
        board_id: boardId,
        metadata: { annotations: { "ama.sessionId": "session_runtime_123", "ama.projectId": "project_runtime_123" } },
      });
      const res = await apiRequest("GET", `/api/tasks/${task.id}/session`, undefined, apiKey);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        task_id: task.id,
        session_id: "session_runtime_123",
        project_id: "project_runtime_123",
        session: { id: "session_runtime_123", state: "closed" },
      });
    } finally {
      Object.assign(env, previousAma);
    }
  });

  it("GET /api/tasks/:id/session resolves a historical AMA session from the task action session", async () => {
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

    const akSessionId = "ak_session_history_123";
    const amaSessionId = "session_history_123";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") return jsonResponse({ access_token: "user-token" });
      if (url === `https://ama.test/api/v1/sessions/${amaSessionId}`) {
        return jsonResponse(amaSession(amaSessionId, { projectId: "project_runtime_123", name: "Finished task", phase: "closed" }));
      }
      return jsonResponse({ error: "unexpected", url }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { createTask, addTaskAction } = await import("../apps/web/server/taskRepo");
      const task = await createTask(env.DB, userId, {
        title: "Historical AMA session metadata",
        board_id: boardId,
        assigned_to: agentId,
        metadata: {
          annotations: {
            "ama.sessionId": null,
            "ama.projectId": "project_runtime_123",
            "ama.runtime": "claude-code",
            agentSessionId: null,
          },
        },
        skipRuntimeAvailability: true,
      });
      await addTaskAction(env.DB, task.id, "agent:worker", agentId, "claimed", null, akSessionId);
      await env.DB.prepare(
        `INSERT INTO ama_agent_sessions (id, owner_id, agent_id, ama_session_id, status, public_key, delegation_proof, created_at)
         VALUES (?, ?, ?, ?, 'closed', ?, ?, ?)`,
      )
        .bind(akSessionId, userId, agentId, amaSessionId, "session-public-key", "delegation-proof", new Date().toISOString())
        .run();

      const res = await apiRequest("GET", `/api/tasks/${task.id}/session`, undefined, apiKey);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        task_id: task.id,
        session_id: amaSessionId,
        ak_session_id: akSessionId,
        project_id: "project_runtime_123",
        session: { id: amaSessionId, state: "closed" },
      });
    } finally {
      Object.assign(env, previousAma);
    }
  });

  it("GET /api/tasks/:id/session/ws returns a browser socket URL for a bound AMA session", async () => {
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

    try {
      const { createTask } = await import("../apps/web/server/taskRepo");
      const task = await createTask(env.DB, userId, {
        title: "AMA runtime socket",
        board_id: boardId,
        metadata: { annotations: { "ama.sessionId": "session_runtime_123", "ama.projectId": "project_runtime_123" } },
      });
      const res = await apiRequest("GET", `/api/tasks/${task.id}/session/ws`, undefined, apiKey);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string };
      const url = new URL(body.url);
      expect(url.origin).toBe("wss://ama.test");
      expect(url.pathname).toBe("/api/v1/sessions/session_runtime_123/socket");
      expect(url.searchParams.get("access_token")).toBe("test.jwt.token");
      expect(url.searchParams.get("x-ama-project-id")).toBe("project_runtime_123");
    } finally {
      Object.assign(env, previousAma);
    }
  });

  it("GET /api/sessions/:sessionId returns an AMA session by session id", async () => {
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

    const sessionId = "session_direct_123";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = reqUrl(input);
        if (url === "https://auth.test/.well-known/openid-configuration") return jsonResponse({ access_token: "user-token" });
        if (url === `https://ama.test/api/v1/sessions/${sessionId}`) {
          return jsonResponse(amaSession(sessionId, { projectId: "project_direct_session", name: "Maintainer run", phase: "running" }));
        }
        return jsonResponse({ error: "unexpected", url }, 500);
      }),
    );

    try {
      await configureAmaOwnerRuntime(userId, "codex", "env_direct_session", "project_direct_session");
      const res = await apiRequest("GET", `/api/sessions/${sessionId}`, undefined, apiKey);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        session_id: sessionId,
        project_id: "project_direct_session",
        session: { id: sessionId, state: "running", title: "Maintainer run" },
      });
    } finally {
      Object.assign(env, previousAma);
    }
  });

  it("GET /api/sessions lists AMA sessions with a metadata label selector", async () => {
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
        const requestUrl = new URL(url);
        if (requestUrl.origin === "https://ama.test" && requestUrl.pathname === "/api/v1/sessions") {
          expect(requestUrl.searchParams.get("limit")).toBe("25");
          expect(requestUrl.searchParams.get("labelSelector")).toBe("maintainerId=maintainer_123");
          return jsonResponse({
            data: [
              amaSession("session_maintainer_123", {
                projectId: "project_session_list",
                phase: "idle",
                agentId: "ama_agent_123",
                labels: { maintainerId: "maintainer_123" },
                createdAt: "2026-06-08T12:00:00.000Z",
                updatedAt: "2026-06-08T12:08:00.000Z",
              }),
            ],
            pagination: { limit: 25, hasMore: false },
          });
        }
        return jsonResponse({ error: "unexpected", url }, 500);
      }),
    );

    try {
      await configureAmaOwnerRuntime(userId, "codex", "env_session_list", "project_session_list");
      const res = await apiRequest("GET", "/api/sessions?limit=25&labelSelector=maintainerId%3Dmaintainer_123", undefined, apiKey);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        data: [
          {
            id: "session_maintainer_123",
            createdAt: "2026-06-08T12:00:00.000Z",
            updatedAt: "2026-06-08T12:08:00.000Z",
            metadata: { labels: { maintainerId: "maintainer_123" } },
          },
        ],
        pagination: { limit: 25, hasMore: false },
      });
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
    }
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

  it("GET /api/tasks/:id/session/ws returns 404 when a task has no AMA session binding", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "No AMA runtime", board_id: boardId });
    const res = await apiRequest("GET", `/api/tasks/${task.id}/session/ws`, undefined, apiKey);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: { message: "Task is not bound to a session" },
    });
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

  it("local daemon APIs remain available once AMA dispatch is configured", async () => {
    const previous = {
      AMA_ORIGIN: env.AMA_ORIGIN,
      AMA_OIDC_ISSUER: env.AMA_OIDC_ISSUER,
      AMA_OIDC_CLIENT_ID: env.AMA_OIDC_CLIENT_ID,
      AMA_OIDC_CLIENT_SECRET: env.AMA_OIDC_CLIENT_SECRET,
      AK_API_URL: env.AK_API_URL,
    };
    Object.assign(env, {
      AMA_ORIGIN: "http://ama.test",
      AMA_OIDC_ISSUER: "https://auth.test",
      AMA_OIDC_CLIENT_ID: "ak-app",
      AMA_OIDC_CLIENT_SECRET: "ak-secret",
      AK_API_URL: "http://ak.test",
    });

    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = reqUrl(input);
          if (url === "https://auth.test/.well-known/openid-configuration") {
            return jsonResponse({ access_token: "oauth-token" });
          }
          if (url.startsWith("http://ama.test/api/v1/runners?environmentId=")) {
            return jsonResponse({ data: [] });
          }
          throw new Error(`Unexpected fetch: ${url}`);
        }),
      );
      const machinesRes = await apiRequest("GET", "/api/machines", undefined, apiKey);
      const sessionsRes = await apiRequest("GET", `/api/agents/${agentId}/sessions`, undefined, apiKey);

      expect(machinesRes.status).toBe(200);
      expect(machinesRes.headers.get("X-AK-Runtime-Surface")).toBe("local-daemon");
      expect(machinesRes.headers.get("Deprecation")).toBeNull();
      expect(machinesRes.headers.get("Sunset")).toBeNull();
      expect(Array.isArray(await machinesRes.json())).toBe(true);
      expect(sessionsRes.status).toBe(200);
      expect(sessionsRes.headers.get("X-AK-Runtime-Surface")).toBe("local-daemon");
      expect(sessionsRes.headers.get("Deprecation")).toBeNull();
      expect(sessionsRes.headers.get("Sunset")).toBeNull();
      expect(Array.isArray(await sessionsRes.json())).toBe(true);
    } finally {
      Object.assign(env, previous);
      vi.unstubAllGlobals();
    }
  });

  // ─── Machines ───

  it("GET /api/machines lists machines", async () => {
    const res = await apiRequest("GET", "/api/machines", undefined, apiKey);
    expect(res.status).toBe(200);
    expect(res.headers.get("Deprecation")).toBeNull();
    expect(res.headers.get("Sunset")).toBeNull();
    expect(res.headers.get("X-AK-Runtime-Surface")).toBe("local-daemon");
    const body = (await res.json()) as any;
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).not.toHaveProperty("ama_environment_id");
  });

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

  it("GET /api/machines/:id preserves usage_info while deriving status from AMA runners", async () => {
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
    await configureAmaOwnerRuntime(userId, "codex", "env_usage");
    const machine = await env.DB.prepare("SELECT id FROM machines WHERE owner_id = ? AND ama_environment_id = ?")
      .bind(userId, "env_usage")
      .first<{ id: string }>();
    const usageInfo = {
      windows: [{ runtime: "codex", label: "Daily", utilization: 42, resets_at: "2026-06-09T00:00:00.000Z" }],
      updated_at: "2026-06-08T12:00:00.000Z",
    };
    await env.DB.prepare("UPDATE machines SET usage_info = ? WHERE id = ?").bind(JSON.stringify(usageInfo), machine!.id).run();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = reqUrl(input);
        if (url === "https://auth.test/.well-known/openid-configuration") {
          return jsonResponse({ access_token: "oauth-token" });
        }
        if (url === "https://ama.test/api/v1/runners?environmentId=env_usage&limit=100") {
          return jsonResponse({
            data: [
              {
                id: "runner_usage",
                environmentId: "env_usage",
                state: "active",
                runtimes: [
                  {
                    runtime: "codex",
                    models: ["gpt-5.3-codex"],
                    state: "limited",
                    detail: "Weekly quota nearly exhausted",
                  },
                ],
                currentLoad: 2,
                maxConcurrent: 5,
                lastHeartbeatAt: new Date().toISOString(),
              },
            ],
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    try {
      const res = await apiRequest("GET", `/api/machines/${machine!.id}`, undefined, apiKey);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.status).toBe("online");
      expect(body.usage_info).toEqual(usageInfo);
      expect(body.active_session_count).toBe(2);
      expect(body.runner_capacity).toBe(5);
      expect(body.runtimes).toContainEqual(expect.objectContaining({ name: "codex", status: "limited", detail: "Weekly quota nearly exhausted" }));
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
    }
  });

  it("GET /api/machines/:id merges fresh legacy runtimes that active AMA runners do not expose", async () => {
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
    await configureAmaOwnerRuntime(userId, "codex", "env_mixed_runtime");
    const machine = await env.DB.prepare("SELECT id FROM machines WHERE owner_id = ? AND ama_environment_id = ?")
      .bind(userId, "env_mixed_runtime")
      .first<{ id: string }>();
    const legacyHeartbeat = new Date().toISOString();
    await env.DB.prepare("UPDATE machines SET runtimes = ?, status = 'online', last_heartbeat_at = ? WHERE id = ?")
      .bind(
        JSON.stringify([
          { name: "claude", status: "ready", checked_at: legacyHeartbeat },
          { name: "codex", status: "ready", checked_at: legacyHeartbeat },
        ]),
        legacyHeartbeat,
        machine!.id,
      )
      .run();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = reqUrl(input);
        if (url === "https://ama.test/api/v1/runners?environmentId=env_mixed_runtime&limit=100") {
          return jsonResponse({
            data: [
              {
                id: "runner_mixed_runtime",
                environmentId: "env_mixed_runtime",
                state: "active",
                runtimes: [{ runtime: "codex", models: [], state: "ready", detail: "Codex CLI available" }],
                currentLoad: 0,
                maxConcurrent: 2,
                lastHeartbeatAt: new Date(Date.now() - 10_000).toISOString(),
              },
            ],
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    try {
      const res = await apiRequest("GET", `/api/machines/${machine!.id}`, undefined, apiKey);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.runtimes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "claude", status: "ready" }),
          expect.objectContaining({ name: "codex", status: "ready" }),
        ]),
      );
      expect(body.last_heartbeat_at).toBe(legacyHeartbeat);
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
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

  it("GET /api/agents/:agentId/sessions includes AMA runtime sessions", async () => {
    const runtimeSessionId = randomUUID();
    await env.DB.prepare(
      `INSERT INTO ama_agent_sessions (
        id, owner_id, agent_id, ama_session_id, status, public_key, delegation_proof, created_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
      .bind(runtimeSessionId, userId, agentId, "ama_session_routes", "public-key", "delegation-proof", new Date().toISOString())
      .run();

    const res = await apiRequest("GET", `/api/agents/${agentId}/sessions`, undefined, apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: runtimeSessionId,
          agent_id: agentId,
          machine_id: `ama-runtime-${userId}`,
          machine_name: "AMA runtime",
          runtime_source: "ama",
        }),
      ]),
    );
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
