// @vitest-environment node

import { describe, expect, it } from "vitest";
import { RESOURCE_SCOPES } from "../../../server/auth/realmroot";
import type { Env } from "../../../server/env";
import { api } from "../../../server/http/app";

type Operation = Record<string, unknown>;
type OpenApiDocument = {
  openapi: string;
  info: { title: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, Operation>>;
  components: {
    parameters: Record<string, Record<string, unknown>>;
    schemas: Record<string, unknown>;
    securitySchemes: { realmroot: { openIdConnectUrl: string; "x-scopes-supported": Record<string, string> } };
  };
};

const env = {
  OIDC_ISSUER: "https://id.realmroot.dev/api/auth",
  AK_PUBLIC_ORIGIN: "https://agent-kanban.test",
} as Env;

async function document(path = "/api/openapi.json"): Promise<OpenApiDocument> {
  const response = await api.request(path, {}, env);
  expect(response.status).toBe(200);
  return (await response.json()) as OpenApiDocument;
}

describe("published Resource Server contract", () => {
  it("publishes protected-resource and Toolbox discovery", async () => {
    const response = await api.request("/api", {}, env);

    expect(response.status).toBe(200);
    expect(response.headers.get("link")).toContain("/api/openapi.json");
    await expect(response.json()).resolves.toMatchObject({
      resource: `${env.AK_PUBLIC_ORIGIN}/api`,
      openapi: `${env.AK_PUBLIC_ORIGIN}/api/openapi.json`,
    });
    const toolbox = await document();
    expect(toolbox).toMatchObject({
      openapi: "3.1.0",
      info: { title: "Agent Kanban API" },
      servers: [{ url: `${env.AK_PUBLIC_ORIGIN}/api` }],
    });
    expect((await api.request("/api/toolbox/openapi.json", {}, env)).status).toBe(404);
  });

  it("publishes one canonical API contract for OAuth tokens and browser sessions", async () => {
    const contract = await document();
    const additionalOperations = [
      ["/boards/{boardId}", "patch"],
      ["/boards/{boardId}", "delete"],
      ["/boards/{boardId}/labels", "post"],
      ["/boards/{boardId}/labels/{labelName}", "patch"],
      ["/boards/{boardId}/labels/{labelName}", "delete"],
      ["/boards/{boardId}/stream", "get"],
      ["/repositories/{repositoryId}", "delete"],
      ["/tasks/{taskId}", "patch"],
      ["/tasks/{taskId}", "delete"],
      ["/tasks/{taskId}/session", "get"],
      ["/tasks/{taskId}/session/ws", "get"],
      ["/tasks/{taskId}/stream", "get"],
      ["/tasks/{taskId}/claims", "post"],
    ] as const;

    expect(Object.values(contract.paths).flatMap((pathItem) => Object.keys(pathItem).filter((key) => key !== "parameters"))).toHaveLength(37);
    for (const [path, method] of additionalOperations) {
      expect(contract.paths[path]?.[method], `${method.toUpperCase()} ${path}`).toBeDefined();
    }
    expect(contract.paths["/github-app/config"].get).toMatchObject({
      operationId: "getGithubAppConfiguration",
      security: [{ realmroot: ["repository:read"] }, { browserSession: [] }],
    });
    expect(contract.paths["/github-app/repositories"].get).toMatchObject({
      operationId: "listGithubAppRepositories",
      security: [{ realmroot: ["repository:read"] }, { browserSession: [] }],
    });
    expect(contract.paths["/repository-installations/{installationId}"].put).toMatchObject({
      operationId: "replaceRepositoryInstallation",
      security: [{ realmroot: ["repository:write"] }, { browserSession: [] }],
      parameters: expect.arrayContaining([{ $ref: "#/components/parameters/CsrfToken" }]),
    });
    expect(contract.paths).not.toHaveProperty("/github-app/setup");
    expect(contract.components.schemas.GithubAppConfiguration).toMatchObject({
      required: expect.arrayContaining(["installUrl"]),
      properties: expect.objectContaining({ installUrl: expect.any(Object) }),
    });
    expect(contract.components.schemas.GithubAppRepository).toMatchObject({
      required: expect.arrayContaining(["fullName", "cloneUrl", "alreadyAdded"]),
      properties: expect.objectContaining({ fullName: expect.any(Object), cloneUrl: expect.any(Object), alreadyAdded: expect.any(Object) }),
    });
    for (const [path, pathItem] of Object.entries(contract.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (method === "parameters") continue;
        const scope = ((operation.security as Array<Record<string, string[]>>)[0].realmroot ?? []) as string[];
        expect(scope, `${method.toUpperCase()} ${path}`).toHaveLength(1);
        expect(operation.security, `${method.toUpperCase()} ${path}`).toEqual([{ realmroot: scope }, { browserSession: [] }]);
      }
    }
    expect(JSON.stringify(contract)).not.toContain('"x-audience"');
    expect(Object.keys(contract.components.schemas)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^Web/)]));
    expect((contract.components.securitySchemes as Record<string, unknown>).browserSession).toEqual({
      type: "apiKey",
      in: "cookie",
      name: "ak_session",
      description: expect.any(String),
    });
    expect(contract.components.parameters.CsrfToken).toMatchObject({
      name: "X-CSRF-Token",
      in: "header",
      required: false,
      schema: { type: "string" },
    });
    for (const path of ["/boards/{boardId}/stream", "/tasks/{taskId}/stream"] as const) {
      expect(contract.paths[path].get.responses).toMatchObject({
        "200": { content: { "text/event-stream": { schema: { type: "string" } } } },
      });
    }
    expect(contract.paths["/tasks/{taskId}/session/ws"].get.responses).toMatchObject({
      "101": { description: "WebSocket relay established" },
      "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/TaskSessionSocket" } } } },
    });
    const problem = { schema: { $ref: "#/components/schemas/Problem" } };
    for (const path of ["/tasks/{taskId}/session", "/tasks/{taskId}/session/ws"] as const) {
      const responses = contract.paths[path].get.responses as Record<string, { content?: Record<string, unknown> }>;
      for (const status of ["401", "403", "404", "500", "502", "503"] as const) {
        expect(responses[status].content, `${status} GET ${path}`).toEqual({ "application/problem+json": problem });
      }
    }
    expect((await api.request("/api/docs/openapi.json", {}, env)).status).toBe(404);
  });

  it("exposes only the Task wait command with x-cli-name", async () => {
    const toolbox = await document();
    const commands = Object.values(toolbox.paths)
      .flatMap((path) => Object.values(path))
      .filter((operation) => operation && typeof operation === "object" && "x-cli-name" in operation)
      .map((operation) => operation["x-cli-name"])
      .sort();

    expect(commands).toEqual(["wait"]);
    for (const path of ["/agents", "/agents/{agentId}", "/agents/{agentId}/permissions", "/machines", "/machines/{machineId}"]) {
      expect(toolbox.paths).toHaveProperty(path);
    }
    expect(toolbox.paths).not.toHaveProperty("/ama/provision");
    expect(toolbox.components.schemas).toHaveProperty("Agent");
    expect(toolbox.components.schemas).toHaveProperty("Machine");
    expect(Object.keys(toolbox.components.schemas)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^Ama/)]));
  });

  it("publishes API-Version as an optional override for resource-first commands", async () => {
    const toolbox = await document();
    expect(toolbox.components.parameters.ApiVersion).toMatchObject({
      name: "API-Version",
      in: "header",
      description: expect.stringContaining("Optional version override"),
      schema: { type: "string", const: "2026-08-29" },
    });
    expect(toolbox.components.parameters.ApiVersion).not.toHaveProperty("required");
    for (const path of Object.values(toolbox.paths)) {
      for (const operation of Object.values(path)) {
        if (!operation || typeof operation !== "object" || !("x-cli-name" in operation)) continue;
        expect(operation.parameters).toEqual(expect.arrayContaining([{ $ref: "#/components/parameters/ApiVersion" }]));
      }
    }
  });

  it("publishes only canonical Agency runtimes in the Task Claim representation", async () => {
    const toolbox = await document();

    expect(toolbox.components.schemas.TaskClaim).toMatchObject({
      required: expect.arrayContaining(["runtime"]),
      properties: {
        runtime: { type: "string", enum: ["enbor", "claude-code", "codex", "copilot"] },
      },
    });
  });

  it("exposes generic verb-first operations without hiding them", async () => {
    const toolbox = await document();
    for (const [path, method] of [
      ["/boards", "get"],
      ["/boards", "post"],
      ["/boards/{boardId}", "get"],
      ["/repositories", "get"],
      ["/repositories", "post"],
      ["/repositories/{repositoryId}", "get"],
      ["/tasks", "get"],
      ["/tasks", "post"],
      ["/tasks/{taskId}", "get"],
      ["/tasks/{taskId}/notes", "get"],
      ["/tasks/{taskId}/notes", "post"],
      ["/tasks/{taskId}/notes/{noteId}", "get"],
    ] as const) {
      expect(toolbox.paths[path]?.[method]).not.toHaveProperty("x-cli-hidden");
      expect(toolbox.paths[path]?.[method]).not.toHaveProperty("x-cli-name");
    }
    expect(JSON.stringify(toolbox)).not.toContain("x-cli-hidden");
  });

  it("groups every operation by the resource protected by its Realmroot scope", async () => {
    const toolbox = await document();
    const operations = Object.entries(toolbox.paths).flatMap(([path, pathItem]) =>
      Object.entries(pathItem)
        .filter(([method]) => method !== "parameters")
        .map(([method, operation]) => ({ path, method, operation })),
    );

    for (const { path, method, operation } of operations) {
      const scopes = ((operation.security as Array<Record<string, string[]>> | undefined)?.[0]?.realmroot ?? []) as string[];
      expect(scopes, `${method.toUpperCase()} ${path}`).toHaveLength(1);
      expect(operation.tags, `${method.toUpperCase()} ${path}`).toEqual([scopes[0].split(":", 1)[0]]);
    }

    for (const [path, method, operationId] of [
      ["/repositories", "get", "listRepositories"],
      ["/repositories", "post", "createRepository"],
      ["/repositories/{repositoryId}", "get", "getRepository"],
    ] as const) {
      expect(toolbox.paths[path][method]).toMatchObject({ operationId, tags: ["repository"] });
    }
  });

  it("publishes the allowed paginated and idempotent generic resource operations", async () => {
    const toolbox = await document();
    const genericOperations = {
      "/boards": ["get", "post"],
      "/boards/{boardId}": ["get", "patch", "delete"],
      "/repositories": ["get", "post"],
      "/repositories/{repositoryId}": ["get", "delete"],
      "/tasks": ["get", "post"],
      "/tasks/{taskId}": ["get", "patch", "delete"],
      "/tasks/{taskId}/notes": ["get", "post"],
    } as const;

    for (const [path, methods] of Object.entries(genericOperations)) {
      const pathItem = toolbox.paths[path];
      expect(pathItem, path).toBeDefined();
      expect(Object.keys(pathItem).filter((key) => key !== "parameters")).toEqual(methods);
    }
    for (const path of ["/boards", "/repositories"] as const) {
      expect(toolbox.paths[path].post.parameters).not.toEqual(expect.arrayContaining([{ $ref: "#/components/parameters/IdempotencyKey" }]));
    }
    for (const path of ["/tasks", "/tasks/{taskId}/notes", "/agents", "/machines"] as const) {
      expect(toolbox.paths[path].post.parameters).toEqual(expect.arrayContaining([{ $ref: "#/components/parameters/IdempotencyKey" }]));
    }
    expect(toolbox.components.parameters.IdempotencyKey).toMatchObject({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      description: expect.stringContaining("RFC 8941"),
    });
    for (const [path, schema] of [
      ["/boards", "BoardCollection"],
      ["/repositories", "RepositoryCollection"],
      ["/tasks", "TaskCollection"],
      ["/tasks/{taskId}/notes", "TaskNoteCollection"],
    ] as const) {
      const operation = toolbox.paths[path].get;
      expect(operation.parameters).toEqual(
        expect.arrayContaining([{ $ref: "#/components/parameters/PageToken" }, { $ref: "#/components/parameters/PageSize" }]),
      );
      expect(operation.responses).toMatchObject({
        "200": { content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } },
      });
      expect(toolbox.components.schemas[schema]).toMatchObject({
        required: ["items", "pagination"],
        properties: { items: { type: "array" }, pagination: { $ref: "#/components/schemas/Pagination" } },
      });
    }
    expect(toolbox.components.schemas.Pagination).toMatchObject({
      additionalProperties: false,
      required: ["pageSize"],
      properties: { pageSize: { type: "integer" }, nextPageToken: { type: "string" } },
    });
    for (const schema of ["Board", "Repository", "Task", "TaskNote", "Problem"]) {
      expect(toolbox.components.schemas[schema], schema).toMatchObject({ type: "object", additionalProperties: false });
    }

    expect(toolbox.components.schemas.TaskCreate).toMatchObject({
      required: ["title"],
      properties: expect.objectContaining({ boardId: expect.any(Object), repositoryId: expect.any(Object), dependsOn: expect.any(Object) }),
    });
    for (const legacyField of ["board_id", "repository_id", "depends_on", "created_from", "scheduled_at"]) {
      expect((toolbox.components.schemas.TaskCreate as { properties: Record<string, unknown> }).properties).not.toHaveProperty(legacyField);
    }
  });

  it("documents dependency 404s only for Task and Task Note creation", async () => {
    const toolbox = await document();

    expect(toolbox.paths["/tasks"].post.responses).toHaveProperty("404");
    expect(toolbox.paths["/tasks/{taskId}/notes"].post.responses).toHaveProperty("404");
    expect(toolbox.paths["/boards"].post.responses).not.toHaveProperty("404");
    expect(toolbox.paths["/repositories"].post.responses).not.toHaveProperty("404");
    for (const path of ["/boards", "/repositories", "/tasks", "/tasks/{taskId}/notes"] as const) {
      expect(toolbox.paths[path].post.responses).toHaveProperty("201");
      expect(toolbox.paths[path].post.responses).toHaveProperty("422");
      expect(toolbox.paths[path].post.requestBody).toMatchObject({ required: true });
    }
  });

  it("publishes the minimal Task create example and accepted Task Event until values", async () => {
    const toolbox = await document();

    expect(toolbox.paths["/tasks"].post.requestBody).toMatchObject({
      required: true,
      content: {
        "application/json": {
          example: {
            boardId: "board-id",
            title: "Implement the requested behavior",
            description: "Acceptance criteria and relevant context",
          },
        },
      },
    });
    const until = toolbox.paths["/tasks/{taskId}/events"].get.parameters.find((parameter: { name?: string }) => parameter.name === "until");
    expect(until).toEqual({
      name: "until",
      in: "query",
      required: true,
      description: "Target Task status: todo, in-progress, in-review, done, or cancelled",
      schema: { type: "string", enum: ["todo", "in-progress", "in-review", "done", "cancelled"] },
    });
  });

  it("publishes the versioned Task Note resource and representation-aligned Task Events schema", async () => {
    const toolbox = await document();
    const note = toolbox.paths["/tasks/{taskId}/notes/{noteId}"].get;
    expect(note).toMatchObject({
      operationId: "getTaskNote",
      security: [{ realmroot: ["task:read"] }, { browserSession: [] }],
      parameters: expect.arrayContaining([{ $ref: "#/components/parameters/ApiVersion" }]),
      responses: {
        "200": {
          headers: expect.objectContaining({ ETag: { $ref: "#/components/headers/ETag" } }),
          content: { "application/json": { schema: { $ref: "#/components/schemas/TaskNote" } } },
        },
      },
    });
    expect(toolbox.paths["/tasks/{taskId}/notes/{noteId}"].parameters).toEqual(
      expect.arrayContaining([{ $ref: "#/components/parameters/TaskId" }, expect.objectContaining({ name: "noteId", in: "path", required: true })]),
    );
    expect(toolbox.components.schemas.TaskNote).toMatchObject({
      required: ["id", "taskId", "action", "actorType", "actorId", "actorName", "detail", "createdAt", "links"],
      properties: expect.objectContaining({
        taskId: expect.any(Object),
        action: { type: "string", const: "commented" },
        createdAt: expect.any(Object),
      }),
    });
    expect((toolbox.components.schemas.TaskNote as { properties: Record<string, unknown> }).properties).not.toHaveProperty("task_id");

    const eventPath = toolbox.paths["/tasks/{taskId}/events"];
    expect(eventPath.parameters).toEqual([{ $ref: "#/components/parameters/TaskId" }]);
    const events = eventPath.get;
    expect(events).toMatchObject({
      operationId: "listTaskEvents",
      "x-cli-name": "wait",
      security: [{ realmroot: ["task:read"] }, { browserSession: [] }],
      parameters: expect.arrayContaining([{ $ref: "#/components/parameters/ApiVersion" }]),
      responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/TaskEventSnapshot" } } } } },
    });
    expect(Object.keys(events.responses).sort()).toEqual(["200", "400", "401", "403", "404", "500"]);
    expect(events.parameters).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "taskId", in: "query" })]));
    expect(toolbox.paths).not.toHaveProperty("/task-events");
    expect(toolbox.components.schemas.TaskEventSnapshot).toMatchObject({
      required: ["cursor", "outcome", "tasks", "until"],
      properties: {
        outcome: { type: "string", enum: ["changed", "reached", "timed-out", "unreachable"] },
        tasks: { type: "array", items: { $ref: "#/components/schemas/Task" } },
        until: { type: "string", enum: expect.arrayContaining(["in-review", "cancelled"]) },
      },
    });
    expect(toolbox.components.schemas.Task).toMatchObject({
      required: expect.arrayContaining(["id", "status", "createdAt", "updatedAt"]),
      properties: expect.objectContaining({ boardId: expect.any(Object), status: { type: "string", enum: expect.arrayContaining(["in-review"]) } }),
    });
  });

  it("publishes canonical Task mutations and collection-only Claim creation", async () => {
    const toolbox = await document();
    const taskPatch = toolbox.paths["/tasks/{taskId}"].patch;
    expect(taskPatch.parameters).toEqual(
      expect.arrayContaining([{ $ref: "#/components/parameters/ApiVersion" }, { $ref: "#/components/parameters/CsrfToken" }]),
    );
    expect(taskPatch.parameters).not.toEqual(expect.arrayContaining([{ $ref: "#/components/parameters/IfMatch" }]));
    expect(taskPatch.requestBody).toEqual({
      required: true,
      content: { "application/merge-patch+json": { schema: { $ref: "#/components/schemas/TaskUpdate" } } },
    });
    expect(taskPatch.responses).toEqual(
      expect.objectContaining(
        Object.fromEntries([200, 400, 401, 403, 404, 409, 415, 422, 500].map((status) => [String(status), expect.any(Object)])),
      ),
    );
    expect(taskPatch.responses).not.toHaveProperty("412");
    expect(taskPatch.responses).not.toHaveProperty("428");

    const schemas = toolbox.components.schemas as Record<string, Record<string, unknown>>;
    const resolveSchema = (reference: { $ref: string }) => schemas[reference.$ref.split("/").at(-1)!];
    const variants = (schemas.TaskUpdate.oneOf as Array<{ $ref: string }>).map(resolveSchema);
    expect(variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ minProperties: 1, additionalProperties: false }),
        expect.objectContaining({ required: ["assignedTo"], additionalProperties: false, properties: { assignedTo: expect.any(Object) } }),
        expect.objectContaining({ oneOf: expect.any(Array) }),
      ]),
    );
    const statusSchema = variants.find((variant) => Array.isArray(variant.oneOf))!;
    const statusVariants = statusSchema.oneOf as Array<{ properties: { status: { type?: string; const?: string; enum?: string[] } } }>;
    expect(statusVariants.map((variant) => variant.properties.status)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ const: "in-review" }),
        expect.objectContaining({ const: "in-progress" }),
        expect.objectContaining({ enum: ["done", "cancelled"] }),
      ]),
    );

    const claimCollection = toolbox.paths["/tasks/{taskId}/claims"];
    expect(claimCollection.post).toMatchObject({
      operationId: "createTaskClaim",
      security: [{ realmroot: ["task:claim"] }, { browserSession: [] }],
      parameters: expect.arrayContaining([{ $ref: "#/components/parameters/IdempotencyKey" }]),
    });
    const claimResponseHeaders = {
      "API-Version": { $ref: "#/components/headers/ApiVersion" },
      "Request-Id": { $ref: "#/components/headers/RequestId" },
      traceparent: { $ref: "#/components/headers/Traceparent" },
      Link: { $ref: "#/components/headers/Link" },
      "Idempotency-Replayed": { $ref: "#/components/headers/IdempotencyReplayed" },
    };
    for (const status of ["200", "201"] as const) {
      expect(claimCollection.post.responses[status]).toMatchObject({
        headers: claimResponseHeaders,
        content: { "application/json": { schema: { $ref: "#/components/schemas/TaskClaim" } } },
      });
      expect(claimCollection.post.responses[status].headers).not.toHaveProperty("Location");
      expect(claimCollection.post.responses[status].headers).not.toHaveProperty("ETag");
    }
    expect(claimCollection.post).not.toHaveProperty("requestBody");
    expect(toolbox.paths).not.toHaveProperty("/tasks/{taskId}/claims/{claimId}");

    for (const [path, method] of [
      ["/task-assignments/{taskId}", "put"],
      ["/task-claims/{taskId}", "put"],
      ["/task-claims/{taskId}", "delete"],
      ["/task-review-submissions/{taskId}", "get"],
      ["/task-review-submissions/{taskId}", "put"],
      ["/task-review-rejections/{taskId}", "put"],
      ["/task-review-completions/{taskId}", "put"],
      ["/task-cancellations/{taskId}", "put"],
    ] as const) {
      expect(toolbox.paths[path], `${method.toUpperCase()} ${path}`).toBeUndefined();
    }
  });

  it("keeps every operation versioned and aligned with declared runtime scopes", async () => {
    const toolbox = await document();
    const scheme = toolbox.components.securitySchemes.realmroot;
    const declaredScopes = scheme["x-scopes-supported"];
    expect(scheme.openIdConnectUrl).toBe(`${env.OIDC_ISSUER}/.well-known/openid-configuration`);
    expect(Object.keys(declaredScopes).sort()).toEqual([...RESOURCE_SCOPES].sort());
    expect(RESOURCE_SCOPES).not.toContain("task:release");

    for (const [path, pathItem] of Object.entries(toolbox.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (method === "parameters") continue;
        expect(operation, `${method.toUpperCase()} ${path}`).toHaveProperty(
          "parameters",
          expect.arrayContaining([{ $ref: "#/components/parameters/ApiVersion" }]),
        );
        const scopes = ((operation.security as Array<Record<string, string[]>> | undefined)?.[0]?.realmroot ?? []) as string[];
        expect(scopes, `${method.toUpperCase()} ${path}`).not.toHaveLength(0);
        for (const scope of scopes) {
          expect(RESOURCE_SCOPES).toContain(scope);
          expect(declaredScopes).toHaveProperty(scope);
        }
        const responses = operation.responses as Record<string, { headers?: Record<string, unknown>; content?: Record<string, unknown> }>;
        expect(responses, `${method.toUpperCase()} ${path}`).not.toHaveProperty("4XX");
        for (const [status, response] of Object.entries(responses)) {
          expect(response.headers, `${method.toUpperCase()} ${path} ${status}`).toHaveProperty("traceparent", {
            $ref: "#/components/headers/Traceparent",
          });
          if (/^[45]\d\d$/.test(status)) {
            expect(response.content).toMatchObject({
              "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } },
            });
          }
        }
      }
    }
    const workflowScopes = Object.fromEntries(
      Object.entries(toolbox.paths).flatMap(([path, pathItem]) =>
        Object.values(pathItem)
          .filter((operation) => operation && typeof operation === "object" && "x-cli-name" in operation)
          .map((operation) => [operation["x-cli-name"], { path, scopes: operation.security }]),
      ),
    );
    expect(workflowScopes).toEqual({
      wait: { path: "/tasks/{taskId}/events", scopes: [{ realmroot: ["task:read"] }, { browserSession: [] }] },
    });
    expect(toolbox.paths).toHaveProperty("/tasks/{taskId}/session");
    expect(toolbox.paths).toHaveProperty("/tasks/{taskId}/session/ws");
  });

  it("constrains each canonical Task pullRequestUrl mutation schema to absolute HTTP(S)", async () => {
    const toolbox = await document();
    type Schema = { properties: Record<string, Schema>; oneOf: Schema[]; const?: string; format?: string; pattern?: string };
    const schemas = toolbox.components.schemas as unknown as Record<string, Schema>;
    const reviewStatus = schemas.TaskStatusUpdate.oneOf.find((variant) => variant.properties.status.const === "in-review")!;

    for (const pullRequestUrl of [schemas.TaskFieldsUpdate.properties.pullRequestUrl, reviewStatus.properties.pullRequestUrl]) {
      expect(pullRequestUrl).toMatchObject({ format: "uri", pattern: "^https?://" });
    }
  });
});
