import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApplication, jsonRequest, responseJson, type TestApplication } from "../helpers/app";
import { type LocalServer, listen } from "../helpers/protocol-servers";

function sendJson(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "content-type": status >= 400 ? "application/problem+json" : "application/json" });
  response.end(JSON.stringify(body));
}

async function encryptFixture(value: string) {
  const keyBytes = Uint8Array.from(atob("MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE="), (character) => character.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(value)));
  return {
    ciphertext: Buffer.from(encrypted).toString("base64url"),
    nonce: Buffer.from(nonce).toString("base64url"),
  };
}

function agent(uid: string) {
  return {
    metadata: { uid, projectId: "project-a", name: `Agent ${uid}`, description: null },
    identity: { issuer: "http://realmroot.invalid/api/auth", subject: `agt_${uid}`, username: uid, runtime: "ama" },
    spec: { runtime: "codex", systemPrompt: "Work safely.", provider: null, model: "gpt-5.6-sol", skills: [], allowedTools: [] },
    status: { phase: "active", ready: true, version: 1 },
  };
}

describe("session-authenticated AMA console BFF", () => {
  let app: TestApplication | undefined;
  let ama: LocalServer | undefined;
  let realmroot: LocalServer | undefined;

  beforeEach(() => {
    app = undefined;
    ama = undefined;
    realmroot = undefined;
  });

  afterEach(async () => {
    await app?.close();
    await ama?.close();
    await realmroot?.close();
  });

  async function setup(handler: Parameters<typeof listen>[0]) {
    let realmrootOrigin = "";
    realmroot = await listen(async (request, response) => {
      if (request.url === "/api/auth/.well-known/openid-configuration")
        return sendJson(response, {
          issuer: `${realmrootOrigin}/api/auth`,
          authorization_endpoint: `${realmrootOrigin}/api/auth/oauth2/authorize`,
          token_endpoint: `${realmrootOrigin}/api/auth/oauth2/token`,
          jwks_uri: `${realmrootOrigin}/api/auth/jwks`,
          revocation_endpoint: `${realmrootOrigin}/api/auth/oauth2/revoke`,
        });
      if (request.url === "/api/auth/oauth2/token" && request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        expect(form.get("grant_type")).toBe("refresh_token");
        expect(form.get("resource")).toBe(`${realmrootOrigin}/api`);
        return sendJson(response, {
          access_token: "rr-management-token",
          refresh_token: "rotated-refresh-token",
          token_type: "Bearer",
          expires_in: 300,
        });
      }
      response.writeHead(404).end();
    });
    realmrootOrigin = realmroot.origin;
    ama = await listen((request, response) => {
      if (request.url === "/api/v1/projects/project-a") return sendJson(response, { metadata: { uid: "project-a" }, status: { phase: "active" } });
      return handler(request, response);
    });
    app = await createTestApplication({
      AMA_ORIGIN: ama.origin,
      AMA_RESOURCE: `${ama.origin}/api`,
      REALMROOT_ISSUER: `${realmroot.origin}/api/auth`,
    });
    const encryptedRefresh = await encryptFixture("refresh-token");
    const encryptedAccess = await encryptFixture("unused-access-token");
    await app.db.batch([
      app.db.prepare("INSERT INTO tenants (id) VALUES (?)").bind("tenant-a"),
      app.db
        .prepare(
          `INSERT INTO ama_grants
             (tenant_id, subject_id, refresh_token_ciphertext, refresh_token_nonce,
              access_token_ciphertext, access_token_nonce, access_token_expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          "tenant-a",
          "local-controller",
          encryptedRefresh.ciphertext,
          encryptedRefresh.nonce,
          encryptedAccess.ciphertext,
          encryptedAccess.nonce,
          "2099-01-01T00:00:00.000Z",
        ),
    ]);
    const connectionResponse = await app.request(
      "/api/ama-connections",
      jsonRequest("POST", { resourceUrl: `${ama.origin}/api`, projectUri: `${ama.origin}/api/v1/projects/project-a` }, "console-connection"),
    );
    expect(connectionResponse.status).toBe(201);
    return responseJson<{ id: string }>(connectionResponse);
  }

  it("injects the same-user Realmroot management Bearer only at AMA Agent mutation boundaries", async () => {
    const received: Array<{ method: string | undefined; primary: string | undefined; secondary: string | undefined }> = [];
    const created = agent("agent-managed");
    const connection = await setup((request, response) => {
      if (request.url === "/api/v1/agents" && request.method === "POST") {
        received.push({
          method: request.method,
          primary: request.headers.authorization,
          secondary: request.headers["x-ama-realmroot-authorization"] as string | undefined,
        });
        response.setHeader("Location", "/api/v1/agents/agent-managed");
        return sendJson(response, created, 201);
      }
      if (request.url === "/api/v1/agents/agent-managed" && request.method === "DELETE") {
        received.push({
          method: request.method,
          primary: request.headers.authorization,
          secondary: request.headers["x-ama-realmroot-authorization"] as string | undefined,
        });
        response.writeHead(204).end();
        return;
      }
      return sendJson(response, { detail: "Unexpected upstream path." }, 500);
    });

    const createdResponse = await app!.request(
      `/api/console/ama-connections/${connection.id}/agents`,
      jsonRequest(
        "POST",
        {
          username: "managed-agent",
          metadata: { name: "Managed Agent" },
          spec: { runtime: "codex", systemPrompt: "Work safely.", skills: [], allowedTools: [] },
        },
        "managed-agent",
      ),
    );
    expect(createdResponse.status).toBe(201);
    expect(await createdResponse.text()).not.toContain("rr-management-token");
    const deletedResponse = await app!.request(`/api/console/ama-connections/${connection.id}/agents/agent-managed`, { method: "DELETE" });
    expect(deletedResponse.status).toBe(204);
    expect(received).toEqual([
      { method: "POST", primary: "Bearer ama-test-token", secondary: "Bearer rr-management-token" },
      { method: "DELETE", primary: "Bearer ama-test-token", secondary: "Bearer rr-management-token" },
    ]);
    const leaked = await app!.db
      .prepare("SELECT count(*) AS count FROM dispatch_outbox WHERE payload_json LIKE '%rr-management-token%'")
      .first<{ count: number }>();
    expect(leaked?.count).toBe(0);
  });

  it("serves direct Agent and Machine detail independently and makes unknown ids explicit", async () => {
    const upstreamPaths: string[] = [];
    const directAgent = agent("agent-direct");
    const environment = {
      metadata: { uid: "env-direct", projectId: "project-a", name: "Direct Environment", description: null },
      spec: { type: "self_hosted" },
      status: { phase: "active" },
    };
    const connection = await setup((request, response) => {
      upstreamPaths.push(request.url ?? "");
      if (request.url === "/api/v1/agents/agent-direct") return sendJson(response, directAgent);
      if (request.url === "/api/v1/agents/unknown") return sendJson(response, { detail: "Unknown AMA Agent." }, 404);
      if (request.url === "/api/v1/environments?limit=100") return sendJson(response, { data: [environment], pagination: { hasMore: false } });
      if (["/api/v1/runners?limit=100", "/api/v1/sessions?limit=100", "/api/v1/agents?limit=100"].includes(request.url ?? ""))
        return sendJson(response, { data: [], pagination: { hasMore: false } });
      return sendJson(response, { detail: "Not found." }, 404);
    });

    const agentResponse = await app!.request(`/api/console/ama-connections/${connection.id}/agents/agent-direct`);
    expect(agentResponse.status).toBe(200);
    expect(await responseJson(agentResponse)).toMatchObject({ metadata: { uid: "agent-direct" }, identity: { subject: "agt_agent-direct" } });
    expect(upstreamPaths).not.toContain("/api/v1/agents?limit=100");

    const unknownAgent = await app!.request(`/api/console/ama-connections/${connection.id}/agents/unknown`);
    expect(unknownAgent.status).toBe(404);
    expect(await responseJson(unknownAgent)).toMatchObject({ type: expect.stringMatching(/ama-request-failed$/), detail: "Unknown AMA Agent." });

    const machineResponse = await app!.request(`/api/console/ama-connections/${connection.id}/machines/env-direct`);
    expect(machineResponse.status).toBe(200);
    expect(await responseJson(machineResponse)).toMatchObject({ id: "env-direct", environment: { metadata: { uid: "env-direct" } } });

    const unknownMachine = await app!.request(`/api/console/ama-connections/${connection.id}/machines/unknown`);
    expect(unknownMachine.status).toBe(404);
    expect(await responseJson(unknownMachine)).toMatchObject({
      type: expect.stringMatching(/machine-not-found$/),
      detail: "AMA has no matching Environment.",
    });
  });

  it("follows AMA opaque cursors beyond 100 Agents without leaking cursor mechanics", async () => {
    const upstreamPaths: string[] = [];
    const connection = await setup((request, response) => {
      upstreamPaths.push(request.url ?? "");
      if (request.url === "/api/v1/agents?limit=100")
        return sendJson(response, {
          data: Array.from({ length: 100 }, (_, index) => agent(`agent-${index}`)),
          pagination: { hasMore: true, nextCursor: "opaque-page-two" },
        });
      if (request.url === "/api/v1/agents?limit=100&cursor=opaque-page-two")
        return sendJson(response, { data: [agent("agent-100")], pagination: { hasMore: false } });
      return sendJson(response, { detail: "Unexpected upstream path." }, 500);
    });

    const response = await app!.request(`/api/console/ama-connections/${connection.id}/agents`);
    expect(response.status).toBe(200);
    const body = await responseJson<{ items: Array<{ metadata: { uid: string } }>; pagination: { pageSize: number } }>(response);
    expect(body.items).toHaveLength(101);
    expect(body.items.at(-1)?.metadata.uid).toBe("agent-100");
    expect(body.pagination).toEqual({ pageSize: 101 });
    expect(upstreamPaths).toEqual(["/api/v1/agents?limit=100", "/api/v1/agents?limit=100&cursor=opaque-page-two"]);
  });

  it("maps a malformed AMA Agent collection to the stable contract problem", async () => {
    const connection = await setup((request, response) => {
      if (request.url === "/api/v1/agents?limit=100")
        return sendJson(response, {
          data: [{ metadata: { uid: "malformed", name: "Malformed" }, status: { phase: "active", ready: true } }],
          pagination: { hasMore: false },
        });
      return sendJson(response, { detail: "Unexpected upstream path." }, 500);
    });

    const response = await app!.request(`/api/console/ama-connections/${connection.id}/agents`);
    expect(response.status).toBe(502);
    expect(await responseJson(response)).toMatchObject({
      type: expect.stringMatching(/ama-invalid-response$/),
      title: "AMA Contract Mismatch",
      detail: "AMA returned an invalid Agent representation.",
    });
  });

  it("keeps Environment-backed Machines visible when optional AMA child sources fail", async () => {
    const environment = {
      metadata: { uid: "env-partial", projectId: "project-a", name: "Partial Environment", description: null },
      spec: { type: "self_hosted" },
      status: { phase: "active" },
    };
    const connection = await setup((request, response) => {
      if (request.url === "/api/v1/environments?limit=100") return sendJson(response, { data: [environment], pagination: { hasMore: false } });
      if (request.url === "/api/v1/runners?limit=100") return sendJson(response, { detail: "Runners unavailable." }, 503);
      if (["/api/v1/sessions?limit=100", "/api/v1/agents?limit=100"].includes(request.url ?? ""))
        return sendJson(response, { data: [], pagination: { hasMore: false } });
      return sendJson(response, { detail: "Unexpected upstream path." }, 500);
    });

    const response = await app!.request(`/api/console/ama-connections/${connection.id}/machines`);
    expect(response.status).toBe(200);
    expect(await responseJson(response)).toMatchObject({
      items: [
        {
          id: "env-partial",
          name: "Partial Environment",
          environment: { metadata: { uid: "env-partial" } },
          runners: [],
          warnings: ["AMA Runners are temporarily unavailable."],
        },
      ],
    });
  });

  it("rejects malformed Session, Agent creation, and Environment mutation representations", async () => {
    const connection = await setup((request, response) => {
      if (request.url === "/api/v1/sessions?limit=100")
        return sendJson(response, { data: [{ metadata: { uid: "session-bad" } }], pagination: { hasMore: false } });
      if (request.url === "/api/v1/agents" && request.method === "POST") return sendJson(response, { metadata: {} }, 201);
      if (request.url === "/api/v1/environments" && request.method === "POST") return sendJson(response, { metadata: {} }, 201);
      return sendJson(response, { detail: "Unexpected upstream path." }, 500);
    });

    const sessionResponse = await app!.request(`/api/console/ama-connections/${connection.id}/sessions`);
    expect(sessionResponse.status).toBe(502);
    expect(await responseJson(sessionResponse)).toMatchObject({ type: expect.stringMatching(/ama-invalid-response$/) });

    const agentResponse = await app!.request(
      `/api/console/ama-connections/${connection.id}/agents`,
      jsonRequest("POST", { username: "bad-agent" }, "malformed-agent"),
    );
    expect(agentResponse.status).toBe(502);
    expect(await responseJson(agentResponse)).toMatchObject({
      type: expect.stringMatching(/ama-invalid-response$/),
      detail: "AMA returned an invalid Agent representation.",
    });

    const environmentResponse = await app!.request(
      `/api/console/ama-connections/${connection.id}/machines`,
      jsonRequest("POST", { name: "Malformed Environment", type: "cloud" }, "malformed-environment"),
    );
    expect(environmentResponse.status).toBe(502);
    expect(await responseJson(environmentResponse)).toMatchObject({
      type: expect.stringMatching(/ama-invalid-response$/),
      detail: "AMA returned an invalid Environment representation.",
    });
  });

  it("rejects an otherwise valid synchronous Agent when AMA uses HTTP 200 instead of 201", async () => {
    const connection = await setup((request, response) => {
      if (request.url === "/api/v1/agents" && request.method === "POST") return sendJson(response, agent("agent-wrong-status"), 200);
      return sendJson(response, { detail: "Unexpected upstream path." }, 500);
    });

    const response = await app!.request(
      `/api/console/ama-connections/${connection.id}/agents`,
      jsonRequest(
        "POST",
        {
          username: "wrong-status",
          metadata: { name: "Wrong Status" },
          spec: { runtime: "codex", systemPrompt: "Work safely.", skills: [], allowedTools: [], subagents: [], mcpConnectors: [] },
        },
        "agent-wrong-status",
      ),
    );
    expect(response.status).toBe(502);
    expect(await responseJson(response)).toMatchObject({ type: expect.stringMatching(/ama-invalid-response$/) });
  });

  it("maps non-JSON AMA 5xx and 401 responses to stable boundary problems", async () => {
    let requests = 0;
    const connection = await setup((request, response) => {
      if (request.url === "/api/v1/agents?limit=100") {
        requests += 1;
        response.writeHead(requests === 1 ? 503 : 401, { "content-type": "text/plain" });
        return response.end(requests === 1 ? "upstream exploded" : "token expired");
      }
      return sendJson(response, { detail: "Unexpected upstream path." }, 500);
    });

    const unavailable = await app!.request(`/api/console/ama-connections/${connection.id}/agents`);
    expect(unavailable.status).toBe(503);
    expect(await responseJson(unavailable)).toMatchObject({
      type: expect.stringMatching(/ama-unavailable$/),
      detail: "AMA returned HTTP 503 without a readable problem response.",
    });

    const unauthorized = await app!.request(`/api/console/ama-connections/${connection.id}/agents`);
    expect(unauthorized.status).toBe(401);
    expect(await responseJson(unauthorized)).toMatchObject({
      type: expect.stringMatching(/ama-grant-required$/),
      detail: "The AMA authorization is missing or expired.",
    });
  });

  it("degrades a malformed optional nested Runner runtime to a Machine warning", async () => {
    const environment = {
      metadata: { uid: "env-invalid-runner", projectId: "project-a", name: "Invalid Runner Environment", description: null },
      spec: { type: "self_hosted" },
      status: { phase: "active" },
    };
    const connection = await setup((request, response) => {
      if (request.url === "/api/v1/environments?limit=100") return sendJson(response, { data: [environment], pagination: { hasMore: false } });
      if (request.url === "/api/v1/runners?limit=100")
        return sendJson(response, {
          data: [
            {
              id: "runner-invalid",
              name: "Invalid Runner",
              environmentId: "env-invalid-runner",
              state: "active",
              currentLoad: 0,
              maxConcurrent: 1,
              runtimes: [{ runtime: "codex", state: "ready", models: null }],
            },
          ],
          pagination: { hasMore: false },
        });
      if (["/api/v1/sessions?limit=100", "/api/v1/agents?limit=100"].includes(request.url ?? ""))
        return sendJson(response, { data: [], pagination: { hasMore: false } });
      return sendJson(response, { detail: "Unexpected upstream path." }, 500);
    });

    const response = await app!.request(`/api/console/ama-connections/${connection.id}/machines`);
    expect(response.status).toBe(200);
    expect(await responseJson(response)).toMatchObject({
      items: [
        {
          id: "env-invalid-runner",
          environment: { metadata: { uid: "env-invalid-runner" } },
          runners: [],
          warnings: ["AMA Runners are temporarily unavailable."],
        },
      ],
    });
  });

  it("rejects an Agent missing fields consumed by the product UI", async () => {
    const malformed = agent("agent-ui-malformed") as Record<string, any>;
    delete malformed.identity.username;
    delete malformed.spec.systemPrompt;
    delete malformed.status.version;
    const connection = await setup((request, response) => {
      if (request.url === "/api/v1/agents?limit=100") return sendJson(response, { data: [malformed], pagination: { hasMore: false } });
      return sendJson(response, { detail: "Unexpected upstream path." }, 500);
    });

    const response = await app!.request(`/api/console/ama-connections/${connection.id}/agents`);
    expect(response.status).toBe(502);
    expect(await responseJson(response)).toMatchObject({
      type: expect.stringMatching(/ama-invalid-response$/),
      detail: "AMA returned an invalid Agent representation.",
    });
  });

  it("rejects malformed direct Environment and Runner collections without changing Machine partial-failure semantics", async () => {
    const connection = await setup((request, response) => {
      if (request.url === "/api/v1/environments?limit=100")
        return sendJson(response, {
          data: [{ metadata: { uid: "env-malformed", name: null, description: null }, spec: { type: "self_hosted" }, status: { phase: "active" } }],
          pagination: { hasMore: false },
        });
      if (request.url === "/api/v1/runners?limit=100")
        return sendJson(response, {
          data: [
            {
              id: "runner-malformed",
              name: "Malformed Runner",
              environmentId: "env-malformed",
              state: "active",
              currentLoad: 0,
              maxConcurrent: 1,
              runtimes: [{ runtime: "codex", state: "ready", models: null }],
            },
          ],
          pagination: { hasMore: false },
        });
      return sendJson(response, { detail: "Unexpected upstream path." }, 500);
    });

    const environments = await app!.request(`/api/console/ama-connections/${connection.id}/environments`);
    expect(environments.status).toBe(502);
    expect(await responseJson(environments)).toMatchObject({
      type: expect.stringMatching(/ama-invalid-response$/),
      detail: "AMA returned an invalid Environment representation.",
    });

    const runners = await app!.request(`/api/console/ama-connections/${connection.id}/runners`);
    expect(runners.status).toBe(502);
    expect(await responseJson(runners)).toMatchObject({
      type: expect.stringMatching(/ama-invalid-response$/),
      detail: "AMA returned an invalid Runner representation.",
    });
  });
});
