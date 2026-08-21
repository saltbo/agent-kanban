// @vitest-environment node

/**
 * Tests for GitHub webhook handling:
 *  1. verifyGithubSignature — valid/invalid/malformed header
 *  2. POST /api/webhooks/github-app route — HMAC verification, event routing, task transitions
 *  3. handleGithubPullRequestEvent — merged/closed/skipped scenarios
 */

import { randomUUID } from "node:crypto";
import { AK_ANNOTATION_KEY_SOURCE_EVENT, AK_ANNOTATION_KEY_SOURCE_URL, AK_LABEL_KEY_GITHUB_SUBJECT } from "@agent-kanban/shared";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestAgent, seedUser, setupMiniflare } from "./helpers/db";

vi.mock("../apps/web/server/realmrootMachineAuth", () => ({
  createAmaMachineAuthorizer: () => async () => ({ accessToken: "test.jwt.token", dpopProof: "test-dpop-proof" }),
  invalidateAmaMachineToken: vi.fn(),
}));

const WEBHOOK_SECRET = "test-webhook-secret-xyz";

let db: D1Database;
let mf: Miniflare;

// hey-api's fetch client calls fetch(request) with a single Request object,
// not fetch(url, init). These helpers normalise both call signatures so mocks
// can read url, method, and body regardless of which form is used.
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

function amaTriggerRun(
  id: string,
  input: {
    projectId: string;
    triggerId: string;
    phase?: string;
    sessionId?: string | null;
    triggeredAt?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  const now = input.triggeredAt ?? "2026-06-09T01:02:03.000Z";
  return {
    metadata: {
      uid: id,
      projectId: input.projectId,
      name: id,
      createdAt: now,
      updatedAt: now,
    },
    spec: {
      triggerId: input.triggerId,
      scheduledFor: null,
      metadata: input.metadata ?? {},
    },
    status: {
      heartbeatAt: null,
      triggeredAt: input.triggeredAt ?? now,
      phase: input.phase ?? "dispatched",
      sessionId: input.sessionId ?? "session_webhook",
      errorMessage: null,
    },
  };
}

function amaHttpTrigger(id: string, projectId: string) {
  const now = "2026-07-20T00:00:00.000Z";
  return {
    metadata: { uid: id, projectId, name: id, description: null, archivedAt: null, createdAt: now, updatedAt: now },
    spec: {
      source: { type: "http", concurrency: { mode: "serial" } },
      suspend: false,
      template: {
        metadata: { labels: {}, annotations: {} },
        spec: {
          agentId: "ama_agent_maintainer",
          environmentId: null,
          runtime: "codex",
          promptTemplate: "",
          env: {},
          envFrom: [],
          volumes: [],
          volumeMounts: [],
        },
      },
    },
    status: { lastDispatchedAt: null, lastRunId: null },
  };
}

// Minimal Env for direct function calls
function makeEnv(overrides: Record<string, unknown> = {}): any {
  return {
    DB: db,
    AE: { writeDataPoint: () => {} } as any,
    EMAIL: { send: async () => ({ messageId: "test" }) } as any,
    TUNNEL_RELAY: null as any,
    ASSETS: null as any,
    AUTH_SECRET: "test-secret-32-chars-minimum-ok!!",
    ALLOWED_HOSTS: "localhost:8788",
    GITHUB_CLIENT_ID: "x",
    GITHUB_CLIENT_SECRET: "x",
    MAILS_ADMIN_TOKEN: "",
    GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
    AMA_ORIGIN: "https://ama.test",
    REALMROOT_ISSUER: "https://id.realmroot.dev/api/auth",
    AMA_MACHINE_CLIENT_ID: "ak-machine",
    AMA_MACHINE_CLIENT_SECRET: "ak-secret",
    AMA_MACHINE_SCOPES: "projects:read projects:write sessions:write",
    AMA_DPOP_PRIVATE_JWK: "{}",
    ...overrides,
  };
}

// Build a valid X-Hub-Signature-256 header for a given body + secret
async function signWebhookBody(body: string, secret: string = WEBHOOK_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

async function apiRequest(method: string, path: string, body?: string, headers: Record<string, string> = {}) {
  const { api } = await import("../apps/web/server/routes");
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", Host: "localhost:8788", "x-forwarded-proto": "http", ...headers },
    ...(body !== undefined ? { body } : {}),
  };
  return api.request(path, init, makeEnv());
}

beforeAll(async () => {
  ({ mf, db } = await setupMiniflare());
});

afterAll(async () => {
  await mf.dispose();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── 1. verifyGithubSignature unit tests ────────────────────────────────────

describe("verifyGithubSignature", () => {
  it("returns true for a valid HMAC-SHA256 signature", async () => {
    const { verifyGithubSignature } = await import("../apps/web/server/githubWebhook");
    const body = JSON.stringify({ action: "closed" });
    const header = await signWebhookBody(body);
    expect(await verifyGithubSignature(WEBHOOK_SECRET, body, header)).toBe(true);
  });

  it("returns false for an invalid signature (wrong secret)", async () => {
    const { verifyGithubSignature } = await import("../apps/web/server/githubWebhook");
    const body = JSON.stringify({ action: "closed" });
    const header = await signWebhookBody(body, "wrong-secret");
    expect(await verifyGithubSignature(WEBHOOK_SECRET, body, header)).toBe(false);
  });

  it("returns false for a tampered body", async () => {
    const { verifyGithubSignature } = await import("../apps/web/server/githubWebhook");
    const original = JSON.stringify({ action: "closed" });
    const tampered = JSON.stringify({ action: "opened" });
    const header = await signWebhookBody(original);
    expect(await verifyGithubSignature(WEBHOOK_SECRET, tampered, header)).toBe(false);
  });

  it("returns false for a malformed header without sha256= prefix", async () => {
    const { verifyGithubSignature } = await import("../apps/web/server/githubWebhook");
    const body = "{}";
    // No sha256= prefix — raw hex only (wrong format)
    expect(await verifyGithubSignature(WEBHOOK_SECRET, body, "deadbeefdeadbeef")).toBe(false);
  });

  it("returns false for a header with a non-hex value after sha256=", async () => {
    const { verifyGithubSignature } = await import("../apps/web/server/githubWebhook");
    const body = "{}";
    expect(await verifyGithubSignature(WEBHOOK_SECRET, body, "sha256=ZZZZZZZZ")).toBe(false);
  });

  it("returns false for an empty signature string", async () => {
    const { verifyGithubSignature } = await import("../apps/web/server/githubWebhook");
    expect(await verifyGithubSignature(WEBHOOK_SECRET, "{}", "")).toBe(false);
  });
});

// ─── 2. POST /api/webhooks/github-app — route-level integration tests ────────────

describe("POST /api/webhooks/github-app route", () => {
  async function seedMaintainerWebhookTarget(input: {
    ownerId: string;
    repoName: string;
    projectId: string;
    httpTriggerId: string;
    serialized?: boolean;
  }) {
    const repoFullName = `maintainer-org/${input.repoName}`;
    const installationId = Math.floor(Math.random() * 1_000_000_000);
    await seedUser(db, input.ownerId, `${input.ownerId}@test.com`);
    await db
      .prepare(
        `INSERT INTO ama_owner_integrations (tenant_id, ama_project_id, session_secret_vault_id, metadata)
         VALUES (?, ?, 'vault_webhook', '{}')`,
      )
      .bind(input.ownerId, input.projectId)
      .run();
    await db
      .prepare(
        `INSERT INTO github_installations
           (installation_id, owner_id, account_login, account_id, account_type, repository_selection, suspended_at)
         VALUES (?, ?, 'maintainer-org', ?, 'Organization', 'selected', NULL)`,
      )
      .bind(installationId, input.ownerId, installationId + 1000)
      .run();
    await db
      .prepare("INSERT INTO github_installation_repositories (installation_id, full_name, repo_id) VALUES (?, ?, ?)")
      .bind(installationId, repoFullName.toLowerCase(), 123)
      .run();

    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createBoardMaintainer } = await import("../apps/web/server/boardMaintainerRepo");
    const { recordBoardRepository } = await import("../apps/web/server/boardRepositoryRepo");
    const { createRepository } = await import("../apps/web/server/repositoryRepo");
    const board = await createBoard(db, input.ownerId, `webhook-maintainer-board-${randomUUID()}`, "dev");
    const repo = await createRepository(db, input.ownerId, { name: input.repoName, url: `https://github.com/${repoFullName}` });
    await recordBoardRepository(db, board.id, repo.id);
    const agent = await createTestAgent(db, input.ownerId, {
      name: "Webhook maintainer",
      username: `webhook-maintainer-${randomUUID()}`,
      runtime: "codex",
      kind: "leader",
      role: "board-maintainer",
    });
    const maintainer = await createBoardMaintainer(db, input.ownerId, {
      boardId: board.id,
      agentId: agent.id,
      amaScheduleId: `sched_webhook_${randomUUID()}`,
      amaHttpTriggerId: input.httpTriggerId,
      amaHttpTriggerSerialized: input.serialized ?? true,
      amaMemoryStoreId: `mem_webhook_${randomUUID()}`,
      prompt: "Watch GitHub events.",
      intervalSeconds: 3600,
      heartbeatEnabled: true,
      status: "active",
    });
    return { repoFullName, installationId, maintainer };
  }

  function amaSession(id: string, input: { projectId: string; key?: string; maintainerId?: string; phase?: string; updatedAt?: string }) {
    const timestamp = input.updatedAt ?? "2026-01-01T00:00:00.000Z";
    return {
      metadata: {
        uid: id,
        projectId: input.projectId,
        name: id,
        createdAt: timestamp,
        updatedAt: timestamp,
        labels: {
          ...(input.maintainerId ? { maintainerId: input.maintainerId } : {}),
          ...(input.key ? { [AK_LABEL_KEY_GITHUB_SUBJECT]: input.key } : {}),
        },
        annotations: {},
      },
      spec: { agentId: "agent_1", environmentId: null, runtime: "ama", env: {}, envFrom: [], volumes: [], volumeMounts: [] },
      status: { phase: input.phase ?? "idle", reason: null },
    };
  }

  it("returns 503 when GITHUB_APP_WEBHOOK_SECRET is not configured", async () => {
    const { api } = await import("../apps/web/server/routes");
    const body = "{}";
    const envNoSecret = makeEnv({ GITHUB_APP_WEBHOOK_SECRET: undefined });
    const res = await api.request(
      "/api/webhooks/github-app",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Host: "localhost:8788", "x-forwarded-proto": "http" },
        body,
      },
      envNoSecret,
    );
    expect(res.status).toBe(503);
  });

  it("returns 401 for a missing signature header", async () => {
    const body = "{}";
    const res = await apiRequest("POST", "/api/webhooks/github-app", body);
    expect(res.status).toBe(401);
  });

  it("returns 401 for an invalid signature", async () => {
    const body = "{}";
    const res = await apiRequest("POST", "/api/webhooks/github-app", body, {
      "x-hub-signature-256": "sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 handled:false for a non-pull_request event", async () => {
    const body = JSON.stringify({ action: "created" });
    const sig = await signWebhookBody(body);
    const res = await apiRequest("POST", "/api/webhooks/github-app", body, {
      "x-hub-signature-256": sig,
      "x-github-event": "push",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.handled).toBe(false);
  });

  it("does not require an Authorization header (public route)", async () => {
    const body = JSON.stringify({ action: "closed" });
    const sig = await signWebhookBody(body);
    // No Authorization header — should succeed (not 401 for auth reasons)
    const res = await apiRequest("POST", "/api/webhooks/github-app", body, {
      "x-hub-signature-256": sig,
      "x-github-event": "pull_request",
    });
    // 200 is the only acceptable status for a valid webhook (no matching tasks is OK)
    expect(res.status).toBe(200);
  });

  it("migrates a legacy maintainer trigger to serial before dispatching its webhook", async () => {
    const ownerId = `webhook-maintainer-migrate-${randomUUID()}`;
    const projectId = `project_migrate_${randomUUID()}`;
    const httpTriggerId = `http_migrate_${randomUUID()}`;
    const { repoFullName, installationId, maintainer } = await seedMaintainerWebhookTarget({
      ownerId,
      repoName: `maintainer-repo-migrate-${randomUUID()}`,
      projectId,
      httpTriggerId,
      serialized: false,
    });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = reqUrl(input);
        const method = reqMethod(input, init);
        if (url === `https://ama.test/api/v1/triggers/${httpTriggerId}` && method === "PATCH") {
          calls.push("patch");
          const patchBody = JSON.parse(await reqBody(input, init));
          expect(patchBody).toEqual({ spec: { source: { type: "http", concurrency: { mode: "serial" } } } });
          return jsonResponse(amaHttpTrigger(httpTriggerId, projectId));
        }
        if (url === `https://ama.test/api/v1/triggers/${httpTriggerId}/runs` && method === "POST") {
          calls.push("dispatch");
          return jsonResponse(amaTriggerRun("run_migrated", { projectId, triggerId: httpTriggerId, phase: "queued", sessionId: null }), 201);
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const body = JSON.stringify({
      action: "opened",
      installation: { id: installationId },
      repository: { id: 123, full_name: repoFullName, html_url: `https://github.com/${repoFullName}` },
      issue: { id: 42, number: 42, state: "open", html_url: `https://github.com/${repoFullName}/issues/42` },
      sender: { login: "octocat" },
    });
    const res = await apiRequest("POST", "/api/webhooks/github-app", body, {
      "x-hub-signature-256": await signWebhookBody(body),
      "x-github-event": "issues",
      "x-github-delivery": `delivery-migrate-${randomUUID()}`,
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ handled: true, maintainers: [maintainer.id] });
    expect(calls).toEqual(["patch", "dispatch"]);
    const stored = await db
      .prepare("SELECT ama_http_trigger_serialized FROM board_maintainers WHERE id = ?")
      .bind(maintainer.id)
      .first<{ ama_http_trigger_serialized: number }>();
    expect(stored?.ama_http_trigger_serialized).toBe(1);
  });

  it("propagates a legacy trigger migration failure without marking or dispatching it", async () => {
    const ownerId = `webhook-maintainer-migrate-fail-${randomUUID()}`;
    const projectId = `project_migrate_fail_${randomUUID()}`;
    const httpTriggerId = `http_migrate_fail_${randomUUID()}`;
    const { repoFullName, installationId, maintainer } = await seedMaintainerWebhookTarget({
      ownerId,
      repoName: `maintainer-repo-migrate-fail-${randomUUID()}`,
      projectId,
      httpTriggerId,
      serialized: false,
    });
    const fetchMock = vi.fn(async () => jsonResponse({ error: "temporary" }, 503));
    vi.stubGlobal("fetch", fetchMock);

    const body = JSON.stringify({
      action: "opened",
      installation: { id: installationId },
      repository: { id: 123, full_name: repoFullName, html_url: `https://github.com/${repoFullName}` },
      issue: { id: 42, number: 42, state: "open", html_url: `https://github.com/${repoFullName}/issues/42` },
      sender: { login: "octocat" },
    });
    const res = await apiRequest("POST", "/api/webhooks/github-app", body, {
      "x-hub-signature-256": await signWebhookBody(body),
      "x-github-event": "issues",
      "x-github-delivery": `delivery-migrate-fail-${randomUUID()}`,
    });

    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = await db
      .prepare("SELECT ama_http_trigger_serialized FROM board_maintainers WHERE id = ?")
      .bind(maintainer.id)
      .first<{ ama_http_trigger_serialized: number }>();
    expect(stored?.ama_http_trigger_serialized).toBe(0);
  });

  it.each([
    { label: "queued", phase: "queued", sessionId: null, replayed: false },
    { label: "dispatched", phase: "dispatched", sessionId: "session_dispatch", replayed: false },
    { label: "idempotency replay", phase: "queued", sessionId: null, replayed: true },
  ])("treats an AMA $label run response as a handled webhook", async ({ phase, sessionId, replayed }) => {
    const ownerId = `webhook-maintainer-run-state-${randomUUID()}`;
    const projectId = `project_run_state_${randomUUID()}`;
    const httpTriggerId = `http_run_state_${randomUUID()}`;
    const { repoFullName, installationId, maintainer } = await seedMaintainerWebhookTarget({
      ownerId,
      repoName: `maintainer-repo-run-state-${randomUUID()}`,
      projectId,
      httpTriggerId,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(reqUrl(input)).toBe(`https://ama.test/api/v1/triggers/${httpTriggerId}/runs`);
        expect(reqMethod(input, init)).toBe("POST");
        return new Response(JSON.stringify(amaTriggerRun("run_state", { projectId, triggerId: httpTriggerId, phase, sessionId })), {
          status: 201,
          headers: {
            "Content-Type": "application/json",
            ...(replayed ? { "idempotency-replayed": "true" } : {}),
          },
        });
      }),
    );

    const body = JSON.stringify({
      action: "opened",
      installation: { id: installationId },
      repository: { id: 123, full_name: repoFullName, html_url: `https://github.com/${repoFullName}` },
      issue: { id: 42, number: 42, state: "open", html_url: `https://github.com/${repoFullName}/issues/42` },
      sender: { login: "octocat" },
    });
    const res = await apiRequest("POST", "/api/webhooks/github-app", body, {
      "x-hub-signature-256": await signWebhookBody(body),
      "x-github-event": "issues",
      "x-github-delivery": `delivery-run-state-${randomUUID()}`,
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ handled: true, maintainers: [maintainer.id] });
  });

  it("closes the maintainer session directly when an issue is closed", async () => {
    const { handleGithubMaintainerEvent } = await import("../apps/web/server/githubWebhook");
    const ownerId = `webhook-maintainer-close-${randomUUID()}`;
    const projectId = `project_close_${randomUUID()}`;
    const httpTriggerId = `http_close_${randomUUID()}`;
    const sessionId = `session_close_${randomUUID()}`;
    const { repoFullName, installationId, maintainer } = await seedMaintainerWebhookTarget({
      ownerId,
      repoName: `maintainer-repo-close-${randomUUID()}`,
      projectId,
      httpTriggerId,
    });
    const key = `github:${repoFullName.toLowerCase()}:issue:42`;

    const calls: Array<{ method: string; url: string; body?: any }> = [];
    const sessionPatches: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = reqUrl(input);
        const method = reqMethod(input, init);
        if (url.startsWith("https://ama.test/api/v1/sessions?") && method === "GET") {
          calls.push({ method, url });
          return jsonResponse({ data: [amaSession(sessionId, { projectId, key, maintainerId: maintainer.id, phase: "idle" })], pagination: {} });
        }
        if (url === `https://ama.test/api/v1/sessions/${sessionId}` && method === "PATCH") {
          const body = JSON.parse(await reqBody(input, init));
          calls.push({ method, url, body });
          sessionPatches.push(body);
          return jsonResponse(amaSession(sessionId, { projectId, phase: "closed" }));
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const result = await handleGithubMaintainerEvent(db, makeEnv(), {
      event: "issues",
      deliveryId: `delivery-close-${randomUUID()}`,
      payload: {
        action: "closed",
        installation: { id: installationId },
        repository: { id: 123, full_name: repoFullName, html_url: `https://github.com/${repoFullName}` },
        issue: { id: 42, number: 42, state: "closed", html_url: `https://github.com/${repoFullName}/issues/42` },
        sender: { login: "octocat" },
      },
    });

    expect(result).toEqual({ handled: true, maintainers: [maintainer.id] });
    const lookupUrl = new URL(calls[0].url);
    expect(lookupUrl.searchParams.get("labelSelector")).toBe(`maintainerId=${maintainer.id},${AK_LABEL_KEY_GITHUB_SUBJECT}=${key}`);
    expect(calls.map((call) => [call.method, call.url.includes("/triggers/") ? "trigger" : (call.body?.state ?? "read")])).toEqual([
      ["GET", "read"],
      ["PATCH", "closed"],
    ]);
    expect(sessionPatches).toEqual([{ state: "closed", metadata: { annotations: { closeReason: "user_requested" } } }]);
  });

  it("does not close a recently touched idle maintainer session on issue close", async () => {
    const { handleGithubMaintainerEvent } = await import("../apps/web/server/githubWebhook");
    const ownerId = `webhook-maintainer-recent-close-${randomUUID()}`;
    const projectId = `project_recent_close_${randomUUID()}`;
    const httpTriggerId = `http_recent_close_${randomUUID()}`;
    const sessionId = `session_recent_close_${randomUUID()}`;
    const { repoFullName, installationId, maintainer } = await seedMaintainerWebhookTarget({
      ownerId,
      repoName: `maintainer-repo-recent-close-${randomUUID()}`,
      projectId,
      httpTriggerId,
    });
    const key = `github:${repoFullName.toLowerCase()}:issue:42`;

    const calls: Array<{ method: string; url: string; body?: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = reqUrl(input);
        const method = reqMethod(input, init);
        if (url.startsWith("https://ama.test/api/v1/sessions?") && method === "GET") {
          calls.push({ method, url });
          return jsonResponse({
            data: [amaSession(sessionId, { projectId, key, maintainerId: maintainer.id, phase: "idle", updatedAt: new Date().toISOString() })],
            pagination: {},
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const result = await handleGithubMaintainerEvent(db, makeEnv(), {
      event: "issues",
      deliveryId: `delivery-recent-close-${randomUUID()}`,
      payload: {
        action: "closed",
        installation: { id: installationId },
        repository: { id: 123, full_name: repoFullName, html_url: `https://github.com/${repoFullName}` },
        issue: { id: 42, number: 42, state: "closed", html_url: `https://github.com/${repoFullName}/issues/42` },
        sender: { login: "octocat" },
      },
    });

    expect(result).toEqual({ handled: true, maintainers: [maintainer.id] });
    expect(calls.map((call) => [call.method, call.url.includes("/triggers/") ? "trigger" : (call.body?.state ?? "read")])).toEqual([["GET", "read"]]);
  });

  it("closes the maintainer session directly when a pull request is converted to draft", async () => {
    const { handleGithubMaintainerEvent } = await import("../apps/web/server/githubWebhook");
    const ownerId = `webhook-maintainer-draft-close-${randomUUID()}`;
    const projectId = `project_draft_close_${randomUUID()}`;
    const httpTriggerId = `http_draft_close_${randomUUID()}`;
    const sessionId = `session_draft_close_${randomUUID()}`;
    const { repoFullName, installationId, maintainer } = await seedMaintainerWebhookTarget({
      ownerId,
      repoName: `maintainer-repo-draft-close-${randomUUID()}`,
      projectId,
      httpTriggerId,
    });
    const key = `github:${repoFullName.toLowerCase()}:pull:77`;

    const calls: Array<{ method: string; url: string; body?: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = reqUrl(input);
        const method = reqMethod(input, init);
        if (url.startsWith("https://ama.test/api/v1/sessions?") && method === "GET") {
          calls.push({ method, url });
          return jsonResponse({ data: [amaSession(sessionId, { projectId, key, maintainerId: maintainer.id, phase: "idle" })], pagination: {} });
        }
        if (url === `https://ama.test/api/v1/sessions/${sessionId}` && method === "PATCH") {
          const body = JSON.parse(await reqBody(input, init));
          calls.push({ method, url, body });
          return jsonResponse(amaSession(sessionId, { projectId, key, maintainerId: maintainer.id, phase: "closed" }));
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const result = await handleGithubMaintainerEvent(db, makeEnv(), {
      event: "pull_request",
      deliveryId: `delivery-converted-to-draft-${randomUUID()}`,
      payload: {
        action: "converted_to_draft",
        installation: { id: installationId },
        repository: { id: 123, full_name: repoFullName, html_url: `https://github.com/${repoFullName}` },
        pull_request: { id: 77, number: 77, draft: true, state: "open", html_url: `https://github.com/${repoFullName}/pull/77` },
        sender: { login: "octocat" },
      },
    });

    expect(result).toEqual({ handled: true, maintainers: [maintainer.id] });
    const lookupUrl = new URL(calls[0].url);
    expect(lookupUrl.searchParams.get("labelSelector")).toBe(`maintainerId=${maintainer.id},${AK_LABEL_KEY_GITHUB_SUBJECT}=${key}`);
    expect(calls.map((call) => [call.method, call.url.includes("/triggers/") ? "trigger" : (call.body?.state ?? "read")])).toEqual([
      ["GET", "read"],
      ["PATCH", "closed"],
    ]);
  });

  it("reopens the maintainer session directly when an issue is reopened", async () => {
    const { handleGithubMaintainerEvent } = await import("../apps/web/server/githubWebhook");
    const ownerId = `webhook-maintainer-open-${randomUUID()}`;
    const projectId = `project_open_${randomUUID()}`;
    const httpTriggerId = `http_open_${randomUUID()}`;
    const sessionId = `session_open_${randomUUID()}`;
    const { repoFullName, installationId, maintainer } = await seedMaintainerWebhookTarget({
      ownerId,
      repoName: `maintainer-repo-open-${randomUUID()}`,
      projectId,
      httpTriggerId,
    });
    const key = `github:${repoFullName.toLowerCase()}:issue:42`;

    const calls: Array<{ method: string; url: string; body?: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = reqUrl(input);
        const method = reqMethod(input, init);
        if (url.startsWith("https://ama.test/api/v1/sessions?") && method === "GET") {
          calls.push({ method, url });
          return jsonResponse({ data: [amaSession(sessionId, { projectId, key, maintainerId: maintainer.id, phase: "closed" })], pagination: {} });
        }
        if (url === `https://ama.test/api/v1/sessions/${sessionId}` && method === "PATCH") {
          const body = JSON.parse(await reqBody(input, init));
          calls.push({ method, url, body });
          return jsonResponse(amaSession(sessionId, { projectId, key, maintainerId: maintainer.id, phase: "idle" }));
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const result = await handleGithubMaintainerEvent(db, makeEnv(), {
      event: "issues",
      deliveryId: `delivery-open-${randomUUID()}`,
      payload: {
        action: "reopened",
        installation: { id: installationId },
        repository: { id: 123, full_name: repoFullName, html_url: `https://github.com/${repoFullName}` },
        issue: { id: 42, number: 42, state: "open", html_url: `https://github.com/${repoFullName}/issues/42` },
        sender: { login: "octocat" },
      },
    });

    expect(result).toEqual({ handled: true, maintainers: [maintainer.id] });
    const lookupUrl = new URL(calls[0].url);
    expect(lookupUrl.searchParams.get("labelSelector")).toBe(`maintainerId=${maintainer.id},${AK_LABEL_KEY_GITHUB_SUBJECT}=${key}`);
    expect(calls.map((call) => [call.method, call.url.includes("/triggers/") ? "trigger" : (call.body?.state ?? "read")])).toEqual([
      ["GET", "read"],
      ["PATCH", "idle"],
    ]);
  });

  it("does not dispatch maintainer events for non-allowlisted issue actions", async () => {
    const { handleGithubMaintainerEvent } = await import("../apps/web/server/githubWebhook");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        throw new Error(`Unexpected fetch: ${reqUrl(input)}`);
      }),
    );

    const result = await handleGithubMaintainerEvent(db, makeEnv(), {
      event: "issues",
      deliveryId: `delivery-edited-${randomUUID()}`,
      payload: {
        action: "edited",
        installation: { id: 123 },
        repository: { id: 123, full_name: "maintainer-org/maintainer-repo", html_url: "https://github.com/maintainer-org/maintainer-repo" },
        issue: { id: 42, number: 42, state: "open", html_url: "https://github.com/maintainer-org/maintainer-repo/issues/42" },
        sender: { login: "octocat" },
      },
    });

    expect(result).toEqual({ handled: false, maintainers: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["opened", "synchronize"])("does not dispatch a draft pull request %s event to maintainers", async (action) => {
    const { handleGithubMaintainerEvent } = await import("../apps/web/server/githubWebhook");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        throw new Error(`Unexpected fetch: ${reqUrl(input)}`);
      }),
    );

    const result = await handleGithubMaintainerEvent(db, makeEnv(), {
      event: "pull_request",
      deliveryId: `delivery-draft-${randomUUID()}`,
      payload: {
        action,
        installation: { id: 123 },
        repository: { id: 123, full_name: "maintainer-org/maintainer-repo", html_url: "https://github.com/maintainer-org/maintainer-repo" },
        pull_request: {
          id: 77,
          number: 77,
          draft: true,
          state: "open",
          html_url: "https://github.com/maintainer-org/maintainer-repo/pull/77",
        },
        sender: { login: "octocat" },
      },
    });

    expect(result).toEqual({ handled: false, maintainers: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops pull request issue comments while the pull request is draft", async () => {
    const { handleGithubMaintainerEvent } = await import("../apps/web/server/githubWebhook");
    const repoFullName = `maintainer-org/maintainer-repo-draft-comment-${randomUUID()}`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`Unexpected fetch: ${reqUrl(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleGithubMaintainerEvent(db, makeEnv(), {
      event: "issue_comment",
      deliveryId: `delivery-draft-comment-${randomUUID()}`,
      payload: {
        action: "created",
        installation: { id: 123 },
        repository: { id: 123, full_name: repoFullName, html_url: `https://github.com/${repoFullName}` },
        issue: {
          id: 77,
          number: 77,
          draft: true,
          state: "open",
          html_url: `https://github.com/${repoFullName}/pull/77`,
          pull_request: { url: `https://api.github.com/repos/${repoFullName}/pulls/77` },
        },
        comment: { id: 12345, html_url: `https://github.com/${repoFullName}/pull/77#issuecomment-12345` },
        sender: { login: "octocat" },
      },
    });

    expect(result).toEqual({ handled: false, maintainers: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dispatches pull request issue comments after the pull request is ready", async () => {
    const { handleGithubMaintainerEvent } = await import("../apps/web/server/githubWebhook");
    const ownerId = `webhook-maintainer-ready-comment-${randomUUID()}`;
    const projectId = `project_ready_comment_${randomUUID()}`;
    const httpTriggerId = `http_ready_comment_${randomUUID()}`;
    const repoName = `maintainer-repo-ready-comment-${randomUUID()}`;
    const { repoFullName, installationId, maintainer } = await seedMaintainerWebhookTarget({ ownerId, repoName, projectId, httpTriggerId });
    const dispatched: Array<{ url: string; body: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = reqUrl(input);
        const method = reqMethod(input, init);
        if (url === `https://ama.test/api/v1/triggers/${httpTriggerId}/runs` && method === "POST") {
          const body = JSON.parse(await reqBody(input, init));
          dispatched.push({ url, body });
          return jsonResponse(amaTriggerRun("run_ready_comment", { projectId, triggerId: httpTriggerId }), 201);
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const result = await handleGithubMaintainerEvent(db, makeEnv(), {
      event: "issue_comment",
      deliveryId: `delivery-ready-comment-${randomUUID()}`,
      payload: {
        action: "created",
        installation: { id: installationId },
        repository: { id: 123, full_name: repoFullName, html_url: `https://github.com/${repoFullName}` },
        issue: {
          id: 77,
          number: 77,
          draft: false,
          state: "open",
          html_url: `https://github.com/${repoFullName}/pull/77`,
          pull_request: { url: `https://api.github.com/repos/${repoFullName}/pulls/77` },
        },
        comment: { id: 12345, html_url: `https://github.com/${repoFullName}/pull/77#issuecomment-12345` },
        sender: { login: "octocat" },
      },
    });

    expect(result).toEqual({ handled: true, maintainers: [maintainer.id] });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].body).toMatchObject({
      event: "issue_comment",
      action: "created",
      routing_key: `github:${repoFullName.toLowerCase()}:pull:77`,
      subject: { type: "pull_request", number: 77 },
    });
  });

  it("reopens a closed maintainer session before dispatching a closed issue comment", async () => {
    const { handleGithubMaintainerEvent } = await import("../apps/web/server/githubWebhook");
    const ownerId = `webhook-maintainer-reopen-${randomUUID()}`;
    const projectId = `project_reopen_${randomUUID()}`;
    const httpTriggerId = `http_reopen_${randomUUID()}`;
    const sessionId = `session_reopen_${randomUUID()}`;
    const repoName = `maintainer-repo-reopen-${randomUUID()}`;
    const { repoFullName, installationId, maintainer } = await seedMaintainerWebhookTarget({ ownerId, repoName, projectId, httpTriggerId });
    const key = `github:${repoFullName.toLowerCase()}:issue:42`;

    const calls: Array<{ method: string; url: string; body?: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = reqUrl(input);
        const method = reqMethod(input, init);
        if (url.startsWith("https://ama.test/api/v1/sessions?") && method === "GET") {
          calls.push({ method, url });
          return jsonResponse({ data: [amaSession(sessionId, { projectId, key, maintainerId: maintainer.id, phase: "closed" })], pagination: {} });
        }
        if (url === `https://ama.test/api/v1/sessions/${sessionId}` && method === "PATCH") {
          const body = JSON.parse(await reqBody(input, init));
          calls.push({ method, url, body });
          return jsonResponse(
            amaSession(sessionId, { projectId, key, maintainerId: maintainer.id, phase: body.state === "idle" ? "idle" : "closed" }),
          );
        }
        if (url === `https://ama.test/api/v1/triggers/${httpTriggerId}/runs` && method === "POST") {
          calls.push({ method, url, body: JSON.parse(await reqBody(input, init)) });
          return jsonResponse(amaTriggerRun("run_reopen", { projectId, triggerId: httpTriggerId, sessionId }), 201);
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const result = await handleGithubMaintainerEvent(db, makeEnv(), {
      event: "issue_comment",
      deliveryId: `delivery-reopen-${randomUUID()}`,
      payload: {
        action: "created",
        installation: { id: installationId },
        repository: { id: 123, full_name: repoFullName, html_url: `https://github.com/${repoFullName}` },
        issue: { id: 42, number: 42, state: "closed", html_url: `https://github.com/${repoFullName}/issues/42` },
        comment: { id: 12345, html_url: `https://github.com/${repoFullName}/issues/42#issuecomment-12345` },
        sender: { login: "octocat" },
      },
    });

    expect(result).toEqual({ handled: true, maintainers: [maintainer.id] });
    const lookupUrl = new URL(calls[0].url);
    expect(lookupUrl.searchParams.get("limit")).toBe("1");
    expect(lookupUrl.searchParams.get("labelSelector")).toBe(`maintainerId=${maintainer.id},${AK_LABEL_KEY_GITHUB_SUBJECT}=${key}`);
    expect(calls.map((call) => [call.method, call.url.includes("/triggers/") ? "trigger" : (call.body?.state ?? "read")])).toEqual([
      ["GET", "read"],
      ["PATCH", "idle"],
      ["POST", "trigger"],
    ]);
  });

  it.each([
    {
      event: "issues",
      subjectKey: "issue",
      subject: {
        id: 4200,
        node_id: "I_issue",
        number: 42,
        title: "Webhook issue",
        body: "Issue creation body",
        html_url: "https://github.com/maintainer-org/maintainer-repo/issues/42",
      },
      action: "opened",
      subjectPath: "issues",
      expectedKeyKind: "issue",
      extraPayload: {},
      sender: { login: "renovate[bot]", type: "Bot" },
    },
    {
      event: "pull_request",
      subjectKey: "pull_request",
      subject: {
        id: 7700,
        node_id: "PR_pull",
        number: 77,
        title: "Webhook PR",
        body: "PR creation body",
        html_url: "https://github.com/maintainer-org/maintainer-repo/pull/77",
        draft: false,
        merged: false,
      },
      action: "opened",
      subjectPath: "pull",
      expectedKeyKind: "pull",
      extraPayload: {},
    },
    {
      event: "pull_request",
      subjectKey: "pull_request",
      subject: {
        id: 7701,
        node_id: "PR_ready",
        number: 78,
        title: "Webhook PR ready",
        body: "PR ready body",
        html_url: "https://github.com/maintainer-org/maintainer-repo/pull/78",
        draft: false,
        merged: false,
      },
      action: "ready_for_review",
      subjectPath: "pull",
      expectedKeyKind: "pull",
      extraPayload: {},
      sender: { login: "agent-kanban-local[bot]", type: "Bot" },
    },
    {
      event: "pull_request",
      subjectKey: "pull_request",
      subject: {
        id: 7702,
        node_id: "PR_sync",
        number: 79,
        title: "Webhook PR sync",
        body: "PR synchronize body",
        html_url: "https://github.com/maintainer-org/maintainer-repo/pull/79",
        draft: false,
        merged: false,
      },
      action: "synchronize",
      subjectPath: "pull",
      expectedKeyKind: "pull",
      extraPayload: {},
    },
    {
      event: "issue_comment",
      subjectKey: "issue",
      subject: {
        id: 4200,
        node_id: "I_issue",
        number: 42,
        title: "Webhook issue",
        body: "Issue creation body",
        html_url: "https://github.com/maintainer-org/maintainer-repo/issues/42",
      },
      action: "created",
      subjectPath: "issues",
      expectedKeyKind: "issue",
      extraPayload: {
        comment: { id: 12345, node_id: "IC_issue_comment", body: "Can you look at this?", html_url: "https://github.com/comment/12345" },
      },
    },
    {
      event: "issue_comment",
      subjectKey: "issue",
      subject: {
        id: 4201,
        node_id: "I_issue_edited_comment",
        number: 43,
        title: "Webhook issue comment edited",
        body: "Issue edited-comment subject body",
        html_url: "https://github.com/maintainer-org/maintainer-repo/issues/43",
      },
      action: "edited",
      subjectPath: "issues",
      expectedKeyKind: "issue",
      extraPayload: {
        comment: { id: 12346, node_id: "IC_issue_comment_edited", body: "Edited issue comment", html_url: "https://github.com/comment/12346" },
      },
    },
    {
      event: "issue_comment",
      subjectKey: "issue",
      subject: {
        number: 77,
        id: 7700,
        node_id: "PR_issue_comment_subject",
        title: "Webhook PR",
        body: "PR issue-comment subject body",
        html_url: "https://github.com/maintainer-org/maintainer-repo/pull/77",
        draft: false,
        pull_request: {},
      },
      action: "created",
      subjectPath: "pull",
      expectedKeyKind: "pull",
      extraPayload: {
        comment: { id: 23456, node_id: "IC_pr_comment", body: "PR conversation follow-up", html_url: "https://github.com/comment/23456" },
      },
    },
    {
      event: "pull_request_review",
      subjectKey: "pull_request",
      subject: {
        id: 7700,
        node_id: "PR_pull",
        number: 77,
        title: "Webhook PR",
        body: "PR creation body",
        html_url: "https://github.com/maintainer-org/maintainer-repo/pull/77",
        draft: false,
        merged: false,
      },
      action: "submitted",
      subjectPath: "pull",
      expectedKeyKind: "pull",
      extraPayload: {
        review: { id: 34567, node_id: "PRR_review", body: "Review feedback", state: "commented", html_url: "https://github.com/review/34567" },
      },
    },
    {
      event: "pull_request_review",
      subjectKey: "pull_request",
      subject: {
        id: 7701,
        node_id: "PR_review_edited",
        number: 78,
        title: "Webhook PR review edited",
        body: "PR edited-review body",
        html_url: "https://github.com/maintainer-org/maintainer-repo/pull/78",
        draft: false,
        merged: false,
      },
      action: "edited",
      subjectPath: "pull",
      expectedKeyKind: "pull",
      extraPayload: {
        review: {
          id: 34568,
          node_id: "PRR_review_edited",
          body: "Edited review feedback",
          state: "commented",
          html_url: "https://github.com/review/34568",
        },
      },
    },
    {
      event: "pull_request_review_comment",
      subjectKey: "pull_request",
      subject: {
        id: 7700,
        node_id: "PR_pull",
        number: 77,
        title: "Webhook PR",
        body: "PR creation body",
        html_url: "https://github.com/maintainer-org/maintainer-repo/pull/77",
        draft: false,
        merged: false,
      },
      action: "created",
      subjectPath: "pull",
      expectedKeyKind: "pull",
      extraPayload: { comment: { id: 45678, node_id: "PRRC_inline_comment", body: "Inline comment", html_url: "https://github.com/comment/45678" } },
    },
    {
      event: "pull_request_review_comment",
      subjectKey: "pull_request",
      subject: {
        id: 7701,
        node_id: "PR_inline_edited",
        number: 78,
        title: "Webhook PR inline edited",
        body: "PR edited-inline subject body",
        html_url: "https://github.com/maintainer-org/maintainer-repo/pull/78",
        draft: false,
        merged: false,
      },
      action: "edited",
      subjectPath: "pull",
      expectedKeyKind: "pull",
      extraPayload: {
        comment: { id: 45679, node_id: "PRRC_inline_comment_edited", body: "Edited inline comment", html_url: "https://github.com/comment/45679" },
      },
    },
  ])("dispatches $event events to active maintainer HTTP trigger with compact event context and a stable subject key", async ({
    event,
    subjectKey,
    subject,
    action,
    subjectPath,
    expectedKeyKind,
    extraPayload,
    sender = { login: "octocat" },
  }) => {
    const ownerId = `webhook-maintainer-${event}-${randomUUID()}`;
    const triggerSuffix = event.replace(/[^a-z_]/g, "_");
    const httpTriggerId = `http_webhook_${triggerSuffix}_${randomUUID()}`;
    const repoName = `maintainer-repo-${triggerSuffix}-${randomUUID()}`;
    const repoFullName = `maintainer-org/${repoName}`;
    const installationId = Math.floor(Math.random() * 1_000_000_000);
    await seedUser(db, ownerId, `${ownerId}@test.com`);
    await db
      .prepare(
        `INSERT INTO ama_owner_integrations (tenant_id, ama_project_id, session_secret_vault_id, metadata)
         VALUES (?, 'project_webhook', 'vault_webhook', '{}')`,
      )
      .bind(ownerId)
      .run();
    await db
      .prepare(
        `INSERT INTO github_installations
           (installation_id, owner_id, account_login, account_id, account_type, repository_selection, suspended_at)
         VALUES (?, ?, 'maintainer-org', ?, 'Organization', 'selected', NULL)`,
      )
      .bind(installationId, ownerId, installationId + 1000)
      .run();
    await db
      .prepare("INSERT INTO github_installation_repositories (installation_id, full_name, repo_id) VALUES (?, ?, ?)")
      .bind(installationId, repoFullName.toLowerCase(), 123)
      .run();

    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createBoardMaintainer } = await import("../apps/web/server/boardMaintainerRepo");
    const { recordBoardRepository } = await import("../apps/web/server/boardRepositoryRepo");
    const { createRepository } = await import("../apps/web/server/repositoryRepo");
    const board = await createBoard(db, ownerId, `webhook-maintainer-board-${randomUUID()}`, "dev");
    const repo = await createRepository(db, ownerId, { name: repoName, url: `https://github.com/${repoFullName}` });
    await recordBoardRepository(db, board.id, repo.id);
    const agent = await createTestAgent(db, ownerId, {
      name: "Webhook maintainer",
      username: `webhook-maintainer-${randomUUID()}`,
      runtime: "codex",
      kind: "leader",
      role: "board-maintainer",
    });
    const maintainer = await createBoardMaintainer(db, ownerId, {
      boardId: board.id,
      agentId: agent.id,
      amaScheduleId: `sched_webhook_${triggerSuffix}_${randomUUID()}`,
      amaHttpTriggerId: httpTriggerId,
      amaHttpTriggerSerialized: true,
      amaMemoryStoreId: `mem_webhook_${triggerSuffix}_${randomUUID()}`,
      prompt: "Watch GitHub events.",
      intervalSeconds: 3600,
      heartbeatEnabled: true,
      status: "active",
    });

    const dispatched: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = reqUrl(input);
        if (url === `https://ama.test/api/v1/triggers/${httpTriggerId}/runs` && reqMethod(input, init) === "POST") {
          const headers = input instanceof Request ? Object.fromEntries(input.headers.entries()) : { ...(init?.headers as Record<string, string>) };
          const body = JSON.parse(await reqBody(input, init));
          dispatched.push({ url, headers, body });
          return jsonResponse(
            amaTriggerRun("run_webhook", {
              projectId: "project_webhook",
              triggerId: httpTriggerId,
              triggeredAt: "2026-06-09T01:02:03.000Z",
            }),
            201,
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const payload = {
      action,
      installation: { id: installationId },
      repository: { id: 123, full_name: repoFullName, html_url: `https://github.com/${repoFullName}` },
      [subjectKey]: {
        ...subject,
        html_url: `https://github.com/${repoFullName}/${subjectPath}/${subject.number}`,
      },
      ...extraPayload,
      sender,
    };
    const body = JSON.stringify(payload);
    const sig = await signWebhookBody(body);
    const deliveryId = `delivery-${event}-${randomUUID()}`;
    const expectedKey = `github:${repoFullName.toLowerCase()}:${expectedKeyKind}:${subject.number}`;
    const res = await apiRequest("POST", "/api/webhooks/github-app", body, {
      "x-hub-signature-256": sig,
      "x-github-event": event,
      "x-github-delivery": deliveryId,
    });
    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    const maintainerDispatch = event === "pull_request" ? json.maintainer_dispatch : json;
    const expectedSourceUrl =
      "comment" in extraPayload && typeof extraPayload.comment.html_url === "string"
        ? extraPayload.comment.html_url
        : "review" in extraPayload && typeof extraPayload.review.html_url === "string"
          ? extraPayload.review.html_url
          : null;
    expect(maintainerDispatch).toMatchObject({ handled: true, maintainers: [maintainer.id] });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].headers["idempotency-key"]).toBe(deliveryId);
    expect(dispatched[0].headers["x-ama-project-id"]).toBe("project_webhook");
    expect(dispatched[0].body).toMatchObject({
      event,
      action,
      delivery_id: deliveryId,
      routing_key: expectedKey,
      metadata: {
        labels: {
          [AK_LABEL_KEY_GITHUB_SUBJECT]: expectedKey,
        },
        annotations: {
          [AK_ANNOTATION_KEY_SOURCE_EVENT]: `${event}.${action}`,
          ...(expectedSourceUrl ? { [AK_ANNOTATION_KEY_SOURCE_URL]: expectedSourceUrl } : {}),
        },
      },
      repository: payload.repository,
      subject: {
        type: expectedKeyKind === "pull" ? "pull_request" : expectedKeyKind,
        id: subject.id,
        node_id: subject.node_id,
        number: subject.number,
        html_url: `https://github.com/${repoFullName}/${subjectPath}/${subject.number}`,
      },
      comment:
        "comment" in extraPayload
          ? expect.objectContaining({ id: extraPayload.comment.id, node_id: extraPayload.comment.node_id, html_url: extraPayload.comment.html_url })
          : { id: null, node_id: null, html_url: null },
      review:
        "review" in extraPayload
          ? expect.objectContaining({
              id: extraPayload.review.id,
              node_id: extraPayload.review.node_id,
              html_url: extraPayload.review.html_url,
              state: extraPayload.review.state,
            })
          : { id: null, node_id: null, html_url: null, state: null },
      sender,
    });
    expect(dispatched[0].body.metadata.github).toBeUndefined();
    expect(JSON.stringify(dispatched[0].body)).not.toContain("Can you look at this?");
    expect(JSON.stringify(dispatched[0].body)).not.toContain("PR conversation follow-up");
    expect(JSON.stringify(dispatched[0].body)).not.toContain("Review feedback");
    expect(JSON.stringify(dispatched[0].body)).not.toContain("Inline comment");
    expect(JSON.stringify(dispatched[0].body)).not.toContain("Webhook issue");
    expect(JSON.stringify(dispatched[0].body)).not.toContain("Webhook PR");
    expect(JSON.stringify(dispatched[0].body)).not.toContain("Issue creation body");
    expect(JSON.stringify(dispatched[0].body)).not.toContain("PR creation body");
    expect(JSON.stringify(dispatched[0].body)).not.toContain("PR issue-comment subject body");
    expect(dispatched[0].body).not.toHaveProperty("event_json");
    expect(dispatched[0].body).not.toHaveProperty("event_context_json");
  });

  it.each([
    "issue_comment",
    "pull_request_review",
    "pull_request_review_comment",
  ])("does not dispatch maintainer conversational events emitted by the configured GitHub App bot for %s", async (event) => {
    const { handleGithubMaintainerEvent } = await import("../apps/web/server/githubWebhook");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`Unexpected fetch: ${reqUrl(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleGithubMaintainerEvent(db, makeEnv({ GITHUB_APP_SLUG: "agent-kanban-local" }), {
      event,
      deliveryId: `delivery-self-${event}-${randomUUID()}`,
      payload: {
        action: event === "pull_request_review" ? "submitted" : event === "issues" || event === "pull_request" ? "opened" : "created",
        installation: { id: 123 },
        repository: { id: 456, full_name: "maintainer-org/maintainer-repo" },
        issue: { number: 42, title: "Webhook issue", html_url: "https://github.com/maintainer-org/maintainer-repo/issues/42" },
        pull_request: { number: 77, title: "Webhook PR", html_url: "https://github.com/maintainer-org/maintainer-repo/pull/77" },
        comment: { id: 12345, body: "ACK" },
        review: { id: 23456, body: "ACK", state: "commented" },
        sender: { login: "agent-kanban-local[bot]", type: "Bot" },
      },
    });

    expect(result).toEqual({ handled: false, maintainers: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not dispatch maintainer events without a matching installation", async () => {
    const ownerId = `webhook-maintainer-scope-${randomUUID()}`;
    const repoName = `maintainer-repo-scope-${randomUUID()}`;
    const repoFullName = `maintainer-org/${repoName}`;
    const installationId = Math.floor(Math.random() * 1_000_000_000);
    const wrongInstallationId = installationId + 1;
    const otherOwnerInstallationId = installationId + 2;
    const httpTriggerId = `http_webhook_scope_${randomUUID()}`;

    await seedUser(db, ownerId, `${ownerId}@test.com`);
    await db
      .prepare(
        `INSERT INTO ama_owner_integrations (tenant_id, ama_project_id, session_secret_vault_id, metadata)
         VALUES (?, 'project_webhook_scope', 'vault_webhook_scope', '{}')`,
      )
      .bind(ownerId)
      .run();
    await db
      .prepare(
        `INSERT INTO github_installations
           (installation_id, owner_id, account_login, account_id, account_type, repository_selection, suspended_at)
         VALUES (?, ?, 'maintainer-org', ?, 'Organization', 'selected', NULL)`,
      )
      .bind(installationId, ownerId, installationId + 1000)
      .run();
    await db
      .prepare("INSERT INTO github_installation_repositories (installation_id, full_name, repo_id) VALUES (?, ?, ?)")
      .bind(installationId, repoFullName.toLowerCase(), 456)
      .run();
    await db
      .prepare(
        `INSERT INTO github_installations
           (installation_id, owner_id, account_login, account_id, account_type, repository_selection, suspended_at)
         VALUES (?, ?, 'maintainer-org', ?, 'Organization', 'selected', NULL)`,
      )
      .bind(otherOwnerInstallationId, `other-owner-${randomUUID()}`, otherOwnerInstallationId + 1000)
      .run();
    await db
      .prepare("INSERT INTO github_installation_repositories (installation_id, full_name, repo_id) VALUES (?, ?, ?)")
      .bind(otherOwnerInstallationId, repoFullName.toLowerCase(), 456)
      .run();

    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createBoardMaintainer } = await import("../apps/web/server/boardMaintainerRepo");
    const { recordBoardRepository } = await import("../apps/web/server/boardRepositoryRepo");
    const { createRepository } = await import("../apps/web/server/repositoryRepo");
    const board = await createBoard(db, ownerId, `webhook-maintainer-scope-board-${randomUUID()}`, "dev");
    const repo = await createRepository(db, ownerId, { name: repoName, url: `https://github.com/${repoFullName}` });
    await recordBoardRepository(db, board.id, repo.id);
    const agent = await createTestAgent(db, ownerId, {
      name: "Webhook maintainer scope",
      username: `webhook-maintainer-scope-${randomUUID()}`,
      runtime: "codex",
      kind: "leader",
      role: "board-maintainer",
    });
    await createBoardMaintainer(db, ownerId, {
      boardId: board.id,
      agentId: agent.id,
      amaScheduleId: `sched_webhook_scope_${randomUUID()}`,
      amaHttpTriggerId: httpTriggerId,
      amaHttpTriggerSerialized: true,
      amaMemoryStoreId: `mem_webhook_scope_${randomUUID()}`,
      prompt: "Watch GitHub events.",
      intervalSeconds: 3600,
      heartbeatEnabled: true,
      status: "active",
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`Unexpected fetch: ${reqUrl(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const basePayload = {
      action: "opened",
      repository: { id: 456, full_name: repoFullName, html_url: `https://github.com/${repoFullName}` },
      issue: { number: 42, title: "Scoped issue", html_url: `https://github.com/${repoFullName}/issues/42` },
      sender: { login: "octocat" },
    };

    for (const payload of [
      basePayload,
      { ...basePayload, installation: { id: wrongInstallationId } },
      { ...basePayload, installation: { id: otherOwnerInstallationId } },
    ]) {
      const body = JSON.stringify(payload);
      const sig = await signWebhookBody(body);
      const res = await apiRequest("POST", "/api/webhooks/github-app", body, {
        "x-hub-signature-256": sig,
        "x-github-event": "issues",
        "x-github-delivery": `delivery-scope-${randomUUID()}`,
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ handled: false, maintainers: [] });
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── 3. handleGithubPullRequestEvent logic ───────────────────────────────────

describe("handleGithubPullRequestEvent", () => {
  const OWNER = "webhook-event-test-user";

  async function seedTaskWithPrAndStatus(prUrl: string, status: string, annotations: Record<string, unknown> = {}) {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");

    const board = await createBoard(db, OWNER, `webhook-board-${randomUUID()}`, "ops");
    const agent = await createTestAgent(db, OWNER, {
      name: `WebhookAgent-${randomUUID()}`,
      username: `webhook-agent-${randomUUID()}`,
      runtime: "claude",
    });
    const task = await createTask(db, OWNER, {
      title: `Webhook task ${randomUUID()}`,
      board_id: board.id,
      assigned_to: agent.id,
      skipRuntimeAvailability: true,
      metadata: Object.keys(annotations).length > 0 ? { annotations } : undefined,
    });
    await db.prepare("UPDATE tasks SET status = ?, pr_url = ? WHERE id = ?").bind(status, prUrl, task.id).run();
    return { task: { ...task, status, pr_url: prUrl }, agentId: agent.id };
  }

  beforeAll(async () => {
    await seedUser(db, OWNER, "webhook-event@test.com");
  });

  it("transitions in_review task to done when PR is merged", async () => {
    const { handleGithubPullRequestEvent } = await import("../apps/web/server/githubWebhook");

    const prUrl = `https://github.com/org/repo/pull/${randomUUID()}`;
    const { task } = await seedTaskWithPrAndStatus(prUrl, "in_review");

    // Stub fetch — no AMA binding so release is a no-op
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected fetch")));

    const env = makeEnv();
    const result = await handleGithubPullRequestEvent(db, env, {
      action: "closed",
      pull_request: { html_url: prUrl, merged: true },
    });

    expect(result.handled).toBe(true);
    expect(result.tasks).toContain(task.id);
    const row = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first<{ status: string }>();
    expect(row!.status).toBe("done");
  });

  it("transitions in_review task to cancelled when PR is closed without merge", async () => {
    const { handleGithubPullRequestEvent } = await import("../apps/web/server/githubWebhook");

    const prUrl = `https://github.com/org/repo/pull/${randomUUID()}`;
    const { task } = await seedTaskWithPrAndStatus(prUrl, "in_review");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected fetch")));

    const env = makeEnv();
    const result = await handleGithubPullRequestEvent(db, env, {
      action: "closed",
      pull_request: { html_url: prUrl, merged: false },
    });

    expect(result.handled).toBe(true);
    expect(result.tasks).toContain(task.id);
    const row = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first<{ status: string }>();
    expect(row!.status).toBe("cancelled");
  });

  it("skips in_progress task on PR merged (no state-machine path from in_progress to done)", async () => {
    const { handleGithubPullRequestEvent } = await import("../apps/web/server/githubWebhook");

    const prUrl = `https://github.com/org/repo/pull/${randomUUID()}`;
    const { task } = await seedTaskWithPrAndStatus(prUrl, "in_progress");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected fetch")));

    const env = makeEnv();
    const result = await handleGithubPullRequestEvent(db, env, {
      action: "closed",
      pull_request: { html_url: prUrl, merged: true },
    });

    // in_progress + merged → skipped
    expect(result.tasks).not.toContain(task.id);
    const row = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first<{ status: string }>();
    expect(row!.status).toBe("in_progress");
  });

  it("transitions in_progress task to cancelled when PR is closed without merge", async () => {
    const { handleGithubPullRequestEvent } = await import("../apps/web/server/githubWebhook");

    const prUrl = `https://github.com/org/repo/pull/${randomUUID()}`;
    const { task } = await seedTaskWithPrAndStatus(prUrl, "in_progress");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected fetch")));

    const env = makeEnv();
    const result = await handleGithubPullRequestEvent(db, env, {
      action: "closed",
      pull_request: { html_url: prUrl, merged: false },
    });

    expect(result.tasks).toContain(task.id);
    const row = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first<{ status: string }>();
    expect(row!.status).toBe("cancelled");
  });

  it("returns handled:false when action is not 'closed'", async () => {
    const { handleGithubPullRequestEvent } = await import("../apps/web/server/githubWebhook");

    const env = makeEnv();
    const result = await handleGithubPullRequestEvent(db, env, {
      action: "opened",
      pull_request: { html_url: "https://github.com/org/repo/pull/99", merged: false },
    });

    expect(result.handled).toBe(false);
    expect(result.tasks).toHaveLength(0);
  });

  it("returns handled:false when pull_request has no html_url", async () => {
    const { handleGithubPullRequestEvent } = await import("../apps/web/server/githubWebhook");

    const env = makeEnv();
    const result = await handleGithubPullRequestEvent(db, env, {
      action: "closed",
      pull_request: { merged: true },
    });

    expect(result.handled).toBe(false);
  });

  it("clears AMA binding annotations on task completion after PR merge", async () => {
    const { handleGithubPullRequestEvent } = await import("../apps/web/server/githubWebhook");

    const prUrl = `https://github.com/org/repo/pull/${randomUUID()}`;
    const amaSessionId = `session_wh_${randomUUID()}`;
    const { task } = await seedTaskWithPrAndStatus(prUrl, "in_review", {
      "ama.sessionId": amaSessionId,
      "ama.projectId": "project_123",
      "ama.dispatch.result": "accepted",
      agentSessionId: null, // no AK session — avoid needing full AMA teardown
    });

    const AMA_ENV = {
      AMA_ORIGIN: "https://ama.test",
      REALMROOT_ISSUER: "https://id.realmroot.dev/api/auth",
      AMA_MACHINE_CLIENT_ID: "ak-machine",
      AMA_MACHINE_CLIENT_SECRET: "ak-secret",
      AMA_MACHINE_SCOPES: "projects:read projects:write sessions:write",
      AMA_DPOP_PRIVATE_JWK: "{}",
    };

    const stops: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = reqUrl(input);
        if (url === "https://auth.test/.well-known/openid-configuration") return jsonResponse({ access_token: "test-token", expires_in: 3600 });
        if (url === `https://ama.test/api/v1/sessions/${amaSessionId}` && reqMethod(input, init) === "PATCH") {
          stops.push(url);
          return jsonResponse({ id: amaSessionId, state: "closed" });
        }
        // Usage summary (no akSessionId on task so collectUsage is skipped)
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const env = makeEnv(AMA_ENV);
    const result = await handleGithubPullRequestEvent(db, env, {
      action: "closed",
      pull_request: { html_url: prUrl, merged: true },
    });

    expect(result.tasks).toContain(task.id);
    const row = await db.prepare("SELECT metadata FROM tasks WHERE id = ?").bind(task.id).first<{ metadata: string }>();
    const meta = JSON.parse(row!.metadata ?? "{}");
    // Active binding annotations cleared; AMA session id remains queryable for history.
    expect(meta?.annotations?.["ama.sessionId"]).toBe(amaSessionId);
    expect(meta?.annotations?.["ama.dispatch.result"]).toBeNull();
    expect(stops.length).toBeGreaterThanOrEqual(1);
  });

  it("task is untouched on invalid signature via route", async () => {
    const prUrl = `https://github.com/org/repo/pull/${randomUUID()}`;
    const { task } = await seedTaskWithPrAndStatus(prUrl, "in_review");

    const body = JSON.stringify({ action: "closed", pull_request: { html_url: prUrl, merged: true } });
    const res = await apiRequest("POST", "/api/webhooks/github-app", body, {
      "x-hub-signature-256": "sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "x-github-event": "pull_request",
    });

    expect(res.status).toBe(401);
    const row = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first<{ status: string }>();
    expect(row!.status).toBe("in_review");
  });

  it("returns handled:true with empty tasks array when no task matches the PR URL", async () => {
    const { handleGithubPullRequestEvent } = await import("../apps/web/server/githubWebhook");

    const env = makeEnv();
    const result = await handleGithubPullRequestEvent(db, env, {
      action: "closed",
      pull_request: { html_url: "https://github.com/org/repo/pull/99999_no_match", merged: true },
    });

    expect(result.handled).toBe(true);
    expect(result.tasks).toHaveLength(0);
  });
});
