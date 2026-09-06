import { DEFAULT_GITHUB_SCOPES } from "../../../server/usecases/agents/defaultPermissions";
// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storeWebSessionGrant } from "../../../server/adapters/realmroot/delegatedAgencyToken";
import type { Env } from "../../../server/env";
import { api } from "../../../server/http/app";
import { createTestEnv, createTestWebSession, seedUser, setupMiniflare } from "../../helpers/db";

const ownerId = "tenant-projection-http";
const subjectId = "projection-human";
const projectId = "agency-project-1";
const resource = "https://ak.projection.test/api";
const metadata = (uid: string, name: string) => ({
  uid,
  projectId,
  name,
  description: null,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:01.000Z",
  archivedAt: null,
});
let fixture: Awaited<ReturnType<typeof setupMiniflare>>;
let env: Env;
let session: Awaited<ReturnType<typeof createTestWebSession>>;

beforeEach(async () => {
  fixture = await setupMiniflare();
  await seedUser(fixture.db, ownerId, "projection-http@example.test");
  session = await createTestWebSession(fixture.db, ownerId, { subjectId });
  env = {
    ...createTestEnv(),
    DB: fixture.db,
    AK_PUBLIC_ORIGIN: new URL(resource).origin,
    AGENCY_ORIGIN: "https://enbor.projection.test",
    GITHUB_RESOURCE: "https://adapters.test/github",
    AK_SESSION_ENCRYPTION_KEY: btoa("01234567890123456789012345678901"),
  } as Env;
  await fixture.db.prepare("INSERT INTO agency_owner_integrations (tenant_id, agency_project_id) VALUES (?, ?)").bind(ownerId, projectId).run();
  const webSession = await fixture.db
    .prepare("SELECT id FROM realmroot_web_sessions WHERE tenant_id = ? AND subject_id = ?")
    .bind(ownerId, subjectId)
    .first<{ id: string }>();
  await storeWebSessionGrant(env, webSession!.id, {
    access_token: "ak-browser-access-token",
    refresh_token: "ak-browser-refresh-token",
    expires_in: 3600,
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fixture.mf.dispose();
});

function browserGet(path: string) {
  return api.fetch(new Request(`${resource}${path}`, { headers: { cookie: session.cookie } }), env);
}

function browserPost(path: string, body: unknown, idempotencyKey?: string, auth = session) {
  return api.fetch(
    new Request(`${resource}${path}`, {
      method: "POST",
      headers: {
        cookie: auth.cookie,
        "x-csrf-token": auth.csrfToken,
        "content-type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": JSON.stringify(idempotencyKey) } : {}),
      },
      body: JSON.stringify(body),
    }),
    env,
  );
}

function browserPostWithoutBody(path: string, idempotencyKey?: string, auth = session) {
  return api.fetch(
    new Request(`${resource}${path}`, {
      method: "POST",
      headers: {
        cookie: auth.cookie,
        "x-csrf-token": auth.csrfToken,
        ...(idempotencyKey ? { "Idempotency-Key": JSON.stringify(idempotencyKey) } : {}),
      },
    }),
    env,
  );
}

function browserDelete(path: string) {
  return api.fetch(
    new Request(`${resource}${path}`, {
      method: "DELETE",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken },
    }),
    env,
  );
}

async function browserSessionFor(subject: string) {
  const auth = await createTestWebSession(fixture.db, ownerId, { subjectId: subject });
  const stored = await fixture.db
    .prepare("SELECT id FROM realmroot_web_sessions WHERE tenant_id = ? AND subject_id = ?")
    .bind(ownerId, subject)
    .first<{ id: string }>();
  await storeWebSessionGrant(env, stored!.id, {
    access_token: "ak-browser-access-token",
    refresh_token: "ak-browser-refresh-token",
    expires_in: 3600,
  });
  return auth;
}

function delegatedAgencyFetch(scopes: string[], upstream: (request: Request) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (request.url === "https://id.realmroot.dev/api/auth/.well-known/openid-configuration") {
      return Response.json({ issuer: env.OIDC_ISSUER, token_endpoint: "https://id.realmroot.dev/api/auth/oauth2/token" });
    }
    if (request.url === "https://id.realmroot.dev/api/auth/oauth2/token") {
      const body = new URLSearchParams(await request.text());
      expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
      expect(body.get("subject_token")).toBe("ak-browser-access-token");
      if (body.get("audience") === "https://id.realmroot.dev/api") {
        expect(body.get("scope")).toBe("agents:write");
        return Response.json({ access_token: "platform-user-token" });
      }
      expect(body.get("audience")).toBe("https://enbor.projection.test/api");
      expect(body.get("scope")?.split(" ")).toEqual(scopes);
      return Response.json({ access_token: "enbor-access-token" });
    }
    if (request.url.startsWith("https://id.realmroot.dev/api/agents/")) {
      expect(request.headers.get("authorization")).toBe("Bearer platform-user-token");
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname.endsWith("/permissions")).toBe(true);
      const body = (await request.json()) as { resource: string; scopes: string[]; mode: string };
      expect(Object.keys(body).sort()).toEqual(["mode", "resource", "scopes"]);
      expect(body.resource).toBe(env.GITHUB_RESOURCE);
      expect(body.scopes).toEqual(DEFAULT_GITHUB_SCOPES);
      return Response.json({ items: body.scopes.map((scope) => ({ agentId: "realmroot-concurrent", scope, mode: "persistent", status: "active" })) });
    }
    return upstream(request);
  });
}

function twoRequestBarrier(): () => Promise<void> {
  let arrivals = 0;
  let release!: () => void;
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await bothArrived;
  };
}

describe("Agent and Machine projection HTTP resources", () => {
  it("[spec: agents/authoritative-projection] returns bound and unbound Enbor Agents as safe AK resources", async () => {
    vi.stubGlobal(
      "fetch",
      delegatedAgencyFetch(["agents:read"], async (request) => {
        expect(request.headers.get("authorization")).toBe("Bearer enbor-access-token");
        expect(request.headers.get("x-enbor-project-id")).toBe(projectId);
        const boundAgent = {
          metadata: { ...metadata("agent-1", "Backend"), description: "Builds APIs" },
          spec: {
            systemPrompt: "Build APIs",
            provider: "openai",
            model: "gpt-5.6",
            skills: ["agent-kanban"],
            allowedTools: ["bash"],
            identity: { subject: "realmroot-agent-subject", username: "backend", runtime: "codex" },
          },
          status: { phase: "active", schedulable: true },
        };
        const unboundAgent = {
          metadata: metadata("agent-unbound", "Unbound"),
          spec: {
            systemPrompt: "Await identity binding",
            provider: null,
            model: null,
            skills: [],
            allowedTools: [],
            identity: null,
          },
          status: { phase: "active", schedulable: false },
        };
        if (new URL(request.url).pathname.endsWith("/agent-unbound")) return Response.json(unboundAgent);
        expect(new URL(request.url).searchParams.has("identityBound")).toBe(false);
        return Response.json({ data: [boundAgent, unboundAgent], pagination: { nextCursor: "agent-page-2", hasMore: true } });
      }),
    );

    const list = await browserGet("/agents");
    expect(list.status, await list.clone().text()).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({ id: "agent-1", subject: "realmroot-agent-subject" }),
        expect.objectContaining({ id: "agent-unbound", subject: null, username: null, runtime: null }),
      ],
      pagination: { pageSize: 2, nextPageToken: expect.any(String) },
    });
    expect(list.headers.get("Link")).toContain('rel="next"');
    const detail = await browserGet("/agents/agent-unbound");
    expect(detail.status, await detail.clone().text()).toBe(200);
    const detailText = await detail.text();
    expect(JSON.parse(detailText)).toMatchObject({ id: "agent-unbound", name: "Unbound", username: null, runtime: null, subject: null });
    expect(detailText).not.toMatch(/agency-project-1|allowedTools|systemPrompt/);
  });

  it("[spec: agents/authoritative-projection] paginates Agent projections with opaque page tokens", async () => {
    const enborRequests: Array<{ limit: string | null; cursor: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      delegatedAgencyFetch(["agents:read"], async (request) => {
        const url = new URL(request.url);
        enborRequests.push({ limit: url.searchParams.get("limit"), cursor: url.searchParams.get("cursor") });
        if (url.searchParams.get("cursor") === "agent-page-2") {
          return Response.json({
            data: [
              {
                metadata: metadata("agent-2", "Second"),
                spec: {
                  systemPrompt: "Second",
                  provider: null,
                  model: null,
                  skills: [],
                  allowedTools: [],
                  identity: null,
                },
                status: { phase: "active", schedulable: false },
              },
            ],
            pagination: { nextCursor: null, hasMore: false },
          });
        }
        return Response.json({
          data: [
            {
              metadata: metadata("agent-1", "First"),
              spec: {
                systemPrompt: "First",
                provider: null,
                model: null,
                skills: [],
                allowedTools: [],
                identity: { subject: "agent-subject-1", username: "first", runtime: "codex" },
              },
              status: { phase: "active", schedulable: true },
            },
          ],
          pagination: { nextCursor: "agent-page-2", hasMore: true },
        });
      }),
    );

    const first = await browserGet("/agents?pageSize=1");
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = (await first.json()) as { items: Array<{ id: string }>; pagination: { pageSize: number; nextPageToken: string } };
    expect(firstBody.items.map((agent) => agent.id)).toEqual(["agent-1"]);
    expect(firstBody.pagination).toMatchObject({ pageSize: 1, nextPageToken: expect.any(String) });

    const second = await browserGet(`/agents?pageSize=1&pageToken=${encodeURIComponent(firstBody.pagination.nextPageToken)}`);
    expect(second.status, await second.clone().text()).toBe(200);
    const secondBody = (await second.json()) as { items: Array<{ id: string }>; pagination: { pageSize: number; nextPageToken?: string } };
    expect(secondBody.items.map((agent) => agent.id)).toEqual(["agent-2"]);
    expect(secondBody.pagination).toEqual({ pageSize: 1 });
    expect([...firstBody.items, ...secondBody.items].map((agent) => agent.id).sort()).toEqual(["agent-1", "agent-2"]);
    expect(enborRequests).toEqual([
      { limit: "1", cursor: null },
      { limit: "1", cursor: "agent-page-2" },
    ]);

    const tampered = await browserGet(`/agents?pageSize=1&pageToken=${encodeURIComponent(`${firstBody.pagination.nextPageToken}x`)}`);
    expect(tampered.status, await tampered.clone().text()).toBe(400);
    await expect(tampered.json()).resolves.toMatchObject({ status: 400, type: `${resource}/problems/invalid-pagination` });
    const invalidPageSize = await browserGet("/agents?pageSize=0");
    expect(invalidPageSize.status, await invalidPageSize.clone().text()).toBe(400);
  });

  it.each([
    {
      resourceName: "Agent",
      path: "/agents",
      operationPath: "/api/v1/agents",
      scopes: ["agents:read", "projects:read", "projects:write"],
    },
    {
      resourceName: "Machine",
      path: "/machines",
      operationPath: "/api/v1/environments",
      scopes: ["environments:read", "runners:read", "projects:read", "projects:write"],
    },
  ])(
    "[spec: agents/transparent-agency-project] initializes the Project before the $resourceName collection",
    async ({ path, operationPath, scopes }) => {
      await fixture.db.prepare("DELETE FROM agency_owner_integrations WHERE tenant_id = ?").bind(ownerId).run();
      const events: string[] = [];
      vi.stubGlobal(
        "fetch",
        delegatedAgencyFetch(scopes, async (request) => {
          const pathname = new URL(request.url).pathname;
          events.push(`${request.method} ${pathname}`);
          if (pathname === "/api/v1/projects" && request.method === "GET") {
            return Response.json({ data: [], pagination: { nextCursor: null, hasMore: false } });
          }
          if (pathname === "/api/v1/projects" && request.method === "POST") {
            const body = (await request.json()) as { name: string };
            expect(body).toEqual({ name: "Agent Kanban" });
            expect(body.name).not.toContain(ownerId);
            return Response.json({
              id: "project-initialized",
              name: "Agent Kanban",
              createdAt: "2026-09-01T12:00:00.000Z",
              updatedAt: "2026-09-01T12:00:01.000Z",
            });
          }
          if (pathname === operationPath) {
            await expect(
              fixture.db.prepare("SELECT agency_project_id FROM agency_owner_integrations WHERE tenant_id = ?").bind(ownerId).first(),
            ).resolves.toEqual({ agency_project_id: "project-initialized" });
            expect(request.headers.get("x-enbor-project-id")).toBe("project-initialized");
            return Response.json({ data: [], pagination: { nextCursor: null, hasMore: false } });
          }
          if (pathname === "/api/v1/runners") {
            return Response.json({ data: [], pagination: { nextCursor: null, hasMore: false } });
          }
          throw new Error(`Unexpected Enbor request ${request.method} ${pathname}`);
        }),
      );

      const response = await browserGet(path);

      expect(response.status, await response.clone().text()).toBe(200);
      expect(events.slice(0, 3)).toEqual(["GET /api/v1/projects", "POST /api/v1/projects", `GET ${operationPath}`]);
    },
  );

  it("[spec: agents/transparent-agency-project] maps an active initialization claim to retryable 503", async () => {
    await fixture.db.prepare("DELETE FROM agency_owner_integrations WHERE tenant_id = ?").bind(ownerId).run();
    await fixture.db
      .prepare("INSERT INTO agency_resource_initializations (tenant_id, claim_token, expires_at) VALUES (?, ?, ?)")
      .bind(ownerId, "other-request", new Date(Date.now() + 60_000).toISOString())
      .run();
    vi.stubGlobal(
      "fetch",
      delegatedAgencyFetch(["agents:read", "projects:read", "projects:write"], async (request) => {
        throw new Error(`Enbor must not be called while another claim is active: ${request.url}`);
      }),
    );

    const response = await browserGet("/agents");

    expect(response.status, await response.clone().text()).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    await expect(response.json()).resolves.toMatchObject({
      status: 503,
      type: `${resource}/problems/enbor-initialization-busy`,
    });
  }, 30_000);

  it("[spec: machines/environment-projection] returns runtime usage grouped by Runner", async () => {
    vi.stubGlobal(
      "fetch",
      delegatedAgencyFetch(["environments:read", "runners:read"], async (request) => {
        const path = new URL(request.url).pathname;
        const environment = { metadata: metadata("environment-self", "Build host"), spec: { type: "self_hosted" }, status: { phase: "active" } };
        if (path === "/api/v1/environments") {
          return Response.json({
            data: [environment],
            pagination: { nextCursor: null, hasMore: false },
          });
        }
        if (path === "/api/v1/environments/environment-self") return Response.json(environment);
        return Response.json({
          data: [
            {
              id: "runner-1",
              name: "Runner east",
              environmentId: "environment-self",
              state: "active",
              currentLoad: 1,
              maxConcurrent: 2,
              runtimeUsage: [
                {
                  runtime: "codex",
                  windows: [{ label: "5 hours", utilization: 30, resetsAt: "2026-09-01T17:00:00.000Z" }],
                },
              ],
              runtimes: [{ runtime: "codex", models: ["gpt-5.6"], state: "ready" }],
              lastHeartbeatAt: "2026-09-01T12:01:00.000Z",
            },
            {
              id: "runner-2",
              name: "Runner west",
              environmentId: "environment-self",
              state: "active",
              currentLoad: 0,
              maxConcurrent: 1,
              runtimeUsage: [
                {
                  runtime: "claude-code",
                  windows: [{ label: "7 days", utilization: 65, resetsAt: "2026-09-08T12:00:00.000Z" }],
                },
              ],
              runtimes: [{ runtime: "claude-code", models: ["claude-opus-4-1"], state: "ready" }],
              lastHeartbeatAt: "2026-09-01T12:02:00.000Z",
            },
          ],
          pagination: { nextCursor: null, hasMore: false },
        });
      }),
    );

    const response = await browserGet("/machines");
    expect(response.status, await response.clone().text()).toBe(200);
    const collection = (await response.json()) as { items: Array<Record<string, unknown>> };
    expect(collection.items).toEqual([
      expect.objectContaining({
        id: "environment-self",
        name: "Runner east + 1 runner",
        status: "online",
        currentLoad: 1,
        maxLoad: 3,
        runnerCount: 2,
      }),
    ]);
    expect(collection.items[0]).not.toHaveProperty("runners");

    const detailResponse = await browserGet("/machines/environment-self");
    expect(detailResponse.status, await detailResponse.clone().text()).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      id: "environment-self",
      runners: [
        expect.objectContaining({
          id: "runner-1",
          name: "Runner east",
          runtimeUsage: [
            {
              runtime: "codex",
              windows: [{ label: "5 hours", utilization: 30, resetsAt: "2026-09-01T17:00:00.000Z" }],
            },
          ],
        }),
        expect.objectContaining({
          id: "runner-2",
          name: "Runner west",
          runtimeUsage: [
            {
              runtime: "claude-code",
              windows: [{ label: "7 days", utilization: 65, resetsAt: "2026-09-08T12:00:00.000Z" }],
            },
          ],
        }),
      ],
    });
  });

  it("[spec: machines/environment-projection] paginates Machine projections with opaque page tokens", async () => {
    const environmentRequests: Array<{ limit: string | null; cursor: string | null }> = [];
    const runnerEnvironmentIds: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      delegatedAgencyFetch(["environments:read", "runners:read"], async (request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/api/v1/runners")) {
          runnerEnvironmentIds.push(url.searchParams.get("environmentId"));
          return Response.json({ data: [], pagination: { nextCursor: null, hasMore: false } });
        }
        if (url.pathname.endsWith("/api/v1/environments")) {
          environmentRequests.push({ limit: url.searchParams.get("limit"), cursor: url.searchParams.get("cursor") });
          if (url.searchParams.get("cursor") === "environment-page-2") {
            return Response.json({
              data: [
                {
                  metadata: metadata("environment-2", "internal-two"),
                  spec: { type: "self_hosted", scope: "project" },
                  status: { phase: "active" },
                },
              ],
              pagination: { nextCursor: null, hasMore: false },
            });
          }
          return Response.json({
            data: [
              {
                metadata: metadata("environment-1", "internal-one"),
                spec: { type: "self_hosted", scope: "project" },
                status: { phase: "active" },
              },
            ],
            pagination: { nextCursor: "environment-page-2", hasMore: true },
          });
        }
        throw new Error(`Unexpected Enbor request: ${request.url}`);
      }),
    );

    const first = await browserGet("/machines?pageSize=1");
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = (await first.json()) as { items: Array<{ id: string }>; pagination: { pageSize: number; nextPageToken: string } };
    expect(firstBody.items.map((machine) => machine.id)).toEqual(["environment-1"]);
    expect(firstBody.pagination).toMatchObject({ pageSize: 1, nextPageToken: expect.any(String) });

    const second = await browserGet(`/machines?pageSize=1&pageToken=${encodeURIComponent(firstBody.pagination.nextPageToken)}`);
    expect(second.status, await second.clone().text()).toBe(200);
    const secondBody = (await second.json()) as { items: Array<{ id: string }>; pagination: { pageSize: number; nextPageToken?: string } };
    expect(secondBody.items.map((machine) => machine.id)).toEqual(["environment-2"]);
    expect(secondBody.pagination).toEqual({ pageSize: 1 });
    expect([...firstBody.items, ...secondBody.items].map((machine) => machine.id).sort()).toEqual(["environment-1", "environment-2"]);
    expect(environmentRequests).toEqual([
      { limit: "1", cursor: null },
      { limit: "1", cursor: "environment-page-2" },
    ]);
    expect(runnerEnvironmentIds).toEqual(["environment-1", "environment-2"]);

    const tampered = await browserGet(`/machines?pageSize=1&pageToken=${encodeURIComponent(`${firstBody.pagination.nextPageToken}x`)}`);
    expect(tampered.status, await tampered.clone().text()).toBe(400);
    await expect(tampered.json()).resolves.toMatchObject({ status: 400, type: `${resource}/problems/invalid-pagination` });
    const invalidPageSize = await browserGet("/machines?pageSize=101");
    expect(invalidPageSize.status, await invalidPageSize.clone().text()).toBe(400);
  });

  it("[spec: machines/create-runner-setup] returns setup commands for an offline Machine without Runners", async () => {
    vi.stubGlobal(
      "fetch",
      delegatedAgencyFetch(["environments:read", "runners:read"], async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/api/v1/environments/environment-empty") {
          return Response.json({
            metadata: metadata("environment-empty", "Empty host"),
            spec: { type: "self_hosted" },
            status: { phase: "active" },
          });
        }
        if (path === "/api/v1/runners") {
          return Response.json({ data: [], pagination: { nextCursor: null, hasMore: false } });
        }
        throw new Error(`Unexpected Enbor request ${request.method} ${path}`);
      }),
    );

    const response = await browserGet("/machines/environment-empty");

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "environment-empty",
      name: "Waiting for computer",
      status: "offline",
      runnerCount: 0,
      runners: [],
      authCommand: 'enbor-runner auth login --api-server "https://enbor.projection.test"',
      startCommand:
        'enbor-runner start --api-server "https://enbor.projection.test" --project-id "agency-project-1" --environment-id "environment-empty" --allow-unsafe-process',
    });
  });

  it("[spec: machines/create-environment] returns complete auth and start commands for the created Enbor Environment", async () => {
    vi.stubGlobal(
      "fetch",
      delegatedAgencyFetch(["environments:write"], async (request) => {
        expect(request.method).toBe("POST");
        expect(request.headers.get("Idempotency-Key")).toMatch(/^ak-[a-f0-9]{64}$/);
        await expect(request.json()).resolves.toEqual({
          metadata: { name: expect.stringMatching(/^computer-[a-f0-9]{8}$/) },
          spec: { scope: "project", type: "self_hosted" },
        });
        return Response.json({
          metadata: metadata("environment-created", "computer-created"),
          spec: { type: "self_hosted" },
          status: { phase: "active" },
        });
      }),
    );

    const missingKey = await browserPostWithoutBody("/machines");
    expect(missingKey.status).toBe(400);

    const callerAuthoredBody = await browserPost("/machines", { name: "Caller-controlled" }, "machine-form-request-with-body");
    expect(callerAuthoredBody.status).toBe(400);
    await expect(callerAuthoredBody.json()).resolves.toMatchObject({
      type: `${resource}/problems/request-body-not-allowed`,
      detail: "Machine has no client-writable representation",
    });

    const response = await browserPostWithoutBody("/machines", "machine-form-request-1");
    expect(response.status, await response.clone().text()).toBe(201);
    const created = await response.json();
    expect(created).toMatchObject({
      machine: { id: "environment-created", status: "offline" },
      authCommand: 'enbor-runner auth login --api-server "https://enbor.projection.test"',
      startCommand:
        'enbor-runner start --api-server "https://enbor.projection.test" --project-id "agency-project-1" --environment-id "environment-created" --allow-unsafe-process',
    });
    expect(created.machine).not.toHaveProperty("runners");
  });

  it("[spec: agents/authoritative-projection] [spec: agents/create-bound-agent] replays the winning Agent response when identical external creations complete concurrently", async () => {
    const synchronizeAgentCreations = twoRequestBarrier();
    let identityCreates = 0;
    let agentCreates = 0;
    let triggerCreates = 0;
    const identityUpstreamKeys: string[] = [];
    const agentUpstreamKeys: string[] = [];
    vi.stubGlobal(
      "fetch",
      delegatedAgencyFetch(["identities:write", "agents:write"], async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/api/v1/identities") {
          identityCreates += 1;
          identityUpstreamKeys.push(request.headers.get("Idempotency-Key")!);
          return Response.json({ metadata: metadata("identity-concurrent", "Concurrent Agent") });
        }
        if (path === "/api/v1/agents") {
          agentCreates += 1;
          agentUpstreamKeys.push(request.headers.get("Idempotency-Key")!);
          await synchronizeAgentCreations();
          return Response.json({
            metadata: metadata("agent-concurrent", "Concurrent Agent"),
            spec: {
              systemPrompt: "Handle concurrent work",
              provider: null,
              model: null,
              skills: ["saltbo/agent-kanban@agent-kanban"],
              allowedTools: [],
              identity: { agentId: "realmroot-concurrent", subject: "agent-concurrent-subject", username: "concurrent-agent", runtime: "codex" },
            },
            status: { phase: "active", schedulable: true },
          });
        }
        if (path === "/api/v1/triggers") {
          triggerCreates += 1;
          throw new Error("Agent creation must not create an Inbox Trigger");
        }
        throw new Error(`Unexpected Enbor request ${request.method} ${path}`);
      }),
    );
    const key = "concurrent-agent-create";
    const body = {
      name: "Concurrent Agent",
      username: "concurrent-agent",
      runtime: "codex",
      systemPrompt: "Handle concurrent work",
    };

    const missingKey = await browserPost("/agents", body);
    expect(missingKey.status).toBe(400);
    expect(identityCreates).toBe(0);
    expect(agentCreates).toBe(0);
    expect(triggerCreates).toBe(0);

    const responses = await Promise.all([browserPost("/agents", body, key), browserPost("/agents", body, key)]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(responses.filter((response) => response.headers.get("Idempotency-Replayed") === null)).toHaveLength(1);
    expect(responses.filter((response) => response.headers.get("Idempotency-Replayed") === "true")).toHaveLength(1);
    const snapshots = await Promise.all(
      responses.map(async (response) => ({
        body: await response.text(),
        location: response.headers.get("Location"),
        etag: response.headers.get("ETag"),
      })),
    );
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(identityCreates).toBe(2);
    expect(agentCreates).toBe(2);
    expect(triggerCreates).toBe(0);
    await expect(
      fixture.db
        .prepare("SELECT COUNT(*) AS count FROM resource_idempotency_records WHERE resource_kind = ? AND idempotency_key = ?")
        .bind("agent", key)
        .first(),
    ).resolves.toEqual({ count: 1 });

    const conflict = await browserPost("/agents", { ...body, name: "Different Agent" }, key);
    expect(conflict.status).toBe(422);
    expect(identityCreates).toBe(2);
    expect(agentCreates).toBe(2);
    expect(triggerCreates).toBe(0);

    const otherSession = await browserSessionFor("projection-human-other");
    const otherCaller = await browserPost("/agents", { ...body, name: "Other caller Agent" }, key, otherSession);
    expect(otherCaller.status, await otherCaller.clone().text()).toBe(201);
    expect(identityUpstreamKeys[0]).toBe(identityUpstreamKeys[1]);
    expect(agentUpstreamKeys[0]).toBe(agentUpstreamKeys[1]);
    expect(new Set([identityUpstreamKeys[0], agentUpstreamKeys[0]]).size).toBe(2);
    expect(identityUpstreamKeys[2]).not.toBe(identityUpstreamKeys[0]);
    expect(agentUpstreamKeys[2]).not.toBe(agentUpstreamKeys[0]);
    await expect(
      fixture.db
        .prepare("SELECT COUNT(*) AS count FROM resource_idempotency_records WHERE resource_kind = ? AND idempotency_key = ?")
        .bind("agent", key)
        .first(),
    ).resolves.toEqual({ count: 2 });
  });

  it("[spec: machines/create-environment] replays the winning Machine response when identical external creations complete concurrently", async () => {
    const synchronizeMachineCreations = twoRequestBarrier();
    let machineCreates = 0;
    const upstreamKeys: string[] = [];
    vi.stubGlobal(
      "fetch",
      delegatedAgencyFetch(["environments:write"], async (request) => {
        expect(new URL(request.url).pathname).toBe("/api/v1/environments");
        machineCreates += 1;
        upstreamKeys.push(request.headers.get("Idempotency-Key")!);
        await synchronizeMachineCreations();
        return Response.json({
          metadata: metadata("environment-concurrent", "Concurrent Machine"),
          spec: { type: "self_hosted" },
          status: { phase: "active" },
        });
      }),
    );
    const key = "concurrent-machine-create";

    const responses = await Promise.all([browserPostWithoutBody("/machines", key), browserPostWithoutBody("/machines", key)]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(responses.filter((response) => response.headers.get("Idempotency-Replayed") === null)).toHaveLength(1);
    expect(responses.filter((response) => response.headers.get("Idempotency-Replayed") === "true")).toHaveLength(1);
    const snapshots = await Promise.all(
      responses.map(async (response) => ({
        body: await response.text(),
        location: response.headers.get("Location"),
        etag: response.headers.get("ETag"),
      })),
    );
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(machineCreates).toBe(2);
    await expect(
      fixture.db
        .prepare("SELECT COUNT(*) AS count FROM resource_idempotency_records WHERE resource_kind = ? AND idempotency_key = ?")
        .bind("machine", key)
        .first(),
    ).resolves.toEqual({ count: 1 });

    const otherSession = await browserSessionFor("projection-human-other");
    const otherCaller = await browserPostWithoutBody("/machines", key, otherSession);
    expect(otherCaller.status, await otherCaller.clone().text()).toBe(201);
    expect(upstreamKeys[0]).toBe(upstreamKeys[1]);
    expect(upstreamKeys[2]).not.toBe(upstreamKeys[0]);
    await expect(
      fixture.db
        .prepare("SELECT COUNT(*) AS count FROM resource_idempotency_records WHERE resource_kind = ? AND idempotency_key = ?")
        .bind("machine", key)
        .first(),
    ).resolves.toEqual({ count: 2 });
  });

  it("[spec: agents/authoritative-projection] uses exact DPoP Agent authority and minimal delegated Agency scope", async () => {
    await fixture.db.prepare("DROP TABLE realmroot_user_ama_grants").run();
    const url = `${resource}/agents`;
    const issuer = env.OIDC_ISSUER;
    const issuerKeys = await generateKeyPair("ES256", { extractable: true });
    const issuerJwk = await exportJWK(issuerKeys.publicKey);
    issuerJwk.kid = "projection-issuer";
    const dpopKeys = await generateKeyPair("ES256", { extractable: true });
    const dpopJwk = await exportJWK(dpopKeys.publicKey);
    const token = await new SignJWT({
      scope: "agent:read",
      client_id: "realmroot-cli",
      cnf: { jkt: await calculateJwkThumbprint(dpopJwk) },
      act: { iss: issuer, sub: "agent-projection-subject" },
      "urn:realmroot:params:oauth:org": ownerId,
    })
      .setProtectedHeader({ alg: "ES256", kid: issuerJwk.kid, typ: "at+jwt" })
      .setIssuer(issuer)
      .setAudience(resource)
      .setSubject("controller-exact")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(issuerKeys.privateKey);
    const proof = await new SignJWT({ htu: url, htm: "GET", ath: createHash("sha256").update(token).digest("base64url") })
      .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: dpopJwk })
      .setJti(randomUUID())
      .setIssuedAt()
      .sign(dpopKeys.privateKey);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        if (request.url === `${issuer}/.well-known/openid-configuration`) {
          return Response.json({
            issuer,
            authorization_endpoint: `${issuer}/oauth2/authorize`,
            token_endpoint: `${issuer}/oauth2/token`,
            jwks_uri: `${issuer}/jwks`,
          });
        }
        if (request.url === `${issuer}/jwks`) return Response.json({ keys: [issuerJwk] });
        if (request.url === `${issuer}/oauth2/token`) {
          const body = new URLSearchParams(await request.text());
          expect(body.get("subject_token")).toBe(token);
          expect(body.get("audience")).toBe(`${env.AGENCY_ORIGIN}/api`);
          expect(body.get("scope")).toBe("agents:read");
          return Response.json({ access_token: "agent-delegated-enbor-token" });
        }
        expect(request.headers.get("authorization")).toBe("Bearer agent-delegated-enbor-token");
        expect(request.headers.get("x-enbor-project-id")).toBe(projectId);
        return Response.json({ data: [], pagination: { nextCursor: null, hasMore: false } });
      }),
    );

    const response = await api.fetch(
      new Request(url, { headers: { authorization: `DPoP ${token}`, dpop: proof, "API-Version": "2026-08-29" } }),
      env,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  });

  it("[spec: machines/archive-environment] archives the authoritative Enbor Environment without a local Machine entity", async () => {
    await fixture.db.prepare("DROP TABLE machines").run();
    vi.stubGlobal(
      "fetch",
      delegatedAgencyFetch(["environments:write"], async (request) => {
        expect(request.method).toBe("DELETE");
        expect(new URL(request.url).pathname).toBe("/api/v1/environments/environment-1");
        expect(request.headers.get("authorization")).toBe("Bearer enbor-access-token");
        expect(request.headers.get("x-enbor-project-id")).toBe(projectId);
        expect(await request.text()).toBe("");
        return new Response(null, { status: 204 });
      }),
    );

    const response = await browserDelete("/machines/environment-1");

    expect(response.status, await response.clone().text()).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("[spec: agents/authoritative-projection] maps strict Realmroot exchange failures through HTTP Problems", async () => {
    const scenarios: Array<{ response: Response | Error; status: number }> = [
      { response: Response.json({ error: "access_denied" }, { status: 403 }), status: 403 },
      { response: Response.json({ error: "invalid_token" }, { status: 401 }), status: 502 },
      { response: Response.json({ access_token: "", expires_in: "300" }), status: 502 },
      { response: new Response("not-json", { status: 200 }), status: 502 },
      { response: Response.json({ error: "slow_down" }, { status: 429 }), status: 503 },
      { response: Response.json({ error: "unavailable" }, { status: 500 }), status: 503 },
      { response: new Error("network down"), status: 503 },
    ];
    for (const scenario of scenarios) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url.endsWith("/.well-known/openid-configuration")) {
            return Response.json({ issuer: env.OIDC_ISSUER, token_endpoint: `${env.OIDC_ISSUER}/oauth2/token` });
          }
          if (scenario.response instanceof Error) throw scenario.response;
          return scenario.response.clone();
        }),
      );
      const response = await browserGet("/agents");
      expect(response.status, await response.clone().text()).toBe(scenario.status);
      await expect(response.json()).resolves.toMatchObject({
        status: scenario.status,
        type: expect.stringMatching(scenario.status < 500 ? /delegation-denied$/ : /delegation-unavailable$/),
      });
    }
  });

  it("[spec: agents/read-only-browser] rejects noncanonical runtime and malformed Agent collection filters", async () => {
    vi.stubGlobal(
      "fetch",
      delegatedAgencyFetch(["agents:read"], async (request) => {
        throw new Error(`Enbor must not be called for an invalid filter: ${request.url}`);
      }),
    );
    for (const query of ["runtime=remote", "schedulable=yes", "search=", `search=${"x".repeat(161)}`]) {
      const response = await browserGet(`/agents?${query}`);
      expect(response.status, `${query}: ${await response.clone().text()}`).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ status: 400, type: `${resource}/problems/request-rejected` });
    }
  });
});
