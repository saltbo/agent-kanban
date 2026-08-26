import { generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../../apps/web/server/routes";
import { AK_ORIGIN, API_VERSION, createTestApplication, responseJson, type TestApplication } from "../helpers/app";
import { dpopProof, startAmaServer, startOidcServer } from "../helpers/protocol-servers";

describe("Realmroot native Resource Server authentication", () => {
  let app!: TestApplication;
  let oidc!: Awaited<ReturnType<typeof startOidcServer>>;
  let ama!: Awaited<ReturnType<typeof startAmaServer>>;

  beforeEach(async () => {
    oidc = await startOidcServer();
    ama = await startAmaServer({ issuer: oidc.issuer, subject: "agent-a", runtime: "ama" });
    app = await createTestApplication({
      REALMROOT_ISSUER: oidc.issuer,
      AMA_ORIGIN: ama.origin,
      AMA_RESOURCE: `${ama.origin}/api`,
      AK_DEV_AUTH_SECRET: undefined,
      REALMROOT_CLI_CLIENT_ID: "ak-cli",
    });
  });

  afterEach(async () => {
    await app?.close();
    await ama?.close();
    await oidc?.close();
  });

  const raw = (path: string, init: RequestInit = {}) => api.request(`${AK_ORIGIN}${path}`, init, app!.env);

  it("accepts an exact-issuer/audience human Bearer token and enforces per-operation scope", async () => {
    const readToken = await oidc.accessToken({ audience: `${AK_ORIGIN}/api`, scope: "boards:read", clientId: "ak-cli" });
    const list = await raw("/api/boards", { headers: { Authorization: `Bearer ${readToken}`, "API-Version": API_VERSION } });
    expect(list.status).toBe(200);

    const write = await raw("/api/boards", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${readToken}`,
        "API-Version": API_VERSION,
        "Content-Type": "application/json",
        "Idempotency-Key": "no-write",
      },
      body: JSON.stringify({ name: "Forbidden" }),
    });
    expect(write.status).toBe(403);
    expect(await responseJson(write)).toMatchObject({ type: "https://agent-kanban.dev/problems/insufficient-scope" });
  });

  it("rejects wrong audience, issuer-client misuse and unsigned credential syntax", async () => {
    const wrongAudience = await oidc.accessToken({ audience: "http://different.test/api", scope: "boards:read", clientId: "ak-cli" });
    expect((await raw("/api/boards", { headers: { Authorization: `Bearer ${wrongAudience}`, "API-Version": API_VERSION } })).status).toBe(401);
    const wrongClient = await oidc.accessToken({ audience: `${AK_ORIGIN}/api`, scope: "boards:read", clientId: "unregistered-client" });
    expect((await raw("/api/boards", { headers: { Authorization: `Bearer ${wrongClient}`, "API-Version": API_VERSION } })).status).toBe(401);
    expect((await raw("/api/boards", { headers: { Authorization: "Bearer opaque", "API-Version": API_VERSION } })).status).toBe(401);
    const malformedDpopCredential = await raw("/api/boards", {
      headers: { Authorization: "DPoP invalid.invalid.invalid", DPoP: "invalid.invalid.invalid", "API-Version": API_VERSION },
    });
    expect(malformedDpopCredential.status).toBe(401);
    expect(await responseJson(malformedDpopCredential)).toMatchObject({ type: "https://agent-kanban.dev/problems/invalid-credentials" });
  });

  it("requires DPoP for stable Agents, validates proof binding, and rejects replay", async () => {
    const dpop = await generateKeyPair("ES256");
    const token = await oidc.accessToken({
      audience: `${AK_ORIGIN}/api`,
      scope: "boards:read",
      tenant: "tenant-a",
      actor: { issuer: oidc.issuer, subject: "agent-a" },
      clientId: "ak-cli",
      dpopPublicKey: dpop.publicKey,
    });
    const url = `${AK_ORIGIN}/api/boards`;
    const proof = await dpopProof({ privateKey: dpop.privateKey, publicKey: dpop.publicKey, accessToken: token, method: "GET", url, jti: "once" });
    const headers = { Authorization: `DPoP ${token}`, DPoP: proof, "API-Version": API_VERSION };
    expect((await raw("/api/boards", { headers })).status).toBe(200);
    expect((await raw("/api/boards", { headers })).status).toBe(401);

    expect((await raw("/api/boards", { headers: { Authorization: `Bearer ${token}`, "API-Version": API_VERSION } })).status).toBe(401);
    const malformed = await raw("/api/boards", {
      headers: { Authorization: `DPoP ${token}`, DPoP: "not-a-proof", "API-Version": API_VERSION },
    });
    expect(malformed.status).toBe(401);
    expect(await responseJson(malformed)).toMatchObject({ type: "https://agent-kanban.dev/problems/invalid-credentials" });
    const wrongTarget = await dpopProof({
      privateKey: dpop.privateKey,
      publicKey: dpop.publicKey,
      accessToken: token,
      method: "POST",
      url,
    });
    expect((await raw("/api/boards", { headers: { Authorization: `DPoP ${token}`, DPoP: wrongTarget, "API-Version": API_VERSION } })).status).toBe(
      401,
    );
  });

  it("recognizes a verified Realmroot act without legacy profile claims and enforces membership then assignment", async () => {
    await app.db.prepare("INSERT INTO tenants (id) VALUES (?)").bind("tenant-agent").run();
    await app.db.prepare("INSERT INTO boards (id, tenant_id, name) VALUES (?, ?, ?)").bind("board-agent", "tenant-agent", "Agent boundary").run();
    await app.db
      .prepare("INSERT INTO tasks (id, tenant_id, board_id, title, created_by_subject) VALUES (?, ?, ?, ?, ?)")
      .bind("task-agent", "tenant-agent", "board-agent", "Assigned work", "controller")
      .run();
    await app.db
      .prepare(
        `INSERT INTO ama_grants
           (tenant_id, subject_id, refresh_token_ciphertext, refresh_token_nonce,
            access_token_ciphertext, access_token_nonce, access_token_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind("tenant-agent", "controller", "unused", "unused", "unused", "unused", "2099-01-01T00:00:00.000Z")
      .run();
    await app.db
      .prepare("INSERT INTO ama_connections (id, tenant_id, resource_url, project_uri, authorized_subject_id) VALUES (?, ?, ?, ?, ?)")
      .bind("connection-agent", "tenant-agent", `${ama.origin}/api`, ama.projectUri, "controller")
      .run();
    await app.db
      .prepare("INSERT INTO board_execution_bindings (id, tenant_id, board_id, ama_connection_id) VALUES (?, ?, ?, ?)")
      .bind("binding-agent", "tenant-agent", "board-agent", "connection-agent")
      .run();
    await app.db
      .prepare("INSERT INTO task_assignments (id, tenant_id, task_id, agent_id) VALUES (?, ?, ?, ?)")
      .bind("assignment-other", "tenant-agent", "task-agent", "agent-other")
      .run();
    await app.db
      .prepare("INSERT INTO task_runs (id, tenant_id, task_id, assignment_id, status) VALUES (?, ?, ?, ?, ?)")
      .bind("run-agent", "tenant-agent", "task-agent", "assignment-other", "running")
      .run();

    const dpop = await generateKeyPair("ES256");
    const token = await oidc.accessToken({
      audience: `${AK_ORIGIN}/api`,
      scope: "boards:write work:write",
      tenant: "tenant-agent",
      actor: { issuer: oidc.issuer, subject: "agent-a" },
      dpopPublicKey: dpop.publicKey,
    });
    const agentRequest = async (path: string, method: string, body: unknown, jti: string, extraHeaders: Record<string, string> = {}) => {
      const url = `${AK_ORIGIN}${path}`;
      const proof = await dpopProof({ privateKey: dpop.privateKey, publicKey: dpop.publicKey, accessToken: token, method, url, jti });
      return raw(path, {
        method,
        headers: {
          Authorization: `DPoP ${token}`,
          DPoP: proof,
          "API-Version": API_VERSION,
          "Content-Type": "application/json",
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      });
    };

    await app.db
      .prepare("INSERT INTO board_memberships (id, tenant_id, board_id, agent_id, capabilities_json) VALUES (?, ?, ?, ?, ?)")
      .bind("membership-other", "tenant-agent", "board-agent", "agent-other", '["work"]')
      .run();

    const noMembership = await agentRequest("/api/boards/board-agent", "PATCH", { description: "forbidden" }, "membership", {
      "If-Match": 'W/"1"',
    });
    expect(noMembership.status).toBe(403);
    expect(await responseJson(noMembership)).toMatchObject({ type: "https://agent-kanban.dev/problems/board-capability-required" });

    await app.db
      .prepare("INSERT INTO board_memberships (id, tenant_id, board_id, agent_id, capabilities_json) VALUES (?, ?, ?, ?, ?)")
      .bind("membership-agent", "tenant-agent", "board-agent", "agent-a", '["work"]')
      .run();
    const filteredLookupsBefore = ama.requests.filter((request) => request.path.startsWith("/api/v1/agents?identityIssuer=")).length;
    const noAssignment = await agentRequest(
      "/api/task-runs/run-agent/progress-entries",
      "POST",
      { kind: "checkpoint", body: "must remain forbidden" },
      "assignment",
      { "Idempotency-Key": "unassigned-agent" },
    );
    expect(noAssignment.status).toBe(403);
    expect(await responseJson(noAssignment)).toMatchObject({ type: "https://agent-kanban.dev/problems/assignment-required" });
    const filteredLookupsAfter = ama.requests.filter((request) => request.path.startsWith("/api/v1/agents?identityIssuer=")).length;
    expect(filteredLookupsAfter - filteredLookupsBefore).toBe(1);
  });

  it("fails closed for partial act, non-Realmroot-Agent clients, and Agents without DPoP", async () => {
    const url = `${AK_ORIGIN}/api/boards`;
    const dpop = await generateKeyPair("ES256");
    for (const [name, actor] of [
      ["issuer-only", { issuer: oidc.issuer }],
      ["subject-only", { subject: "agent-a" }],
    ] as const) {
      const token = await oidc.accessToken({
        audience: `${AK_ORIGIN}/api`,
        scope: "boards:read",
        actor,
        dpopPublicKey: dpop.publicKey,
      });
      const proof = await dpopProof({ privateKey: dpop.privateKey, publicKey: dpop.publicKey, accessToken: token, method: "GET", url, jti: name });
      expect((await raw("/api/boards", { headers: { Authorization: `DPoP ${token}`, DPoP: proof, "API-Version": API_VERSION } })).status).toBe(401);
    }

    const wrongClient = await oidc.accessToken({
      audience: `${AK_ORIGIN}/api`,
      scope: "boards:read",
      clientId: "unconfigured-cli",
      actor: { issuer: oidc.issuer, subject: "agent-a" },
      dpopPublicKey: dpop.publicKey,
    });
    const wrongClientProof = await dpopProof({
      privateKey: dpop.privateKey,
      publicKey: dpop.publicKey,
      accessToken: wrongClient,
      method: "GET",
      url,
      jti: "wrong-client",
    });
    expect(
      (await raw("/api/boards", { headers: { Authorization: `DPoP ${wrongClient}`, DPoP: wrongClientProof, "API-Version": API_VERSION } })).status,
    ).toBe(401);

    const bearerAgent = await oidc.accessToken({
      audience: `${AK_ORIGIN}/api`,
      scope: "boards:read",
      actor: { issuer: oidc.issuer, subject: "agent-a" },
    });
    expect((await raw("/api/boards", { headers: { Authorization: `Bearer ${bearerAgent}`, "API-Version": API_VERSION } })).status).toBe(401);
  });

  it("enforces the persisted OAuth grant scopes for BFF sessions", async () => {
    const token = "partial-web-session";
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await app.db.prepare("INSERT INTO tenants (id) VALUES (?)").bind("tenant-web").run();
    await app.db
      .prepare(
        "INSERT INTO web_sessions (id, token_hash, tenant_id, subject_id, role, scopes_json, csrf_token, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind("web-session", tokenHash, "tenant-web", "controller", "admin", '["boards:read"]', "csrf-web", "2099-01-01T00:00:00.000Z")
      .run();
    const headers = { Cookie: `ak_session=${token}`, "API-Version": API_VERSION };
    expect((await raw("/api/boards", { headers })).status).toBe(200);
    const forbidden = await raw("/api/boards", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": "partial", "X-CSRF-Token": "csrf-web" },
      body: JSON.stringify({ name: "No grant" }),
    });
    expect(forbidden.status).toBe(403);
    expect(await responseJson(forbidden)).toMatchObject({ type: "https://agent-kanban.dev/problems/insufficient-scope" });

    await app.db.prepare("UPDATE web_sessions SET scopes_json = ? WHERE id = ?").bind('["boards:read","boards:write"]', "web-session").run();
    const allowed = await raw("/api/boards", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": "full", "X-CSRF-Token": "csrf-web" },
      body: JSON.stringify({ name: "Granted" }),
    });
    expect(allowed.status).toBe(201);
  });
});

import { createHash } from "node:crypto";
