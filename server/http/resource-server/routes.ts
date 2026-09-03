import { RESOURCE_SCOPES } from "@server/auth/realmroot";
import { akPublicUrl, akResource } from "@server/config/serviceUrls";
import type { Env } from "@server/env";
import { V2_API_VERSION } from "@server/http/middleware/v2Contract";
import { AGENCY_RUNTIMES, TASK_STATUSES } from "@shared";
import type { Hono } from "hono";

type Api = Hono<{ Bindings: Env }>;

export function registerResourceServerRoutes(app: Api): void {
  const metadata = (env: Env) => ({
    resource: akResource(env),
    resource_name: "Agent Kanban API",
    authorization_servers: [env.OIDC_ISSUER.replace(/\/$/, "")],
    scopes_supported: [...RESOURCE_SCOPES],
    bearer_methods_supported: ["header"],
    dpop_signing_alg_values_supported: ["ES256"],
    dpop_bound_access_tokens_required: true,
  });

  app.get("/.well-known/oauth-protected-resource/api", (c) => c.json(metadata(c.env)));
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(metadata(c.env)));
  app.get("/api", (c) => {
    const openapi = akPublicUrl(c.env, "/api/openapi.json");
    return c.json({ name: "Agent Kanban", resource: akResource(c.env), openapi }, 200, {
      Link: `<${openapi}>; rel="service-desc"; type="application/vnd.oai.openapi+json;version=3.1"`,
    });
  });
  app.get("/api/openapi.json", (c) => c.json(toolboxDocument(c.env)));
  app.get("/api/toolbox/openapi.json", (c) => c.notFound());
}

function toolboxDocument(env: Env) {
  const taskStatuses = TASK_STATUSES.map((status) => status.replaceAll("_", "-"));
  const version = { $ref: "#/components/parameters/ApiVersion" };
  const pageToken = { $ref: "#/components/parameters/PageToken" };
  const pageSize = { $ref: "#/components/parameters/PageSize" };
  const idempotencyKey = { $ref: "#/components/parameters/IdempotencyKey" };
  const taskId = { $ref: "#/components/parameters/TaskId" };
  const json = (schema: object, example?: object) => ({
    content: { "application/json": { schema, ...(example === undefined ? {} : { example }) } },
  });
  const responseHeaders = {
    "API-Version": { $ref: "#/components/headers/ApiVersion" },
    "Request-Id": { $ref: "#/components/headers/RequestId" },
    traceparent: { $ref: "#/components/headers/Traceparent" },
    Link: { $ref: "#/components/headers/Link" },
    "Idempotency-Replayed": { $ref: "#/components/headers/IdempotencyReplayed" },
  };
  const response = (description: string, schema?: object, headers: object = responseHeaders) => ({
    description,
    headers,
    ...(schema ? json(schema) : {}),
  });
  const entityResponse = (description: string, schema: object) =>
    response(description, schema, { ...responseHeaders, ETag: { $ref: "#/components/headers/ETag" } });
  const createdResponse = (description: string, schema: object) =>
    response(description, schema, {
      ...responseHeaders,
      ETag: { $ref: "#/components/headers/ETag" },
      Location: { $ref: "#/components/headers/Location" },
    });
  const problem = (description: string, status?: number) => ({
    description,
    headers: {
      ...responseHeaders,
      ...(status === 401 ? { "WWW-Authenticate": { $ref: "#/components/headers/WwwAuthenticate" } } : {}),
    },
    content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
  });
  const problems = (statuses: readonly number[]) =>
    Object.fromEntries(
      statuses.map((status) => [String(status), problem(status === 500 ? "Unexpected server failure" : "Request rejected", status)]),
    );
  const readProblems = problems([400, 401, 403, 404, 500]);
  const projectionReadProblems = problems([400, 401, 403, 404, 409, 502, 503]);
  const projectionCreateProblems = problems([400, 401, 403, 409, 415, 422, 502, 503]);
  const createProblems = problems([400, 401, 403, 409, 415, 422, 500]);
  const dependentCreateProblems = problems([400, 401, 403, 404, 409, 415, 422, 500]);
  const workflowProblems = problems([400, 401, 403, 404, 409, 412, 415, 422, 428, 500]);
  const notificationProblems = {
    "503": {
      ...problem(
        "The Task mutation was committed, but Inbox notification delivery is unavailable. Retry the same idempotent PUT to retry the notification.",
        503,
      ),
      headers: { ...responseHeaders, "Retry-After": { $ref: "#/components/headers/RetryAfter" } },
    },
  };
  const secured = (scope: string) => ({ security: [{ realmroot: [scope] }] });
  const operation = (operationId: string, scope: string, description: string, status = "200") => ({
    operationId,
    tags: [operationId.includes("Board") ? "board" : operationId.includes("Repository") ? "repository" : "task"],
    ...secured(scope),
    parameters: [version],
    responses: { [status]: response(description) },
  });
  const workflow = (operationId: string, scope: string, command: string, schema: string, extra: object = {}) => ({
    operationId,
    tags: ["task"],
    "x-cli-name": command,
    ...secured(scope),
    parameters: [version],
    ...extra,
    responses: {
      "200": entityResponse("Existing resource", { $ref: `#/components/schemas/${schema}` }),
      "201": createdResponse("Resource created", { $ref: `#/components/schemas/${schema}` }),
      ...workflowProblems,
    },
  });
  const notifyingWorkflow = (operationId: string, scope: string, command: string, schema: string, extra: object = {}) => {
    const definition = workflow(operationId, scope, command, schema, extra);
    return { ...definition, responses: { ...definition.responses, ...notificationProblems } };
  };

  return {
    openapi: "3.1.0",
    info: { title: "Agent Kanban Toolbox API", version: "2.0.0" },
    servers: [{ url: akResource(env) }],
    tags: [
      { name: "board", description: "Board resources" },
      { name: "repository", description: "Repository resources" },
      { name: "agent", description: "Schedulable Agent projections from AMA" },
      { name: "machine", description: "Self-hosted AMA Environment projections" },
      { name: "task", description: "Task resources and resource-first workflows" },
    ],
    paths: {
      "/boards": {
        get: {
          ...operation("listBoards", "board:read", "Boards"),
          parameters: [version, pageToken, pageSize, { name: "name", in: "query", schema: { type: "string" } }],
          responses: { "200": response("Board collection", { $ref: "#/components/schemas/BoardCollection" }), ...readProblems },
        },
        post: {
          ...operation("createBoard", "board:write", "Board created", "201"),
          parameters: [version],
          requestBody: { required: true, ...json({ $ref: "#/components/schemas/BoardWrite" }) },
          responses: { "201": createdResponse("Board created", { $ref: "#/components/schemas/Board" }), ...createProblems },
        },
      },
      "/boards/{boardId}": {
        parameters: [{ name: "boardId", in: "path", required: true, schema: { type: "string" } }],
        get: {
          ...operation("getBoard", "board:read", "Board"),
          responses: { "200": entityResponse("Board", { $ref: "#/components/schemas/Board" }), ...readProblems },
        },
      },
      "/repositories": {
        get: {
          ...operation("listRepositories", "repository:read", "Repositories"),
          parameters: [
            version,
            pageToken,
            pageSize,
            { name: "url", in: "query", schema: { type: "string" } },
            { name: "boardId", in: "query", schema: { type: "string" } },
          ],
          responses: {
            "200": response("Repository collection", { $ref: "#/components/schemas/RepositoryCollection" }),
            ...readProblems,
          },
        },
        post: {
          ...operation("createRepository", "repository:write", "Repository created", "201"),
          parameters: [version],
          requestBody: { required: true, ...json({ $ref: "#/components/schemas/RepositoryWrite" }) },
          responses: {
            "201": createdResponse("Repository created", { $ref: "#/components/schemas/Repository" }),
            ...createProblems,
          },
        },
      },
      "/repositories/{repositoryId}": {
        parameters: [{ name: "repositoryId", in: "path", required: true, schema: { type: "string" } }],
        get: {
          ...operation("getRepository", "repository:read", "Repository"),
          responses: { "200": entityResponse("Repository", { $ref: "#/components/schemas/Repository" }), ...readProblems },
        },
      },
      "/agents": {
        get: {
          ...operation("listAgents", "agent:read", "Agents"),
          tags: ["agent"],
          parameters: [
            version,
            pageToken,
            pageSize,
            { name: "schedulable", in: "query", schema: { type: "boolean" } },
            { name: "runtime", in: "query", schema: { type: "string", enum: ["ama", "claude-code", "codex", "copilot"] } },
            { name: "search", in: "query", schema: { type: "string", maxLength: 160 } },
          ],
          responses: { "200": response("Agent collection", { $ref: "#/components/schemas/AgentCollection" }), ...projectionReadProblems },
        },
        post: {
          ...operation("createAgent", "agent:write", "Agent created", "201"),
          tags: ["agent"],
          parameters: [version, idempotencyKey],
          requestBody: { required: true, ...json({ $ref: "#/components/schemas/AgentWrite" }) },
          responses: { "201": createdResponse("Agent created", { $ref: "#/components/schemas/Agent" }), ...projectionCreateProblems },
        },
      },
      "/agents/{agentId}": {
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        get: {
          ...operation("getAgent", "agent:read", "Agent"),
          tags: ["agent"],
          responses: { "200": entityResponse("Agent", { $ref: "#/components/schemas/Agent" }), ...projectionReadProblems },
        },
      },
      "/machines": {
        get: {
          ...operation("listMachines", "machine:read", "Machines"),
          tags: ["machine"],
          parameters: [version, pageToken, pageSize],
          responses: { "200": response("Machine collection", { $ref: "#/components/schemas/MachineCollection" }), ...projectionReadProblems },
        },
        post: {
          ...operation("createMachine", "machine:write", "Machine created", "201"),
          tags: ["machine"],
          parameters: [version, idempotencyKey],
          responses: {
            "201": createdResponse("Machine created with Runner setup", { $ref: "#/components/schemas/MachineCreateResult" }),
            ...projectionCreateProblems,
          },
        },
      },
      "/machines/{machineId}": {
        parameters: [{ name: "machineId", in: "path", required: true, schema: { type: "string" } }],
        get: {
          ...operation("getMachine", "machine:read", "Machine"),
          tags: ["machine"],
          responses: { "200": entityResponse("Machine", { $ref: "#/components/schemas/MachineDetail" }), ...projectionReadProblems },
        },
        delete: {
          ...operation("archiveMachine", "machine:write", "Machine archived", "204"),
          tags: ["machine"],
          responses: { "204": response("Machine archived"), ...projectionReadProblems },
        },
      },
      "/tasks": {
        get: {
          ...operation("listTasks", "task:read", "Tasks"),
          parameters: [
            version,
            pageToken,
            pageSize,
            { name: "boardId", in: "query", schema: { type: "string" } },
            { name: "repositoryId", in: "query", schema: { type: "string" } },
            { name: "assignedTo", in: "query", schema: { type: "string" } },
            { name: "status", in: "query", schema: { type: "string", enum: taskStatuses } },
            { name: "label", in: "query", schema: { type: "string" } },
            { name: "parent", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": response("Task collection", { $ref: "#/components/schemas/TaskCollection" }), ...readProblems },
        },
        post: {
          ...operation("createTask", "task:write", "Task created", "201"),
          parameters: [version, idempotencyKey],
          requestBody: {
            required: true,
            ...json(
              { $ref: "#/components/schemas/TaskCreate" },
              { boardId: "board-id", title: "Implement the requested behavior", description: "Acceptance criteria and relevant context" },
            ),
          },
          responses: { "201": createdResponse("Task created", { $ref: "#/components/schemas/Task" }), ...dependentCreateProblems },
        },
      },
      "/tasks/{taskId}": {
        parameters: [taskId],
        get: {
          ...operation("getTask", "task:read", "Task"),
          responses: { "200": entityResponse("Task", { $ref: "#/components/schemas/Task" }), ...readProblems },
        },
      },
      "/tasks/{taskId}/notes": {
        parameters: [taskId],
        get: {
          ...operation("listTaskNotes", "task:read", "Task notes"),
          parameters: [version, pageToken, pageSize, { name: "since", in: "query", schema: { type: "string", format: "date-time" } }],
          responses: {
            "200": response("Task Note collection", { $ref: "#/components/schemas/TaskNoteCollection" }),
            ...readProblems,
          },
        },
        post: {
          ...operation("createTaskNote", "task:write", "Task note created", "201"),
          parameters: [version, idempotencyKey],
          requestBody: { required: true, ...json({ $ref: "#/components/schemas/TaskNoteWrite" }) },
          responses: { "201": createdResponse("Task Note created", { $ref: "#/components/schemas/TaskNote" }), ...dependentCreateProblems },
        },
      },
      "/tasks/{taskId}/notes/{noteId}": {
        parameters: [taskId, { name: "noteId", in: "path", required: true, schema: { type: "string" } }],
        get: {
          ...operation("getTaskNote", "task:read", "Task Note"),
          responses: { "200": entityResponse("Task Note", { $ref: "#/components/schemas/TaskNote" }), ...readProblems },
        },
      },
      "/task-assignments/{taskId}": {
        parameters: [taskId],
        put: {
          ...operation("replaceTaskAssignment", "task:assign", "Task Assignment"),
          parameters: [version],
          requestBody: { required: true, ...json({ $ref: "#/components/schemas/TaskAssignmentWrite" }) },
          responses: {
            "200": entityResponse("Existing Task Assignment", { $ref: "#/components/schemas/TaskAssignment" }),
            "201": createdResponse("Task Assignment created", { $ref: "#/components/schemas/TaskAssignment" }),
            ...workflowProblems,
            ...notificationProblems,
          },
        },
      },
      "/task-claims/{taskId}": {
        parameters: [taskId],
        put: workflow("replaceTaskClaim", "task:claim", "claim", "TaskClaim"),
        delete: {
          ...workflow("deleteTaskClaim", "task:release", "release", "TaskClaim"),
          parameters: [version, { $ref: "#/components/parameters/IfMatch" }],
          responses: { "204": response("Claim released"), ...workflowProblems },
        },
      },
      "/task-review-submissions/{taskId}": {
        parameters: [taskId],
        get: {
          ...operation("getTaskReviewSubmission", "task:read", "Task Review Submission"),
          parameters: [version],
          responses: {
            "200": entityResponse("Task Review Submission", { $ref: "#/components/schemas/TaskReviewSubmission" }),
            ...readProblems,
          },
        },
        put: workflow("replaceTaskReviewSubmission", "task:review", "review", "TaskReviewSubmission", {
          requestBody: { required: true, ...json({ $ref: "#/components/schemas/TaskReviewSubmissionWrite" }) },
        }),
      },
      "/task-review-rejections/{taskId}": {
        parameters: [taskId],
        put: notifyingWorkflow("replaceTaskReviewRejection", "task:reject", "reject", "TaskReviewRejection", {
          requestBody: { required: true, ...json({ $ref: "#/components/schemas/TaskReviewRejectionWrite" }) },
        }),
      },
      "/task-review-completions/{taskId}": {
        parameters: [taskId],
        put: notifyingWorkflow("replaceTaskReviewCompletion", "task:complete", "complete", "TaskReviewCompletion", {
          requestBody: { required: true, ...json({ $ref: "#/components/schemas/TaskReviewCompletionWrite" }) },
        }),
      },
      "/task-cancellations/{taskId}": {
        parameters: [taskId],
        put: notifyingWorkflow("replaceTaskCancellation", "task:cancel", "cancel", "TaskCancellation"),
      },
      "/task-events": {
        get: {
          ...workflow("listTaskEvents", "task:read", "wait", "TaskEventSnapshot"),
          parameters: [
            version,
            { name: "taskId", in: "query", required: true, schema: { type: "array", items: { type: "string" } } },
            {
              name: "until",
              in: "query",
              required: true,
              description: "Target Task status: todo, in-progress, in-review, done, or cancelled",
              schema: { type: "string", enum: taskStatuses },
            },
            {
              name: "cursor",
              in: "query",
              schema: { type: "string", maxLength: 300 },
              description: "Opaque, caller-bound continuation token valid for 15 minutes",
            },
            { name: "waitSeconds", in: "query", schema: { type: "integer", minimum: 0, maximum: 25, default: 25 } },
          ],
          responses: {
            "200": response("Task Event snapshot", { $ref: "#/components/schemas/TaskEventSnapshot" }),
            ...workflowProblems,
          },
        },
      },
    },
    components: {
      headers: {
        ApiVersion: { schema: { type: "string", const: V2_API_VERSION } },
        RequestId: { schema: { type: "string" } },
        Traceparent: { schema: { type: "string", pattern: "^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$" } },
        ETag: { schema: { type: "string" } },
        Location: { schema: { type: "string", format: "uri" } },
        WwwAuthenticate: { schema: { type: "string" } },
        RetryAfter: { description: "Seconds to wait before retrying the same idempotent Task mutation", schema: { type: "integer", minimum: 1 } },
        Link: { schema: { type: "string" }, description: "RFC 8288 pagination link when another page exists" },
        IdempotencyReplayed: { schema: { type: "string", const: "true" }, description: "Present when a retained response was replayed" },
      },
      securitySchemes: {
        realmroot: {
          type: "openIdConnect",
          openIdConnectUrl: `${env.OIDC_ISSUER.replace(/\/$/, "")}/.well-known/openid-configuration`,
          "x-scopes-supported": Object.fromEntries(RESOURCE_SCOPES.map((scope) => [scope, `Access ${scope} resources`])),
        },
      },
      parameters: {
        ApiVersion: {
          name: "API-Version",
          in: "header",
          description: `Optional version override. Omit it to use ${V2_API_VERSION}.`,
          schema: { type: "string", const: V2_API_VERSION },
        },
        PageToken: { name: "pageToken", in: "query", schema: { type: "string" } },
        PageSize: { name: "pageSize", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          description:
            "Client-generated RFC 8941 string scoped to the caller, operation, request content, and API version. Automatic retries of one invocation reuse the value; a new invocation uses a new value. Toolbox clients should generate it without caller input. The original response is replayable for 24 hours.",
          schema: { type: "string", pattern: '^"[A-Za-z0-9._:-]{8,200}"$', example: '"0198f4d2-9055-7e52-a31a-e0d9a06bc847"' },
        },
        IfMatch: { name: "If-Match", in: "header", required: true, schema: { type: "string" } },
        TaskId: { name: "taskId", in: "path", required: true, schema: { type: "string" } },
      },
      schemas: {
        Problem: {
          type: "object",
          additionalProperties: false,
          required: ["type", "title", "status", "detail", "instance"],
          properties: {
            type: { type: "string", format: "uri" },
            title: { type: "string" },
            status: { type: "integer" },
            detail: { type: "string" },
            instance: { type: "string" },
          },
        },
        BoardWrite: {
          type: "object",
          additionalProperties: false,
          required: ["name", "type"],
          properties: { name: { type: "string" }, description: { type: "string" }, type: { type: "string", enum: ["dev", "ops"] } },
        },
        Board: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "description", "type", "createdAt", "updatedAt", "links"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: ["string", "null"] },
            type: { type: "string", enum: ["dev", "ops"] },
            createdAt: { type: "string" },
            updatedAt: { type: "string" },
            links: {
              type: "object",
              additionalProperties: false,
              required: ["self", "tasks"],
              properties: { self: { type: "string", format: "uri" }, tasks: { type: "string", format: "uri" } },
            },
          },
        },
        RepositoryWrite: {
          type: "object",
          additionalProperties: false,
          required: ["name", "url"],
          properties: { name: { type: "string", minLength: 1 }, url: { type: "string", minLength: 1 } },
        },
        Repository: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "url", "fullName", "createdAt", "taskCount", "appStatus", "links"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            url: { type: "string", format: "uri" },
            fullName: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            taskCount: { type: "integer", minimum: 0 },
            appStatus: { type: ["string", "null"], enum: ["covered", "not_covered", "suspended", "app_not_installed", null] },
            links: {
              type: "object",
              additionalProperties: false,
              required: ["self", "tasks"],
              properties: { self: { type: "string", format: "uri" }, tasks: { type: "string", format: "uri" } },
            },
          },
        },
        TaskCreate: {
          type: "object",
          additionalProperties: false,
          required: ["title"],
          properties: {
            title: { type: "string", minLength: 1 },
            description: { type: "string" },
            boardId: { type: "string" },
            repositoryId: { type: "string" },
            labels: { type: "array", items: { type: "string" } },
            dependsOn: { type: "array", items: { type: "string" } },
            createdFrom: { type: "string" },
            input: { type: ["object", "null"], additionalProperties: true },
            metadata: { type: ["object", "null"], additionalProperties: true },
            scheduledAt: { type: "string", format: "date-time" },
          },
        },
        Task: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "seq",
            "status",
            "title",
            "description",
            "boardId",
            "repositoryId",
            "labels",
            "createdBy",
            "assignedTo",
            "pullRequestUrl",
            "input",
            "metadata",
            "createdFrom",
            "scheduledAt",
            "position",
            "blocked",
            "dependsOn",
            "createdAt",
            "updatedAt",
            "links",
          ],
          properties: {
            id: { type: "string" },
            seq: { type: "integer", minimum: 1 },
            title: { type: "string" },
            status: { type: "string", enum: taskStatuses },
            description: { type: ["string", "null"] },
            boardId: { type: "string" },
            repositoryId: { type: ["string", "null"] },
            labels: { type: "array", items: { type: "string" } },
            createdBy: { type: ["string", "null"] },
            assignedTo: { type: ["string", "null"] },
            pullRequestUrl: { type: ["string", "null"], format: "uri" },
            input: { type: ["object", "null"], additionalProperties: true },
            metadata: { type: "object", additionalProperties: true },
            createdFrom: { type: ["string", "null"] },
            scheduledAt: { type: ["string", "null"], format: "date-time" },
            position: { type: "number" },
            blocked: { type: "boolean" },
            dependsOn: { type: "array", items: { type: "string" } },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            links: {
              type: "object",
              additionalProperties: false,
              required: ["self", "board", "repository", "notes", "assignment", "claim", "reviewSubmission"],
              properties: {
                self: { type: "string", format: "uri" },
                board: { type: "string", format: "uri" },
                repository: { type: ["string", "null"], format: "uri" },
                notes: { type: "string", format: "uri" },
                assignment: { type: "string", format: "uri" },
                claim: { type: "string", format: "uri" },
                reviewSubmission: { type: "string", format: "uri" },
              },
            },
          },
        },
        TaskNoteWrite: {
          type: "object",
          additionalProperties: false,
          required: ["detail"],
          properties: { detail: { type: "string", minLength: 1 } },
        },
        TaskNote: {
          type: "object",
          additionalProperties: false,
          required: ["id", "taskId", "action", "actorType", "actorId", "actorName", "detail", "createdAt", "links"],
          properties: {
            id: { type: "string" },
            taskId: { type: "string" },
            action: { type: "string", const: "commented" },
            actorType: { type: "string", enum: ["user", "realmroot:agent", "system"] },
            actorId: { type: "string" },
            actorName: { type: ["string", "null"] },
            detail: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            links: {
              type: "object",
              additionalProperties: false,
              required: ["self", "task"],
              properties: { self: { type: "string", format: "uri" }, task: { type: "string", format: "uri" } },
            },
          },
        },
        Pagination: {
          type: "object",
          additionalProperties: false,
          required: ["pageSize"],
          properties: {
            pageSize: { type: "integer", minimum: 0, maximum: 100 },
            nextPageToken: { type: "string", description: "Opaque, caller-bound continuation token valid for 15 minutes" },
          },
        },
        BoardCollection: collectionSchema("Board"),
        RepositoryCollection: collectionSchema("Repository"),
        Agent: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "name",
            "description",
            "username",
            "runtime",
            "model",
            "skills",
            "subject",
            "schedulable",
            "createdAt",
            "updatedAt",
            "links",
          ],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: ["string", "null"] },
            username: { type: ["string", "null"] },
            runtime: { type: ["string", "null"] },
            model: { type: ["string", "null"] },
            skills: { type: "array", items: { type: "string" } },
            subject: { type: ["string", "null"] },
            schedulable: { type: "boolean" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            links: { type: "object", additionalProperties: false, required: ["self"], properties: { self: { type: "string", format: "uri" } } },
          },
        },
        AgentWrite: {
          type: "object",
          additionalProperties: false,
          required: ["name", "username", "runtime", "systemPrompt"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 160 },
            description: { type: ["string", "null"], maxLength: 1000 },
            username: { type: "string", minLength: 1, maxLength: 80, pattern: "^[a-z0-9][a-z0-9-]*$" },
            runtime: { type: "string", enum: [...AGENCY_RUNTIMES] },
            systemPrompt: { type: "string", minLength: 1, maxLength: 8000 },
            provider: { type: ["string", "null"] },
            model: { type: ["string", "null"] },
            skills: { type: "array", maxItems: 100, items: { type: "string", minLength: 1 } },
          },
        },
        AgentCollection: collectionSchema("Agent"),
        MachineRuntime: {
          type: "object",
          additionalProperties: false,
          required: ["runtime", "models", "state"],
          properties: {
            runtime: { type: "string" },
            models: { type: "array", items: { type: "string" } },
            version: { type: "string" },
            state: { type: "string" },
            detail: { type: "string" },
          },
        },
        MachineRuntimeUsageWindow: {
          type: "object",
          additionalProperties: false,
          required: ["label", "utilization", "resetsAt"],
          properties: {
            label: { type: "string" },
            utilization: { type: "number" },
            resetsAt: { type: "string", format: "date-time" },
          },
        },
        MachineRuntimeUsage: {
          type: "object",
          additionalProperties: false,
          required: ["runtime", "windows"],
          properties: {
            runtime: { type: "string" },
            windows: { type: "array", items: { $ref: "#/components/schemas/MachineRuntimeUsageWindow" } },
          },
        },
        MachineRunner: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "status", "currentLoad", "maxLoad", "runtimes", "runtimeUsage", "lastHeartbeatAt"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            status: { type: "string", enum: ["active", "offline", "draining", "disabled"] },
            currentLoad: { type: "integer", minimum: 0 },
            maxLoad: { type: "integer", minimum: 0 },
            runtimes: { type: "array", items: { $ref: "#/components/schemas/MachineRuntime" } },
            runtimeUsage: { type: "array", items: { $ref: "#/components/schemas/MachineRuntimeUsage" } },
            lastHeartbeatAt: { type: ["string", "null"], format: "date-time" },
          },
        },
        Machine: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "name",
            "description",
            "status",
            "currentLoad",
            "maxLoad",
            "runnerCount",
            "runtimes",
            "lastHeartbeatAt",
            "createdAt",
            "updatedAt",
            "links",
          ],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: ["string", "null"] },
            status: { type: "string", enum: ["online", "offline", "draining", "disabled"] },
            currentLoad: { type: "integer", minimum: 0 },
            maxLoad: { type: "integer", minimum: 0 },
            runnerCount: { type: "integer", minimum: 0 },
            runtimes: { type: "array", items: { $ref: "#/components/schemas/MachineRuntime" } },
            lastHeartbeatAt: { type: ["string", "null"], format: "date-time" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            links: { type: "object", additionalProperties: false, required: ["self"], properties: { self: { type: "string", format: "uri" } } },
          },
        },
        MachineDetail: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "name",
            "description",
            "status",
            "currentLoad",
            "maxLoad",
            "runnerCount",
            "runners",
            "authCommand",
            "startCommand",
            "runtimes",
            "lastHeartbeatAt",
            "createdAt",
            "updatedAt",
            "links",
          ],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: ["string", "null"] },
            status: { type: "string", enum: ["online", "offline", "draining", "disabled"] },
            currentLoad: { type: "integer", minimum: 0 },
            maxLoad: { type: "integer", minimum: 0 },
            runnerCount: { type: "integer", minimum: 0 },
            runners: { type: "array", items: { $ref: "#/components/schemas/MachineRunner" } },
            authCommand: { type: "string" },
            startCommand: { type: "string" },
            runtimes: { type: "array", items: { $ref: "#/components/schemas/MachineRuntime" } },
            lastHeartbeatAt: { type: ["string", "null"], format: "date-time" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            links: { type: "object", additionalProperties: false, required: ["self"], properties: { self: { type: "string", format: "uri" } } },
          },
        },
        MachineCreateResult: {
          type: "object",
          additionalProperties: false,
          required: ["machine", "authCommand", "startCommand"],
          properties: {
            machine: { $ref: "#/components/schemas/Machine" },
            authCommand: { type: "string" },
            startCommand: { type: "string" },
          },
        },
        MachineCollection: collectionSchema("Machine"),
        TaskCollection: collectionSchema("Task"),
        TaskNoteCollection: collectionSchema("TaskNote"),
        TaskAssignmentWrite: {
          type: "object",
          additionalProperties: false,
          required: ["agentActorId"],
          properties: { agentActorId: { type: "string" } },
        },
        TaskClaim: {
          type: "object",
          additionalProperties: false,
          required: ["id", "taskId", "agentActorId", "runtime", "runtimeSessionId", "claimedAt"],
          properties: {
            id: { type: "string" },
            taskId: { type: "string" },
            agentActorId: { type: "string" },
            runtime: { type: "string", enum: [...AGENCY_RUNTIMES] },
            runtimeSessionId: { type: "string" },
            claimedAt: { type: "string", format: "date-time" },
          },
        },
        TaskReviewSubmissionWrite: {
          type: "object",
          additionalProperties: false,
          properties: { pullRequestUrl: { type: "string", format: "uri" } },
          example: {},
        },
        TaskReviewRejectionWrite: {
          type: "object",
          additionalProperties: false,
          required: ["reviewSubmissionVersion"],
          properties: { reviewSubmissionVersion: { type: "string", minLength: 1, maxLength: 200 }, reason: { type: "string", maxLength: 4000 } },
        },
        TaskReviewCompletionWrite: {
          type: "object",
          additionalProperties: false,
          required: ["reviewSubmissionVersion"],
          properties: { reviewSubmissionVersion: { type: "string", minLength: 1, maxLength: 200 } },
        },
        TaskAssignment: {
          type: "object",
          additionalProperties: false,
          required: ["id", "taskId", "agentActorId", "assignedByActorId", "assignedAt"],
          properties: {
            id: { type: "string" },
            taskId: { type: "string" },
            agentActorId: { type: "string" },
            assignedByActorId: { type: "string" },
            assignedAt: { type: "string", format: "date-time" },
          },
        },
        TaskReviewSubmission: {
          type: "object",
          additionalProperties: false,
          required: ["id", "taskId", "agentActorId", "reviewSubmissionVersion", "pullRequestUrl", "submittedAt"],
          properties: {
            id: { type: "string" },
            taskId: { type: "string" },
            agentActorId: { type: "string" },
            reviewSubmissionVersion: { type: "string" },
            pullRequestUrl: { type: ["string", "null"], format: "uri" },
            submittedAt: { type: "string", format: "date-time" },
          },
        },
        TaskReviewRejection: {
          type: "object",
          additionalProperties: false,
          required: ["id", "taskId", "reviewSubmissionVersion", "rejectedByActorType", "rejectedByActorId", "reason", "rejectedAt"],
          properties: {
            id: { type: "string" },
            taskId: { type: "string" },
            reviewSubmissionVersion: { type: "string" },
            rejectedByActorType: { type: "string", enum: ["agent", "human"] },
            rejectedByActorId: { type: "string" },
            reason: { type: ["string", "null"] },
            rejectedAt: { type: "string", format: "date-time" },
          },
        },
        TaskReviewCompletion: {
          type: "object",
          additionalProperties: false,
          required: ["id", "taskId", "reviewSubmissionVersion", "completedByActorType", "completedByActorId", "completedAt"],
          properties: {
            id: { type: "string" },
            taskId: { type: "string" },
            reviewSubmissionVersion: { type: "string" },
            completedByActorType: { type: "string", enum: ["agent", "human"] },
            completedByActorId: { type: "string" },
            completedAt: { type: "string", format: "date-time" },
          },
        },
        TaskCancellation: {
          type: "object",
          additionalProperties: false,
          required: ["id", "taskId", "cancelledByActorType", "cancelledByActorId", "cancelledAt"],
          properties: {
            id: { type: "string" },
            taskId: { type: "string" },
            cancelledByActorType: { type: "string", enum: ["agent", "human", "system"] },
            cancelledByActorId: { type: "string" },
            cancelledAt: { type: "string", format: "date-time" },
          },
        },
        TaskEventSnapshot: {
          type: "object",
          additionalProperties: false,
          required: ["cursor", "outcome", "tasks", "until"],
          properties: {
            cursor: { type: "string" },
            outcome: { type: "string", enum: ["changed", "reached", "timed-out", "unreachable"] },
            tasks: { type: "array", items: { $ref: "#/components/schemas/Task" } },
            until: { type: "string", enum: taskStatuses },
          },
        },
      },
    },
  };
}

function collectionSchema(itemSchema: string) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["items", "pagination"],
    properties: {
      items: { type: "array", items: { $ref: `#/components/schemas/${itemSchema}` } },
      pagination: { $ref: "#/components/schemas/Pagination" },
    },
  };
}
