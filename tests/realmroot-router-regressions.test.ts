// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "../apps/web/server/routes";
import { createTestAgent, createTestEnv, createTestSubagent, createTestWebSession, seedUser, setupMiniflare } from "./helpers/db";

const tenantId = "tenant-router-regressions";
const issuer = "https://id.realmroot.dev/api/auth";
const resource = "http://localhost:8788/api";
const jwksUri = `${issuer}/jwks`;
const issuerKeysPromise = generateKeyPair("ES256", { extractable: true });
const env = createTestEnv();
let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let authority: Awaited<ReturnType<typeof createTestWebSession>>;
let boardId: string;
let machineId: string;
let leaderRealmrootId: string;
let issuerPublicJwk: JsonWebKey;

async function request(
  method: string,
  path: string,
  body?: unknown,
  options: { machineId?: string; headers?: HeadersInit; agent?: { realmrootId: string; scopes: string[] } } = {},
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    host: "localhost:8788",
    "x-forwarded-proto": "http",
    ...options.headers,
  });
  if (options.agent) {
    const agentHeaders = await realmrootAgentHeaders(method, path, options.agent);
    for (const [name, value] of Object.entries(agentHeaders)) headers.set(name, value);
  } else {
    headers.set("cookie", authority.cookie);
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") headers.set("x-csrf-token", authority.csrfToken);
  }
  if (options.machineId) headers.set("x-ak-machine-id", options.machineId);
  return api.request(
    path,
    {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
}

beforeAll(async () => {
  ({ mf, db: env.DB } = await setupMiniflare());
  env.AK_RESOURCE = resource;
  await seedUser(env.DB, tenantId, "router-regressions@example.test");
  authority = await createTestWebSession(env.DB, tenantId, { subjectId: "router-native-subject" });

  const issuerKeys = await issuerKeysPromise;
  issuerPublicJwk = await exportJWK(issuerKeys.publicKey);
  issuerPublicJwk.kid = "router-regression-key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: RequestInfo | URL) => {
      const url = target instanceof Request ? target.url : String(target);
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`,
          jwks_uri: jwksUri,
          id_token_signing_alg_values_supported: ["ES256"],
        });
      }
      if (url === jwksUri) return Response.json({ keys: [issuerPublicJwk] });
      throw new Error(`Unexpected router regression request: ${url}`);
    }),
  );

  const board = await request("POST", "/api/boards", { name: "Router regression board", type: "ops" });
  expect(board.status).toBe(201);
  boardId = ((await board.json()) as { id: string }).id;

  const machine = await request("POST", "/api/machines", {
    name: "Router regression machine",
    os: "darwin",
    version: "1.0.0",
    device_id: "router-regression-device",
    runtimes: [{ name: "codex", status: "ready", checked_at: new Date().toISOString() }],
  });
  expect(machine.status).toBe(201);
  machineId = ((await machine.json()) as { id: string }).id;

  const leader = await createTestAgent(env.DB, tenantId, {
    username: `router-leader-${randomUUID().slice(0, 8)}`,
    runtime: "claude",
    kind: "leader",
  });
  leaderRealmrootId = leader.realmroot_agent_id!;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await mf.dispose();
});

describe("Realmroot real-router Agent regressions", () => {
  it("filters Agent profiles and rejects invalid filter values", async () => {
    await createTestAgent(env.DB, tenantId, {
      username: `router-filter-claude-${randomUUID()}`,
      runtime: "claude",
      role: "router-filter",
    });
    await createTestAgent(env.DB, tenantId, {
      username: `router-filter-copilot-${randomUUID()}`,
      runtime: "copilot",
      role: "router-filter",
    });

    const filtered = await request("GET", "/api/agents?kind=worker&role=router-filter&runtime=claude");
    expect(filtered.status).toBe(200);
    const agents = (await filtered.json()) as Array<{ runtime: string; role: string; kind: string }>;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ runtime: "claude", role: "router-filter", kind: "worker" });

    for (const query of ["role=BadRole", "kind=manager", "available=yes", "runtime=unknown-runtime"]) {
      expect((await request("GET", `/api/agents?${query}`)).status, query).toBe(400);
    }
  });

  it("lists only the latest snapshot for a versioned Agent username", async () => {
    const username = `router-version-${randomUUID().slice(0, 8)}`;
    const realmrootAgentId = `rr:${username}`;
    const first = await request("POST", "/api/agents", {
      username,
      runtime: "codex",
      role: "implementation",
      soul: "historical soul",
      realmroot_agent_id: realmrootAgentId,
    });
    expect(first.status, await first.clone().text()).toBe(201);
    const second = await request("POST", "/api/agents", {
      username,
      runtime: "codex",
      role: "implementation",
      soul: "latest soul",
      realmroot_agent_id: realmrootAgentId,
    });
    expect(second.status, await second.clone().text()).toBe(201);

    const listed = await request("GET", "/api/agents");
    const matching = ((await listed.json()) as Array<{ username: string; soul: string | null; version: string | null }>).filter(
      (agent) => agent.username === username,
    );
    expect(matching).toEqual([expect.objectContaining({ soul: "latest soul", version: "latest" })]);

    const rows = await env.DB.prepare("SELECT id, version, soul FROM agents WHERE owner_id = ? AND username = ? ORDER BY version")
      .bind(tenantId, username)
      .all<{ id: string; version: string; soul: string | null }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.filter(({ version }) => version === "latest")).toHaveLength(1);

    const snapshot = rows.results.find(({ version }) => version !== "latest")!;
    expect((await request("PATCH", `/api/agents/${snapshot.id}`, { soul: "forbidden snapshot edit" })).status).toBe(409);
    expect((await request("DELETE", `/api/agents/${snapshot.id}`)).status).toBe(409);

    const latestId = rows.results.find(({ version }) => version === "latest")!.id;
    expect((await request("DELETE", `/api/agents/${latestId}`)).status).toBe(200);
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM agents WHERE owner_id = ? AND username = ?").bind(tenantId, username).first(),
    ).resolves.toEqual({
      count: 0,
    });
  });

  it("keeps the model catalog contract explicit for validation and standalone runtimes", async () => {
    expect((await request("GET", "/api/models")).status).toBe(400);
    expect((await request("GET", "/api/models?runtime=not-a-runtime")).status).toBe(400);

    const models = await request("GET", "/api/models?runtime=codex");
    expect(models.status).toBe(200);
    await expect(models.json()).resolves.toEqual([]);
  });

  it("accepts registered subagents and rejects nonexistent, cross-tenant, and self references", async () => {
    const registered = await createTestSubagent(env.DB, tenantId, {
      username: `router-subagent-${randomUUID()}`,
      models: { copilot: "gpt-5" },
    });
    const ownerAgent = await createTestAgent(env.DB, tenantId, {
      username: `router-subagent-owner-${randomUUID()}`,
      runtime: "copilot",
    });
    const otherTenant = `tenant-router-other-${randomUUID()}`;
    const foreign = await createTestSubagent(env.DB, otherTenant, {
      username: `foreign-subagent-${randomUUID()}`,
      models: { copilot: "gpt-5" },
    });

    const accepted = await request("PATCH", `/api/agents/${ownerAgent.id}`, { subagents: [registered.id] });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ subagents: [registered.id] });

    for (const subagentId of ["missing-subagent", foreign.id, ownerAgent.id]) {
      const rejected = await request("PATCH", `/api/agents/${ownerAgent.id}`, { subagents: [subagentId] });
      expect(rejected.status, subagentId).toBe(400);
    }
  });
});

describe("Realmroot real-router task and stream regressions", () => {
  it("preserves task CRUD, validation, and not-found behavior", async () => {
    const agent = { realmrootId: leaderRealmrootId, scopes: ["task:log", "task:cancel"] };
    const invalid = await request("POST", "/api/tasks", { board_id: boardId }, { agent });
    expect(invalid.status, await invalid.clone().text()).toBe(400);

    const created = await request("POST", "/api/tasks", { title: "Router CRUD task", board_id: boardId, detail: "Original detail" }, { agent });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string; description: string; status: string };
    expect(task).toMatchObject({ description: "Original detail", status: "todo" });

    const updated = await request("PATCH", `/api/tasks/${task.id}`, { detail: "Updated detail" }, { agent });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ description: "Updated detail" });

    const fetched = await request("GET", `/api/tasks/${task.id}`);
    expect(fetched.status).toBe(200);
    const deleted = await request("DELETE", `/api/tasks/${task.id}`, undefined, { agent });
    expect(deleted.status).toBe(200);
    expect((await request("GET", `/api/tasks/${task.id}`)).status).toBe(404);
    expect((await request("PATCH", "/api/tasks/missing-task", { title: "missing" }, { agent })).status).toBe(404);
  });

  it("keeps human review lifecycle transitions on the real router", async () => {
    const first = await createTaskInState("Router complete lifecycle", "in_review");
    const completed = await request("POST", `/api/tasks/${first}/complete`);
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({ id: first, status: "done" });

    const second = await createTaskInState("Router reject lifecycle", "in_review");
    const rejected = await request("POST", `/api/tasks/${second}/reject`, { reason: "needs revision" });
    expect(rejected.status).toBe(200);
    await expect(rejected.json()).resolves.toMatchObject({ id: second, status: "in_progress" });

    const third = await createTaskInState("Router cancel lifecycle", "in_progress");
    const cancelled = await request("POST", `/api/tasks/${third}/cancel`);
    expect(cancelled.status).toBe(200);
    await expect(cancelled.json()).resolves.toMatchObject({ id: third, status: "cancelled" });
  });

  it("creates and lists task notes and messages", async () => {
    const taskId = await createTaskInState("Router notes and messages", "todo");
    const note = await request(
      "POST",
      `/api/tasks/${taskId}/notes`,
      { detail: "Realmroot note" },
      {
        agent: { realmrootId: leaderRealmrootId, scopes: ["task:log"] },
      },
    );
    expect(note.status, await note.clone().text()).toBe(201);
    const notes = await request("GET", `/api/tasks/${taskId}/notes`);
    expect(notes.status).toBe(200);
    expect(await notes.json()).toEqual(expect.arrayContaining([expect.objectContaining({ detail: "Realmroot note" })]));

    const message = await request("POST", `/api/tasks/${taskId}/messages`, {
      sender_type: "agent",
      sender_id: "realmroot-agent",
      content: "Realmroot message",
    });
    expect(message.status).toBe(201);
    const messages = await request("GET", `/api/tasks/${taskId}/messages`);
    expect(messages.status).toBe(200);
    expect(await messages.json()).toEqual(expect.arrayContaining([expect.objectContaining({ content: "Realmroot message" })]));
  });

  it("opens the task SSE stream for the owned task", async () => {
    const taskId = await createTaskInState("Router SSE task", "todo");
    const response = await request("GET", `/api/tasks/${taskId}/stream`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");
    await response.body?.cancel();
  });
});

describe("Realmroot real-router machine and Agent session regressions", () => {
  it("rejects malformed machine runtime input without persisting a machine", async () => {
    for (const runtimes of [
      [{ name: "codex", status: "invalid", checked_at: new Date().toISOString() }],
      [{ name: "not-a-runtime", status: "ready", checked_at: new Date().toISOString() }],
    ]) {
      const deviceId = `invalid-${randomUUID()}`;
      const response = await request("POST", "/api/machines", {
        name: "Invalid machine",
        os: "linux",
        version: "1",
        device_id: deviceId,
        runtimes,
      });
      expect(response.status).toBe(400);
      await expect(
        env.DB.prepare("SELECT id FROM machines WHERE owner_id = ? AND device_id = ?").bind(tenantId, deviceId).first(),
      ).resolves.toBeNull();
    }
  });

  it("marks a stale machine offline while preserving its persisted usage", async () => {
    await env.DB.prepare("UPDATE machines SET status = 'online', last_heartbeat_at = ?, usage_info = ? WHERE id = ?")
      .bind(
        "2020-01-01T00:00:00.000Z",
        JSON.stringify({ provider: "codex", windows: [{ label: "5h", utilization: 0.42, resets_at: null }] }),
        machineId,
      )
      .run();

    const response = await request("GET", `/api/machines/${machineId}`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: machineId,
      status: "offline",
      usage_info: { provider: "codex", windows: [{ label: "5h", utilization: 42, resets_at: null }] },
    });
  });

  it("creates, lists, closes, and reopens an owned Agent session through the bound Native machine", async () => {
    const agent = await createTestAgent(env.DB, tenantId, {
      username: `router-session-agent-${randomUUID()}`,
      runtime: "codex",
    });
    const sessionId = `router-session-${randomUUID()}`;
    const created = await request(
      "POST",
      `/api/agents/${agent.id}/sessions`,
      { session_id: sessionId, session_public_key: "test-session-public-key", machine_id: machineId },
      { machineId },
    );
    expect(created.status).toBe(201);

    const listed = await request("GET", `/api/agents/${agent.id}/sessions`, undefined, { machineId });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: sessionId, status: "active" })]));

    const closed = await request("DELETE", `/api/agents/${agent.id}/sessions/${sessionId}`, undefined, { machineId });
    expect(closed.status).toBe(200);
    await expect(closed.json()).resolves.toEqual({ ok: true });
    await expect(env.DB.prepare("SELECT status FROM agent_sessions WHERE id = ?").bind(sessionId).first()).resolves.toEqual({ status: "closed" });

    const reopened = await request("POST", `/api/agents/${agent.id}/sessions/${sessionId}/reopen`, undefined, { machineId });
    expect(reopened.status).toBe(200);
    await expect(reopened.json()).resolves.toEqual({ ok: true });
    await expect(env.DB.prepare("SELECT status, closed_at FROM agent_sessions WHERE id = ?").bind(sessionId).first()).resolves.toEqual({
      status: "active",
      closed_at: null,
    });
  });

  it("validates required Agent session fields", async () => {
    const agent = await createTestAgent(env.DB, tenantId, {
      username: `router-session-validation-${randomUUID()}`,
      runtime: "codex",
    });
    for (const body of [{}, { session_id: `missing-key-${randomUUID()}` }]) {
      const response = await request("POST", `/api/agents/${agent.id}/sessions`, body, { machineId });
      expect(response.status).toBe(400);
    }
  });
});

describe("Realmroot real-router AMA regressions", () => {
  let maintainerAgent: Awaited<ReturnType<typeof createTestAgent>>;
  const calls: Request[] = [];
  const triggers = new Map<string, Record<string, unknown>>();
  let triggerSequence = 0;

  beforeAll(async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    const machineAccessToken = await new SignJWT({ scope: "projects:read projects:write" })
      .setProtectedHeader({ alg: "ES256" })
      .setExpirationTime("10m")
      .sign(privateKey);
    Object.assign(env, {
      AMA_ORIGIN: "https://ama.router.test",
      AMA_RESOURCE: "https://ama.router.test",
      AMA_MACHINE_CLIENT_ID: "ak-router-maintainer",
      AMA_MACHINE_CLIENT_SECRET: "router-secret",
      AMA_MACHINE_SCOPES: "projects:read projects:write",
      AMA_DPOP_PRIVATE_JWK: JSON.stringify(privateJwk),
      AK_API_URL: "https://ak.router.test",
    });
    await env.DB.prepare(
      `INSERT INTO ama_owner_integrations (tenant_id, ama_project_id, session_secret_vault_id, metadata)
       VALUES (?, 'project-router', 'session-vault-router', '{}')`,
    )
      .bind(tenantId)
      .run();
    maintainerAgent = await createTestAgent(env.DB, tenantId, {
      username: `router-maintainer-${randomUUID().slice(0, 8)}`,
      runtime: "codex",
      role: "board-maintainer",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        calls.push(req.clone());
        const url = new URL(req.url);
        if (url.href === `${issuer}/.well-known/openid-configuration`) {
          return Response.json({
            issuer,
            authorization_endpoint: `${issuer}/oauth2/authorize`,
            token_endpoint: `${issuer}/oauth2/token`,
            jwks_uri: jwksUri,
            id_token_signing_alg_values_supported: ["ES256"],
          });
        }
        if (url.href === jwksUri) return Response.json({ keys: [issuerPublicJwk] });
        if (url.href === `${issuer}/oauth2/token`) {
          return Response.json({ access_token: machineAccessToken, token_type: "DPoP", expires_in: 600 });
        }
        if (url.origin !== "https://ama.router.test") throw new Error(`Unexpected maintainer request: ${url.href}`);
        const amaHeaders = Object.fromEntries(req.headers);
        expect(amaHeaders).toMatchObject({
          authorization: `DPoP ${machineAccessToken}`,
          dpop: expect.any(String),
          "x-ak-tenant-id": tenantId,
        });
        if (url.pathname !== "/api/v1/providers/models") {
          expect(amaHeaders["x-ama-project-id"]).toBe("project-router");
        }
        if (url.pathname === "/api/v1/projects/project-router" && req.method === "GET") {
          return jsonResponse({ metadata: { uid: "project-router", name: "Router project" }, spec: {}, status: {} });
        }
        if (url.pathname === "/api/v1/providers/models" && req.method === "GET") {
          return jsonResponse({
            data: [
              { providerId: "meta", modelId: "disabled-model", displayName: "Disabled", availability: "disabled" },
              { providerId: "openai", modelId: "@cf/openai/gpt-oss-120b", displayName: "GPT-OSS", availability: "available" },
              { providerId: "anthropic", modelId: "anthropic/claude-haiku-4-5", displayName: "Claude Haiku", availability: "available" },
            ],
            pagination: {},
          });
        }
        if (url.pathname === "/api/v1/runners" && url.searchParams.get("environmentId") === "env-router") {
          return jsonResponse({
            data: [
              {
                id: "runner-router",
                environmentId: "env-router",
                state: "active",
                runtimes: [{ runtime: "codex", models: ["gpt-5.3-codex"], state: "ready" }],
                currentLoad: 0,
                maxConcurrent: 2,
                lastHeartbeatAt: new Date().toISOString(),
              },
            ],
            pagination: {},
          });
        }
        if (url.pathname === "/api/v1/vaults/session-vault-router/credentials" && req.method === "POST") {
          return jsonResponse({ metadata: { uid: "runtime-credential-router" }, spec: {}, status: { activeVersionId: "version-router" } }, 201);
        }
        if (url.pathname === "/api/v1/sessions" && req.method === "POST") {
          return jsonResponse({ error: "runtime unavailable", internal: "must not leak" }, 503);
        }
        if (url.pathname === "/api/v1/sessions" && req.method === "GET") {
          return jsonResponse({ data: [amaSessionResponse("session-descriptor-router")], pagination: {} });
        }
        if (url.pathname === "/api/v1/sessions/session-descriptor-router" && req.method === "GET") {
          return jsonResponse(amaSessionResponse("session-descriptor-router"));
        }
        if (url.pathname === `/api/v1/agents/ama-agent-${maintainerAgent.id}`) {
          const body = req.method === "PATCH" ? await requestJson(req) : {};
          return jsonResponse({
            metadata: { uid: `ama-agent-${maintainerAgent.id}`, projectId: "project-router", name: maintainerAgent.username },
            spec: {
              provider: "openai",
              model: "gpt-5.3-codex",
              systemPrompt: "",
              skills: [],
              subagents: [],
              allowedTools: [],
              mcpConnectors: [],
              ...(body.spec as object | undefined),
            },
            status: {},
          });
        }
        if (url.pathname === "/api/v1/vaults" && req.method === "POST") {
          return jsonResponse({
            metadata: { uid: "board-vault-router", projectId: "project-router", name: "board-vault", description: null, archivedAt: null },
            spec: { scope: "project" },
            status: {},
          });
        }
        if (url.pathname === "/api/v1/vaults/board-vault-router/credentials" && req.method === "GET") {
          return jsonResponse({ data: [], pagination: {} });
        }
        if (url.pathname === "/api/v1/memory-stores" && req.method === "POST") {
          return jsonResponse({
            metadata: { uid: "memory-router", projectId: "project-router", name: "memory-router", description: null, archivedAt: null },
            spec: {},
            status: {},
          });
        }
        if (url.pathname === "/api/v1/memory-stores/memory-router" && req.method === "PATCH") {
          return jsonResponse({
            metadata: {
              uid: "memory-router",
              projectId: "project-router",
              name: "memory-router",
              description: null,
              archivedAt: new Date().toISOString(),
            },
            spec: {},
            status: {},
          });
        }
        if (url.pathname === "/api/v1/triggers" && req.method === "POST") {
          const body = await requestJson(req);
          const id = `trigger-router-${++triggerSequence}`;
          const trigger = {
            metadata: { uid: id, projectId: "project-router", name: (body.metadata as { name?: string })?.name ?? id, archivedAt: null },
            spec: body.spec,
            status: { lastDispatchedAt: null, lastRunId: null },
          };
          triggers.set(id, trigger);
          return jsonResponse(trigger, 201);
        }
        if (/^\/api\/v1\/triggers\/trigger-router-\d+\/runs$/.test(url.pathname) && req.method === "GET") {
          return jsonResponse({ data: [], pagination: {} });
        }
        const triggerMatch = url.pathname.match(/^\/api\/v1\/triggers\/(trigger-router-\d+)$/);
        if (triggerMatch) {
          const id = triggerMatch[1];
          const trigger = triggers.get(id);
          if (!trigger) return jsonResponse({ error: "not found" }, 404);
          if (req.method === "GET") return jsonResponse(trigger);
          if (req.method === "DELETE") {
            triggers.delete(id);
            return new Response(null, { status: 204 });
          }
          if (req.method === "PATCH") {
            const body = await requestJson(req);
            const previous = trigger as { metadata: Record<string, unknown>; spec: Record<string, unknown>; status: Record<string, unknown> };
            const next = {
              ...previous,
              metadata: { ...previous.metadata, ...((body.metadata as object | undefined) ?? {}) },
              spec: { ...previous.spec, ...((body.spec as object | undefined) ?? {}) },
            };
            triggers.set(id, next);
            return jsonResponse(next);
          }
        }
        throw new Error(`Unexpected maintainer request: ${req.method} ${url.href}`);
      }),
    );
  });

  it("discovers the AMA model catalog and merges live runner runtime state", async () => {
    const catalog = await request("GET", "/api/models?runtime=ama");
    expect(catalog.status, await catalog.clone().text()).toBe(200);
    await expect(catalog.json()).resolves.toEqual([
      { id: "anthropic/claude-haiku-4-5", name: "Claude Haiku" },
      { id: "@cf/openai/gpt-oss-120b", name: "GPT-OSS" },
    ]);

    const { upsertMachine } = await import("../apps/web/server/machineRepo");
    const amaMachine = await upsertMachine(env.DB, tenantId, {
      name: "AMA merged runtime machine",
      os: "linux",
      version: "1",
      device_id: `ama-runtime-merge-${randomUUID()}`,
      runtimes: [
        { name: "claude", status: "ready", checked_at: new Date().toISOString() },
        { name: "codex", status: "ready", checked_at: new Date().toISOString() },
      ],
    });
    await env.DB.prepare("UPDATE machines SET ama_environment_id = ? WHERE id = ?").bind("env-router", amaMachine.id).run();
    const mergedMachine = await request("GET", `/api/machines/${amaMachine.id}`);
    expect(mergedMachine.status, await mergedMachine.clone().text()).toBe(200);
    await expect(mergedMachine.json()).resolves.toMatchObject({
      id: amaMachine.id,
      status: "online",
      runtimes: expect.arrayContaining([expect.objectContaining({ name: "codex", status: "ready" })]),
    });
  });

  it("rolls back task assignment atomically when AMA session dispatch fails", async () => {
    const dispatchTask = await createTaskInState("Router AMA assignment rollback", "todo");
    const originalMetadata = { annotations: { retained: "original" }, request: { source: "router-regression" } };
    await env.DB.prepare("UPDATE tasks SET metadata = ? WHERE id = ?").bind(JSON.stringify(originalMetadata), dispatchTask).run();
    const assign = await request(
      "POST",
      `/api/tasks/${dispatchTask}/assign`,
      { agent_id: maintainerAgent.id },
      {
        agent: { realmrootId: leaderRealmrootId, scopes: ["task:assign"] },
      },
    );
    expect(assign.status, await assign.clone().text()).toBe(500);
    expect(await assign.text()).not.toContain("must not leak");
    await expect(
      env.DB.prepare("SELECT assigned_to, metadata FROM tasks WHERE id = ?")
        .bind(dispatchTask)
        .first<{ assigned_to: string | null; metadata: string }>(),
    ).resolves.toEqual({ assigned_to: null, metadata: JSON.stringify(originalMetadata) });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM task_actions WHERE task_id = ? AND action = 'assigned'").bind(dispatchTask).first(),
    ).resolves.toEqual({ count: 0 });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM ama_agent_sessions WHERE agent_id = ? AND status = 'active'").bind(maintainerAgent.id).first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("returns task and tenant AMA session and WebSocket descriptors", async () => {
    const descriptorTaskId = await createTaskInState("Router AMA session descriptors", "todo");
    await env.DB.prepare("UPDATE tasks SET metadata = ? WHERE id = ?")
      .bind(JSON.stringify({ annotations: { "ama.sessionId": "session-descriptor-router", "ama.projectId": "project-router" } }), descriptorTaskId)
      .run();
    const taskSession = await request("GET", `/api/tasks/${descriptorTaskId}/session`);
    expect(taskSession.status, await taskSession.clone().text()).toBe(200);
    await expect(taskSession.json()).resolves.toMatchObject({
      task_id: descriptorTaskId,
      session_id: "session-descriptor-router",
      project_id: "project-router",
      session: { id: "session-descriptor-router", status: "idle" },
    });
    const taskSocket = await request("GET", `/api/tasks/${descriptorTaskId}/session/ws`);
    expect(taskSocket.status).toBe(200);
    await expect(taskSocket.json()).resolves.toEqual({ url: "wss://ak.router.test/api/ama/sessions/session-descriptor-router/socket" });
    const sessions = await request("GET", "/api/sessions?labelSelector=kind%3Drouter");
    expect(sessions.status).toBe(200);
    await expect(sessions.json()).resolves.toMatchObject({ data: [expect.objectContaining({ id: "session-descriptor-router" })] });
    expect((await request("GET", "/api/sessions/session-descriptor-router")).status).toBe(200);
    const sessionSocket = await request("GET", "/api/sessions/session-descriptor-router/ws");
    expect(sessionSocket.status).toBe(200);
    await expect(sessionSocket.json()).resolves.toEqual({ url: "wss://ak.router.test/api/ama/sessions/session-descriptor-router/socket" });
  });

  it("creates, lists, updates, and deletes a maintainer with tenant and project context", async () => {
    const created = await request("POST", `/api/boards/${boardId}/maintainers`, {
      agent_id: maintainerAgent.id,
      interval_seconds: 3600,
      heartbeat_enabled: true,
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const maintainer = (await created.json()) as { id: string; status: string; interval_seconds: number };
    expect(maintainer).toMatchObject({ status: "active", interval_seconds: 3600 });

    const listed = await request("GET", `/api/boards/${boardId}/maintainers`);
    expect(listed.status, await listed.clone().text()).toBe(200);
    expect(await listed.json()).toEqual([expect.objectContaining({ id: maintainer.id, agent_id: maintainerAgent.id })]);

    const updated = await request("PATCH", `/api/boards/${boardId}/maintainers/${maintainer.id}`, {
      interval_seconds: 7200,
      heartbeat_enabled: false,
      status: "paused",
    });
    expect(updated.status, await updated.clone().text()).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ id: maintainer.id, status: "paused", interval_seconds: 7200, heartbeat_enabled: false });

    const deleted = await request("DELETE", `/api/boards/${boardId}/maintainers/${maintainer.id}`);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ ok: true });
    expect(await env.DB.prepare("SELECT id FROM board_maintainers WHERE id = ?").bind(maintainer.id).first()).toBeNull();
    expect(calls.filter((call) => call.url.startsWith("https://ama.router.test/"))).not.toHaveLength(0);
  });
});

async function createTaskInState(title: string, state: "todo" | "in_progress" | "in_review"): Promise<string> {
  const { createTask } = await import("../apps/web/server/taskRepo");
  const task = await createTask(env.DB, tenantId, { title, board_id: boardId });
  if (state !== "todo") {
    await env.DB.prepare("UPDATE tasks SET status = ? WHERE id = ?").bind(state, task.id).run();
  }
  return task.id;
}

async function realmrootAgentHeaders(
  method: string,
  path: string,
  authorityInput: { realmrootId: string; scopes: string[] },
): Promise<Record<string, string>> {
  const issuerKeys = await issuerKeysPromise;
  const dpopKeys = await generateKeyPair("ES256", { extractable: true });
  const dpopPublicJwk = await exportJWK(dpopKeys.publicKey);
  const thumbprint = await calculateJwkThumbprint(dpopPublicJwk);
  const accessToken = await new SignJWT({
    scope: authorityInput.scopes.join(" "),
    client_id: "realmroot-cli",
    cnf: { jkt: thumbprint },
    act: { sub: authorityInput.realmrootId, sub_profile: "ai_agent" },
    "urn:realmroot:params:oauth:org": tenantId,
  })
    .setProtectedHeader({ alg: "ES256", kid: "router-regression-key", typ: "at+jwt" })
    .setIssuer(issuer)
    .setAudience(resource)
    .setSubject("router-controller")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(issuerKeys.privateKey);
  const proof = await new SignJWT({
    htu: `http://localhost${path}`,
    htm: method.toUpperCase(),
    ath: createHash("sha256").update(accessToken).digest("base64url"),
  })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: dpopPublicJwk })
    .setJti(randomUUID())
    .setIssuedAt()
    .sign(dpopKeys.privateKey);
  return { authorization: `DPoP ${accessToken}`, dpop: proof };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function requestJson(requestValue: Request): Promise<Record<string, unknown>> {
  return JSON.parse(await requestValue.clone().text()) as Record<string, unknown>;
}

function amaSessionResponse(id: string) {
  const now = new Date().toISOString();
  return {
    metadata: {
      uid: id,
      projectId: "project-router",
      name: id,
      labels: { kind: "router" },
      annotations: {},
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    spec: { agentId: "ama-agent-router", environmentId: "env-router", runtime: "codex" },
    status: { phase: "idle", reason: null },
  };
}
