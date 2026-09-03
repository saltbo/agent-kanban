// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storeWebSessionGrant } from "../../../server/adapters/realmroot/delegatedAmaToken";
import type { Env } from "../../../server/env";
import { api } from "../../../server/http/app";
import { createTestEnv, createTestWebSession, seedUser, setupMiniflare } from "../../helpers/db";

const ownerId = "tenant-projection-http";
const subjectId = "projection-human";
const projectId = "ama-project-1";
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
    AMA_ORIGIN: "https://ama.projection.test",
    AK_SESSION_ENCRYPTION_KEY: btoa("01234567890123456789012345678901"),
  } as Env;
  await fixture.db.prepare("INSERT INTO ama_owner_integrations (tenant_id, ama_project_id) VALUES (?, ?)").bind(ownerId, projectId).run();
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
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
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

function delegatedAmaFetch(scopes: string[], upstream: (request: Request) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (request.url === "https://id.realmroot.dev/api/auth/.well-known/openid-configuration") {
      return Response.json({ issuer: env.OIDC_ISSUER, token_endpoint: "https://id.realmroot.dev/api/auth/oauth2/token" });
    }
    if (request.url === "https://id.realmroot.dev/api/auth/oauth2/token") {
      const body = new URLSearchParams(await request.text());
      expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
      expect(body.get("subject_token")).toBe("ak-browser-access-token");
      expect(body.get("audience")).toBe("https://ama.projection.test/api");
      expect(body.get("scope")?.split(" ")).toEqual(scopes);
      return Response.json({ access_token: "ama-access-token" });
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
  it("[spec: agents/authoritative-projection] returns AMA Agent list and detail as safe AK resources", async () => {
    vi.stubGlobal(
      "fetch",
      delegatedAmaFetch(["agents:read"], async (request) => {
        expect(request.headers.get("authorization")).toBe("Bearer ama-access-token");
        expect(request.headers.get("x-ama-project-id")).toBe(projectId);
        const agent = {
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
        if (new URL(request.url).pathname.endsWith("/agent-1")) return Response.json(agent);
        return Response.json({ data: [agent], pagination: { nextCursor: null, hasMore: false } });
      }),
    );

    const list = await browserGet("/agents");
    expect(list.status, await list.clone().text()).toBe(200);
    await expect(list.json()).resolves.toMatchObject({ items: [expect.objectContaining({ id: "agent-1", subject: "realmroot-agent-subject" })] });
    const detail = await browserGet("/agents/agent-1");
    expect(detail.status, await detail.clone().text()).toBe(200);
    const detailText = await detail.text();
    expect(JSON.parse(detailText)).toMatchObject({ id: "agent-1", name: "Backend", runtime: "codex", subject: "realmroot-agent-subject" });
    expect(detailText).not.toMatch(/ama-project-1|allowedTools|systemPrompt/);
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
    "[spec: agents/transparent-ama-project] initializes the Project before the $resourceName collection",
    async ({ path, operationPath, scopes }) => {
      await fixture.db.prepare("DELETE FROM ama_owner_integrations WHERE tenant_id = ?").bind(ownerId).run();
      const events: string[] = [];
      vi.stubGlobal(
        "fetch",
        delegatedAmaFetch(scopes, async (request) => {
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
              fixture.db.prepare("SELECT ama_project_id FROM ama_owner_integrations WHERE tenant_id = ?").bind(ownerId).first(),
            ).resolves.toEqual({ ama_project_id: "project-initialized" });
            expect(request.headers.get("x-ama-project-id")).toBe("project-initialized");
            return Response.json({ data: [], pagination: { nextCursor: null, hasMore: false } });
          }
          if (pathname === "/api/v1/runners") {
            return Response.json({ data: [], pagination: { nextCursor: null, hasMore: false } });
          }
          throw new Error(`Unexpected AMA request ${request.method} ${pathname}`);
        }),
      );

      const response = await browserGet(path);

      expect(response.status, await response.clone().text()).toBe(200);
      expect(events.slice(0, 3)).toEqual(["GET /api/v1/projects", "POST /api/v1/projects", `GET ${operationPath}`]);
    },
  );

  it("[spec: agents/transparent-ama-project] maps an active initialization claim to retryable 503", async () => {
    await fixture.db.prepare("DELETE FROM ama_owner_integrations WHERE tenant_id = ?").bind(ownerId).run();
    await fixture.db
      .prepare("INSERT INTO ama_resource_initializations (tenant_id, claim_token, expires_at) VALUES (?, ?, ?)")
      .bind(ownerId, "other-request", new Date(Date.now() + 60_000).toISOString())
      .run();
    vi.stubGlobal(
      "fetch",
      delegatedAmaFetch(["agents:read", "projects:read", "projects:write"], async (request) => {
        throw new Error(`AMA must not be called while another claim is active: ${request.url}`);
      }),
    );

    const response = await browserGet("/agents");

    expect(response.status, await response.clone().text()).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    await expect(response.json()).resolves.toMatchObject({
      status: 503,
      type: `${resource}/problems/ama-initialization-busy`,
    });
  }, 30_000);

  it("[spec: machines/environment-projection] returns AMA self-hosted Environment and Runner projections", async () => {
    vi.stubGlobal(
      "fetch",
      delegatedAmaFetch(["environments:read", "runners:read"], async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/api/v1/environments") {
          return Response.json({
            data: [{ metadata: metadata("environment-self", "Build host"), spec: { type: "self_hosted" }, status: { phase: "active" } }],
            pagination: { nextCursor: null, hasMore: false },
          });
        }
        return Response.json({
          data: [
            {
              id: "runner-1",
              environmentId: "environment-self",
              state: "active",
              currentLoad: 1,
              maxConcurrent: 2,
              runtimes: [{ runtime: "codex", models: ["gpt-5.6"], state: "ready" }],
              lastHeartbeatAt: "2026-09-01T12:01:00.000Z",
            },
          ],
          pagination: { nextCursor: null, hasMore: false },
        });
      }),
    );

    const response = await browserGet("/machines");
    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ id: "environment-self", name: "Build host", status: "online", currentLoad: 1, maxLoad: 2 })],
    });
  });

  it("[spec: machines/create-environment] returns complete auth and start commands for the created AMA Environment", async () => {
    vi.stubGlobal(
      "fetch",
      delegatedAmaFetch(["environments:write"], async (request) => {
        expect(request.method).toBe("POST");
        expect(request.headers.get("Idempotency-Key")).toMatch(/^ak-[a-f0-9]{64}$/);
        await expect(request.json()).resolves.toEqual({ metadata: { name: "Build host" }, spec: { scope: "project", type: "self_hosted" } });
        return Response.json({
          metadata: metadata("environment-created", "Build host"),
          spec: { type: "self_hosted" },
          status: { phase: "active" },
        });
      }),
    );

    const missingKey = await browserPost("/machines", { name: "Build host" });
    expect(missingKey.status).toBe(400);

    const response = await browserPost("/machines", { name: "Build host" }, "machine-form-request-1");
    expect(response.status, await response.clone().text()).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      machine: { id: "environment-created", status: "offline" },
      authCommand: 'ama-runner auth login --api-server "https://ama.projection.test"',
      startCommand:
        'ama-runner start --api-server "https://ama.projection.test" --project-id "ama-project-1" --environment-id "environment-created" --allow-unsafe-process',
    });
  });

  it("[spec: agents/authoritative-projection] [spec: agents/create-bound-agent] replays the winning Agent response when identical external creations complete concurrently", async () => {
    const synchronizeAgentCreations = twoRequestBarrier();
    let identityCreates = 0;
    let agentCreates = 0;
    const identityUpstreamKeys: string[] = [];
    const agentUpstreamKeys: string[] = [];
    vi.stubGlobal(
      "fetch",
      delegatedAmaFetch(["identities:write", "agents:write"], async (request) => {
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
              skills: [],
              allowedTools: [],
              identity: { subject: "agent-concurrent-subject", username: "concurrent-agent", runtime: "codex" },
            },
            status: { phase: "active", schedulable: true },
          });
        }
        throw new Error(`Unexpected AMA request ${request.method} ${path}`);
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

    const otherSession = await browserSessionFor("projection-human-other");
    const otherCaller = await browserPost("/agents", { ...body, name: "Other caller Agent" }, key, otherSession);
    expect(otherCaller.status, await otherCaller.clone().text()).toBe(201);
    expect(identityUpstreamKeys[0]).toBe(identityUpstreamKeys[1]);
    expect(agentUpstreamKeys[0]).toBe(agentUpstreamKeys[1]);
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
      delegatedAmaFetch(["environments:write"], async (request) => {
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
    const body = { name: "Concurrent Machine" };

    const responses = await Promise.all([browserPost("/machines", body, key), browserPost("/machines", body, key)]);
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

    const conflict = await browserPost("/machines", { name: "Different Machine" }, key);
    expect(conflict.status).toBe(422);
    expect(machineCreates).toBe(2);

    const otherSession = await browserSessionFor("projection-human-other");
    const otherCaller = await browserPost("/machines", { name: "Other caller Machine" }, key, otherSession);
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

  it("[spec: agents/authoritative-projection] uses exact DPoP Agent authority and minimal delegated AMA scope", async () => {
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
          expect(body.get("audience")).toBe(`${env.AMA_ORIGIN}/api`);
          expect(body.get("scope")).toBe("agents:read");
          return Response.json({ access_token: "agent-delegated-ama-token" });
        }
        expect(request.headers.get("authorization")).toBe("Bearer agent-delegated-ama-token");
        expect(request.headers.get("x-ama-project-id")).toBe(projectId);
        return Response.json({ data: [], pagination: { nextCursor: null, hasMore: false } });
      }),
    );

    const response = await api.fetch(
      new Request(url, { headers: { authorization: `DPoP ${token}`, dpop: proof, "API-Version": "2026-08-29" } }),
      env,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  });

  it("[spec: machines/archive-environment] archives the authoritative AMA Environment without a local Machine entity", async () => {
    await fixture.db.prepare("DROP TABLE machines").run();
    vi.stubGlobal(
      "fetch",
      delegatedAmaFetch(["environments:write"], async (request) => {
        expect(request.method).toBe("PATCH");
        expect(new URL(request.url).pathname).toBe("/api/v1/environments/environment-1");
        expect(request.headers.get("authorization")).toBe("Bearer ama-access-token");
        expect(request.headers.get("x-ama-project-id")).toBe(projectId);
        await expect(request.json()).resolves.toEqual({ archived: true });
        return Response.json({
          metadata: { ...metadata("environment-1", "Machine"), archivedAt: "2026-09-01T13:00:00.000Z" },
          spec: { type: "self_hosted" },
          status: { phase: "archived" },
        });
      }),
    );

    const response = await browserDelete("/machines/environment-1");

    expect(response.status, await response.clone().text()).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("[spec: agents/authoritative-projection] [spec: machines/archive-environment] maps invalid AMA success responses to 502", async () => {
    vi.stubGlobal(
      "fetch",
      delegatedAmaFetch(["agents:read"], async () => new Response("not-json", { status: 200 })),
    );
    const invalidRead = await browserGet("/agents/agent-1");
    expect(invalidRead.status).toBe(502);
    await expect(invalidRead.json()).resolves.toMatchObject({ status: 502, detail: "AMA returned invalid JSON" });

    vi.stubGlobal(
      "fetch",
      delegatedAmaFetch(["environments:write"], async () =>
        Response.json({ metadata: metadata("environment-1", "Machine"), spec: { type: "self_hosted" }, status: { phase: "active" } }),
      ),
    );
    const malformedArchive = await browserDelete("/machines/environment-1");
    expect(malformedArchive.status).toBe(502);
    await expect(malformedArchive.json()).resolves.toMatchObject({ status: 502, detail: "AMA did not confirm Machine archival" });
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
      delegatedAmaFetch(["agents:read"], async (request) => {
        throw new Error(`AMA must not be called for an invalid filter: ${request.url}`);
      }),
    );
    for (const query of ["runtime=remote", "schedulable=yes", "search=", `search=${"x".repeat(161)}`]) {
      const response = await browserGet(`/agents?${query}`);
      expect(response.status, `${query}: ${await response.clone().text()}`).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ status: 400, type: `${resource}/problems/request-rejected` });
    }
  });
});
