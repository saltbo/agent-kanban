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

  it("exposes exactly the seven resource-first Task commands with x-cli-name", async () => {
    const toolbox = await document();
    const commands = Object.values(toolbox.paths)
      .flatMap((path) => Object.values(path))
      .filter((operation) => operation && typeof operation === "object" && "x-cli-name" in operation)
      .map((operation) => operation["x-cli-name"])
      .sort();

    expect(commands).toEqual(["cancel", "claim", "complete", "reject", "release", "review", "wait"]);
    for (const path of ["/agents", "/agents/{agentId}", "/machines", "/machines/{machineId}"]) {
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
      ["/task-assignments/{taskId}", "put"],
      ["/task-review-submissions/{taskId}", "get"],
    ] as const) {
      expect(toolbox.paths[path]?.[method]).not.toHaveProperty("x-cli-hidden");
      expect(toolbox.paths[path]?.[method]).not.toHaveProperty("x-cli-name");
    }
    expect(JSON.stringify(toolbox)).not.toContain("x-cli-hidden");
  });

  it("publishes only the allowed paginated and idempotent generic resource operations", async () => {
    const toolbox = await document();
    const genericOperations = {
      "/boards": ["get", "post"],
      "/boards/{boardId}": ["get"],
      "/repositories": ["get", "post"],
      "/repositories/{repositoryId}": ["get"],
      "/tasks": ["get", "post"],
      "/tasks/{taskId}": ["get"],
      "/tasks/{taskId}/notes": ["get", "post"],
    } as const;

    for (const [path, methods] of Object.entries(genericOperations)) {
      const pathItem = toolbox.paths[path];
      expect(pathItem, path).toBeDefined();
      expect(Object.keys(pathItem).filter((key) => key !== "parameters")).toEqual(methods);
    }
    expect(Object.keys(toolbox.paths)).not.toEqual(expect.arrayContaining([expect.stringMatching(/labels/)]));

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
    const until = toolbox.paths["/task-events"].get.parameters.find((parameter: { name?: string }) => parameter.name === "until");
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
      security: [{ realmroot: ["task:read"] }],
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

    const events = toolbox.paths["/task-events"].get;
    expect(events).toMatchObject({
      security: [{ realmroot: ["task:read"] }],
      parameters: expect.arrayContaining([{ $ref: "#/components/parameters/ApiVersion" }]),
      responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/TaskEventSnapshot" } } } } },
    });
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

  it("keeps every operation versioned and aligned with declared runtime scopes without publishing internal Task Session routes", async () => {
    const toolbox = await document();
    const scheme = toolbox.components.securitySchemes.realmroot;
    const declaredScopes = scheme["x-scopes-supported"];
    expect(scheme.openIdConnectUrl).toBe(`${env.OIDC_ISSUER}/.well-known/openid-configuration`);
    expect(Object.keys(declaredScopes).sort()).toEqual([...RESOURCE_SCOPES].sort());

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
    expect(workflowScopes).toMatchObject({
      claim: { path: "/task-claims/{taskId}", scopes: [{ realmroot: ["task:claim"] }] },
      release: { path: "/task-claims/{taskId}", scopes: [{ realmroot: ["task:release"] }] },
      review: { path: "/task-review-submissions/{taskId}", scopes: [{ realmroot: ["task:review"] }] },
      reject: { path: "/task-review-rejections/{taskId}", scopes: [{ realmroot: ["task:reject"] }] },
      complete: { path: "/task-review-completions/{taskId}", scopes: [{ realmroot: ["task:complete"] }] },
      cancel: { path: "/task-cancellations/{taskId}", scopes: [{ realmroot: ["task:cancel"] }] },
      wait: { path: "/task-events", scopes: [{ realmroot: ["task:read"] }] },
    });
    expect(toolbox.paths).not.toHaveProperty("/tasks/{taskId}/session");
    expect(toolbox.paths).not.toHaveProperty("/tasks/{taskId}/session/ws");
  });

  it("publishes required reviewSubmissionVersion JSON bodies without If-Match on Review Decisions", async () => {
    const toolbox = await document();
    expect(toolbox.paths["/task-review-submissions/{taskId}"].put.requestBody).toEqual({
      required: true,
      content: { "application/json": { schema: { $ref: "#/components/schemas/TaskReviewSubmissionWrite" } } },
    });
    expect(toolbox.components.schemas.TaskReviewSubmissionWrite).toMatchObject({ example: {} });
    expect(toolbox.components.schemas.TaskReviewSubmission).toMatchObject({
      required: expect.arrayContaining(["reviewSubmissionVersion"]),
      properties: { reviewSubmissionVersion: { type: "string" } },
    });
    for (const [path, schema] of [
      ["/task-review-rejections/{taskId}", "TaskReviewRejectionWrite"],
      ["/task-review-completions/{taskId}", "TaskReviewCompletionWrite"],
    ] as const) {
      const operation = toolbox.paths[path].put;
      expect(operation.requestBody).toEqual({
        required: true,
        content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
      });
      expect(operation.parameters).not.toEqual(expect.arrayContaining([{ $ref: "#/components/parameters/IfMatch" }]));
      expect(toolbox.components.schemas[schema]).toMatchObject({ required: ["reviewSubmissionVersion"] });
    }
  });

  it("documents committed notification failures only for Inbox-notifying Task mutations", async () => {
    const toolbox = await document();
    const expected = [
      "PUT /task-assignments/{taskId}",
      "PUT /task-review-rejections/{taskId}",
      "PUT /task-review-completions/{taskId}",
      "PUT /task-cancellations/{taskId}",
    ];
    const actual: string[] = [];
    for (const [path, pathItem] of Object.entries(toolbox.paths)) {
      const operation = pathItem.put;
      if (!path.startsWith("/task-") || !operation) continue;
      const unavailable = (operation.responses as Record<string, Record<string, unknown>>)["503"];
      if (!unavailable || typeof unavailable.description !== "string" || !/committed.*Retry the same idempotent PUT/i.test(unavailable.description)) {
        continue;
      }
      actual.push(`PUT ${path}`);
      expect(unavailable.headers).toMatchObject({ "Retry-After": { $ref: "#/components/headers/RetryAfter" } });
    }
    expect(actual).toEqual(expected);
  });
});
