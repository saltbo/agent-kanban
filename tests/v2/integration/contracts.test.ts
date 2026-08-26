import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AK_ORIGIN, API_VERSION, createTestApplication, jsonRequest, responseJson, type TestApplication } from "../helpers/app";

describe("Agent Kanban v2 HTTP and D1 contracts", () => {
  let app!: TestApplication;

  beforeEach(async () => {
    app = await createTestApplication();
  });

  afterEach(() => app?.close());

  it("publishes health, RFC 9728 metadata, OpenAPI and the only v2 Skill without authentication", async () => {
    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
    expect(await responseJson(health)).toEqual({ status: "ok", version: API_VERSION });

    const metadata = await responseJson<Record<string, unknown>>(await app.request("/.well-known/oauth-protected-resource/api"));
    expect(metadata).toMatchObject({ resource: `${AK_ORIGIN}/api`, authorization_servers: ["http://realmroot.invalid/api/auth"] });
    expect(metadata.scopes_supported).toContain("work:write");

    const index = await responseJson<{
      $schema: string;
      skills: Array<{ name: string; type: string; url: string; digest: string }>;
    }>(await app.request("/.well-known/agent-skills/index.json"));
    const skillResponse = await app.request("/skills/agent-kanban/SKILL.md");
    const skillBytes = new Uint8Array(await skillResponse.arrayBuffer());
    const skill = new TextDecoder().decode(skillBytes);
    expect(index).toMatchObject({ $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json" });
    expect(index.skills).toEqual([
      expect.objectContaining({
        name: "agent-kanban",
        type: "skill-md",
        url: `${AK_ORIGIN}/skills/agent-kanban/SKILL.md`,
        digest: `sha256:${createHash("sha256").update(skillBytes).digest("hex")}`,
      }),
    ]);
    expect(skill).toContain("realmroot toolbox agent-kanban");
    expect(skill).not.toContain("ak start");

    const openapi = await responseJson<{
      openapi: string;
      info: Record<string, unknown>;
      paths: Record<string, Record<string, any>>;
      components: {
        parameters: Record<string, { in: string; name: string }>;
        securitySchemes: {
          RealmrootOAuth: {
            "x-dpop-required": boolean;
            flows: { authorizationCode: { authorizationUrl: string; tokenUrl: string } };
          };
        };
      };
    }>(await app.request("/api/openapi.json"));
    expect(openapi.openapi).toBe("3.1.0");
    expect(openapi.info["x-realmroot-toolbox-name"]).toBe("agent-kanban");
    expect(openapi.components.securitySchemes.RealmrootOAuth["x-dpop-required"]).toBe(true);
    expect(openapi.components.securitySchemes.RealmrootOAuth.flows.authorizationCode).toMatchObject({
      authorizationUrl: "http://realmroot.invalid/api/auth/oauth2/authorize",
      tokenUrl: "http://realmroot.invalid/api/auth/oauth2/token",
    });
    expect(Object.keys(openapi.paths)).not.toContain(expect.stringMatching(/^\/v1(?:\/|$)/));
    expect(Object.keys(openapi.paths)).not.toContain(expect.stringMatching(/^\/api\/console(?:\/|$)/));
    for (const pathItem of Object.values(openapi.paths)) {
      for (const operation of Object.values(pathItem)) {
        expect(operation.security).toEqual([{ RealmrootOAuth: [expect.stringMatching(/:(?:read|write)$/)] }]);
        expect(operation.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: "API-Version", required: true })]));
        const parameters = operation.parameters.map((parameter: { $ref?: string; in?: string; name?: string }) => {
          if (!parameter.$ref) return parameter;
          const name = parameter.$ref.split("/").at(-1);
          return name ? openapi.components.parameters[name] : undefined;
        });
        const parameterKeys = parameters.map((parameter: { in?: string; name?: string }) => `${parameter.in}:${parameter.name}`);
        expect(new Set(parameterKeys).size, operation.operationId).toBe(parameterKeys.length);
        if (operation.operationId?.startsWith("create")) {
          expect(operation.parameters).toEqual(expect.arrayContaining([{ $ref: "#/components/parameters/IdempotencyKey" }]));
        }
      }
    }
    for (const operationId of ["createBoardMembership", "createTaskAssignment"]) {
      const operation = Object.values(openapi.paths)
        .flatMap((pathItem) => Object.values(pathItem))
        .find((candidate) => candidate.operationId === operationId);
      const schema = operation?.requestBody?.content?.["application/json"]?.schema;
      expect(schema?.required).toContain("agentId");
      expect(schema?.properties).toHaveProperty("agentId");
      expect(schema?.properties).not.toHaveProperty("agent");
    }
  });

  it("fails protected requests closed on API version and emits RFC 9457 request-correlated problems", async () => {
    const missing = await app.request("/api/boards", { headers: { "API-Version": "" } });
    expect(missing.status).toBe(400);
    expect(missing.headers.get("content-type")).toContain("application/problem+json");
    const requestId = missing.headers.get("request-id");
    expect(requestId).toBeTruthy();
    expect(await responseJson(missing)).toMatchObject({
      type: "https://agent-kanban.dev/problems/api-version-required",
      status: 400,
      instance: `urn:request:${requestId}`,
    });

    const unsupported = await app.request("/api/boards", { headers: { "API-Version": "1999-01-01" } });
    expect(unsupported.status).toBe(400);
    expect(unsupported.headers.get("api-version")).toBeNull();

    const response = await app.request("/api/boards");
    expect(response.status).toBe(200);
    expect(response.headers.get("vary")).toContain("API-Version");
    expect(response.headers.get("api-version")).toBe(API_VERSION);
  });

  it("has no mounted v1 API or retired CLI/daemon resources", async () => {
    for (const path of ["/api/v1/boards", "/api/agents", "/api/machines", "/api/runtimes", "/api/daemon/heartbeat"]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(404);
    }
  });

  it("uses configured canonical origins despite forwarded-host poisoning", async () => {
    await app.close();
    app = await createTestApplication({ AK_PUBLIC_ORIGIN: "https://ak.example.test", AK_RESOURCE: "https://ak.example.test/api" });
    const poisoned = { headers: { Host: "evil.test", "X-Forwarded-Host": "evil.test", "X-Forwarded-Proto": "http" } };
    const metadata = await responseJson<any>(await app.request("/.well-known/oauth-protected-resource/api", poisoned));
    expect(metadata.resource).toBe("https://ak.example.test/api");
    const board = await responseJson<any>(await app.request("/api/boards", jsonRequest("POST", { name: "Canonical" }, "canonical")));
    expect(board.links.self).toMatch(/^https:\/\/ak\.example\.test\/api\/boards\//);
  });

  it("atomically replays identical POSTs and rejects key reuse with a different representation", async () => {
    const create = jsonRequest("POST", { name: "Platform", description: "v2" }, "same-key");
    const [first, concurrent] = await Promise.all([app.request("/api/boards", create), app.request("/api/boards", create)]);
    expect([first.status, concurrent.status].sort()).toEqual([201, 409]);
    const succeeded = first.status === 201 ? first : concurrent;
    const pending = first.status === 409 ? first : concurrent;
    expect(await responseJson(pending)).toMatchObject({ type: "https://agent-kanban.dev/problems/idempotency-in-progress" });
    expect(pending.headers.get("retry-after")).toBe("1");
    const firstBody = await responseJson<{ id: string }>(succeeded);
    const replay = await app.request("/api/boards", create);
    expect(replay.status).toBe(201);
    const replayBody = await responseJson<{ id: string }>(replay);
    expect(replayBody.id).toBe(firstBody.id);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");

    const conflict = await app.request("/api/boards", jsonRequest("POST", { name: "Different" }, "same-key"));
    expect(conflict.status).toBe(409);
    expect(await responseJson(conflict)).toMatchObject({ type: "https://agent-kanban.dev/problems/idempotency-conflict" });
    const count = await app.db.prepare("SELECT count(*) AS count FROM boards").first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("recovers a committed resource when its idempotency response record was not finalized", async () => {
    const request = jsonRequest("POST", { name: "Recovered board" }, "recover-after-commit");
    const created = await app.request("/api/boards", request);
    expect(created.status).toBe(201);
    const board = await responseJson<{ id: string }>(created);

    await app.db
      .prepare(
        "UPDATE idempotency_records SET status = 0, response_json = '{}', location = NULL, updated_at = datetime('now', '-10 minutes') WHERE tenant_id = ? AND key = ?",
      )
      .bind("tenant-a", "recover-after-commit")
      .run();

    const recovered = await app.request("/api/boards", request);
    expect(recovered.status).toBe(201);
    expect(recovered.headers.get("idempotency-replayed")).toBe("true");
    expect(await responseJson(recovered)).toMatchObject({ id: board.id, name: "Recovered board" });
    expect((await app.db.prepare("SELECT count(*) AS count FROM boards WHERE id = ?").bind(board.id).first<{ count: number }>())?.count).toBe(1);
    expect(
      (
        await app.db
          .prepare("SELECT status FROM idempotency_records WHERE tenant_id = ? AND key = ?")
          .bind("tenant-a", "recover-after-commit")
          .first<{ status: number }>()
      )?.status,
    ).toBe(201);
  });

  it("enforces ETag preconditions and prevents lost updates", async () => {
    const created = await app.request("/api/boards", jsonRequest("POST", { name: "Board" }, "board-etag"));
    const board = await responseJson<{ id: string }>(created);
    const current = await app.request(`/api/boards/${board.id}`);
    expect(current.headers.get("etag")).toBe('"1"');

    const without = await app.request(`/api/boards/${board.id}`, jsonRequest("PATCH", { description: "late" }));
    expect(without.status).toBe(428);
    const changed = await app.request(`/api/boards/${board.id}`, {
      ...jsonRequest("PATCH", { description: "new" }),
      headers: { ...jsonRequest("PATCH", {}).headers, "If-Match": '"1"' },
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).toBe('"2"');
    const stale = await app.request(`/api/boards/${board.id}`, {
      ...jsonRequest("PATCH", { description: "stale" }),
      headers: { ...jsonRequest("PATCH", {}).headers, "If-Match": '"1"' },
    });
    expect(stale.status).toBe(412);
  });

  it("binds opaque cursors to tenant, API version and the exact filtered query", async () => {
    for (const name of ["A", "B", "C"]) {
      expect((await app.request("/api/boards", jsonRequest("POST", { name }, `board-${name}`))).status).toBe(201);
    }
    const first = await responseJson<{ pagination: { nextPageToken: string } }>(await app.request("/api/boards?pageSize=1"));
    expect(first.pagination.nextPageToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(() => JSON.parse(Buffer.from(first.pagination.nextPageToken, "base64url").toString("utf8"))).toThrow();
    expect((await app.request(`/api/boards?pageSize=1&pageToken=${first.pagination.nextPageToken}`)).status).toBe(200);
    expect((await app.request(`/api/repositories?pageSize=1&pageToken=${first.pagination.nextPageToken}`)).status).toBe(400);
    expect((await app.request(`/api/boards?pageSize=1&pageToken=${first.pagination.nextPageToken}`, {}, { tenant: "tenant-b" })).status).toBe(400);
  });

  it("isolates tenant resources and rejects cross-tenant child references", async () => {
    const boardA = await responseJson<{ id: string }>(await app.request("/api/boards", jsonRequest("POST", { name: "A" }, "a")));
    const repositoryB = await responseJson<{ id: string }>(
      await app.request("/api/repositories", jsonRequest("POST", { name: "B", url: "https://example.com/b.git" }, "b"), { tenant: "tenant-b" }),
    );
    expect((await app.request(`/api/boards/${boardA.id}`, {}, { tenant: "tenant-b" })).status).toBe(404);
    const cross = await app.request(`/api/boards/${boardA.id}/tasks`, jsonRequest("POST", { title: "Cross", repositoryId: repositoryB.id }, "cross"));
    expect(cross.status).toBe(404);
    expect((await app.db.prepare("SELECT count(*) AS count FROM tasks").first<{ count: number }>())?.count).toBe(0);
  });
});
