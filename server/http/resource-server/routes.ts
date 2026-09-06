import { Scalar } from "@scalar/hono-api-reference";
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
  app.get("/api/openapi.json", (c) => c.json(apiDocument(c.env)));
  app.get("/api/docs/openapi.json", (c) => c.notFound());
  app.get(
    "/api/docs",
    Scalar({
      url: "/api/openapi.json",
      pageTitle: "Agent Kanban API Docs",
      theme: "default",
      darkMode: true,
      customCss: `
        :root {
          --scalar-font: "Geist", ui-sans-serif, system-ui, sans-serif;
          --scalar-font-code: "Geist Mono", ui-monospace, monospace;
          --scalar-color-accent: #0891b2;
          --scalar-background-accent: rgba(8, 145, 178, 0.1);
        }
        .dark-mode {
          --scalar-color-accent: #22d3ee;
          --scalar-background-1: #09090b;
          --scalar-background-2: #18181b;
          --scalar-background-3: #27272a;
          --scalar-background-accent: rgba(34, 211, 238, 0.1);
        }
      `,
    }),
  );
  app.get("/api/toolbox/openapi.json", (c) => c.notFound());
}

function baseDocument(env: Env) {
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
  const secured = (scope: string) => ({ security: [{ realmroot: [scope] }, { browserSession: [] }] });
  const operation = (operationId: string, scope: string, description: string, status = "200") => ({
    operationId,
    tags: [scope.split(":", 1)[0]],
    ...secured(scope),
    parameters: [version],
    responses: { [status]: response(description) },
  });
  return {
    openapi: "3.1.0",
    info: { title: "Agent Kanban API", version: "2.0.0" },
    servers: [{ url: akResource(env) }],
    tags: [
      { name: "board", description: "Board resources" },
      { name: "repository", description: "Repository resources" },
      { name: "agent", description: "Schedulable Agent projections from Enbor" },
      { name: "machine", description: "Self-hosted Enbor Environment projections" },
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
          parameters: [
            version,
            pageToken,
            pageSize,
            { name: "schedulable", in: "query", schema: { type: "boolean" } },
            { name: "runtime", in: "query", schema: { type: "string", enum: ["enbor", "claude-code", "codex", "copilot"] } },
            { name: "search", in: "query", schema: { type: "string", maxLength: 160 } },
          ],
          responses: { "200": response("Agent collection", { $ref: "#/components/schemas/AgentCollection" }), ...projectionReadProblems },
        },
        post: {
          ...operation("createAgent", "agent:write", "Agent created with persistent AK and GitHub development permissions", "201"),
          parameters: [version, idempotencyKey],
          requestBody: { required: true, ...json({ $ref: "#/components/schemas/AgentWrite" }) },
          responses: { "201": createdResponse("Agent created", { $ref: "#/components/schemas/Agent" }), ...projectionCreateProblems },
        },
      },
      "/agents/{agentId}": {
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        get: {
          ...operation("getAgent", "agent:read", "Agent"),
          responses: { "200": entityResponse("Agent", { $ref: "#/components/schemas/Agent" }), ...projectionReadProblems },
        },
      },
      "/agents/{agentId}/permissions": {
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        post: {
          ...operation("createAgentPermissions", "agent:write", "Persistent default GitHub permissions configured", "204"),
          description:
            "Grant the default GitHub development, Issue and CI scopes to an existing bound Agent using the caller's saved user authorization. Existing equivalent permissions are reused; other grants are retained. No identity is created. Missing identity or user login returns 409. Repeat with an empty object to complete an interrupted grant.",
          requestBody: { required: true, ...json({ type: "object", additionalProperties: false }) },
          responses: { "204": response("Default GitHub permissions confirmed active"), ...projectionCreateProblems },
        },
      },
      "/machines": {
        get: {
          ...operation("listMachines", "machine:read", "Machines"),
          parameters: [version, pageToken, pageSize],
          responses: { "200": response("Machine collection", { $ref: "#/components/schemas/MachineCollection" }), ...projectionReadProblems },
        },
        post: {
          ...operation("createMachine", "machine:write", "Machine created", "201"),
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
          responses: { "200": entityResponse("Machine", { $ref: "#/components/schemas/MachineDetail" }), ...projectionReadProblems },
        },
        delete: {
          ...operation("archiveMachine", "machine:write", "Machine archived", "204"),
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
          description:
            "Agent callers require a saved authorization for their controller user from AK web login. Otherwise returns 409 user-login-required without creating a Task; ask the associated user to sign in to AK in a web browser.",
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
      "/tasks/{taskId}/events": {
        parameters: [taskId],
        get: {
          ...operation("listTaskEvents", "task:read", "Task Event snapshot"),
          "x-cli-name": "wait",
          parameters: [
            version,
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
            ...readProblems,
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
            "Client-generated RFC 8941 string scoped to the caller, operation, request content, and API version. Automatic retries of one invocation reuse the value; a new invocation uses a new value. Clients should generate it without user input. The original response is replayable for 24 hours.",
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
          required: ["id", "name", "description", "type", "labels", "visibility", "shareSlug", "createdAt", "updatedAt", "links"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: ["string", "null"] },
            type: { type: "string", enum: ["dev", "ops"] },
            labels: { type: "array", items: { $ref: "#/components/schemas/BoardLabel" } },
            visibility: { type: "string", enum: ["private", "public"] },
            shareSlug: { type: ["string", "null"] },
            tasks: { type: "array", items: { $ref: "#/components/schemas/Task" } },
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
            scheduledAt: {
              type: "string",
              format: "date-time",
              description: "Reserved. Delayed scheduling is not implemented; setting this field returns 422. Omit it when creating a Task.",
            },
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
            "repositoryName",
            "labels",
            "createdBy",
            "assignedTo",
            "assigneeName",
            "boardType",
            "pullRequestUrl",
            "input",
            "metadata",
            "createdFrom",
            "scheduledAt",
            "position",
            "blocked",
            "dependsOn",
            "durationMinutes",
            "subtaskCount",
            "sessionBinding",
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
            repositoryName: { type: ["string", "null"] },
            labels: { type: "array", items: { type: "string" } },
            createdBy: { type: ["string", "null"] },
            assignedTo: { type: ["string", "null"] },
            assigneeName: { type: ["string", "null"] },
            boardType: { type: ["string", "null"], enum: ["dev", "ops", null] },
            pullRequestUrl: { type: ["string", "null"], format: "uri" },
            input: { type: ["object", "null"], additionalProperties: true },
            metadata: { type: "object", additionalProperties: true },
            createdFrom: { type: ["string", "null"] },
            scheduledAt: {
              type: ["string", "null"],
              format: "date-time",
              description:
                "Reserved. Delayed scheduling is not implemented; non-null writes return 422. Existing values remain readable and may be cleared with null.",
            },
            position: { type: "number" },
            blocked: { type: "boolean" },
            dependsOn: { type: "array", items: { type: "string" } },
            durationMinutes: { type: ["number", "null"] },
            subtaskCount: { type: "integer", minimum: 0 },
            sessionBinding: {
              type: ["object", "null"],
              additionalProperties: false,
              required: ["agentActorId", "runtime", "runtimeSessionId", "boundAt"],
              properties: {
                agentActorId: { type: "string" },
                runtime: { type: "string" },
                runtimeSessionId: { type: "string" },
                boundAt: { type: "string", format: "date-time" },
              },
            },
            notes: { type: "array", items: { $ref: "#/components/schemas/TaskActivity" } },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            links: {
              type: "object",
              additionalProperties: false,
              required: ["self", "board", "repository", "notes", "claims"],
              properties: {
                self: { type: "string", format: "uri" },
                board: { type: "string", format: "uri" },
                repository: { type: ["string", "null"], format: "uri" },
                notes: { type: "string", format: "uri" },
                claims: { type: "string", format: "uri" },
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
            actorType: { type: "string", enum: ["user", "machine", "service", "realmroot:agent", "system"] },
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
        TaskActivity: {
          type: "object",
          additionalProperties: false,
          required: ["id", "taskId", "action", "actorType", "actorId", "actorName", "detail", "createdAt", "links"],
          properties: {
            id: { type: "string" },
            taskId: { type: "string" },
            action: {
              type: "string",
              enum: [
                "created",
                "claimed",
                "moved",
                "commented",
                "completed",
                "assigned",
                "released",
                "timed_out",
                "cancelled",
                "rejected",
                "review_requested",
                "dispatched",
                "dispatch_failed",
              ],
            },
            actorType: { type: "string", enum: ["user", "machine", "service", "realmroot:agent", "agent:worker", "agent:leader", "system"] },
            actorId: { type: "string" },
            actorName: { type: ["string", "null"] },
            detail: { type: ["string", "null"] },
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

function apiDocument(env: Env) {
  const document = baseDocument(env);
  const paths: Record<string, Record<string, unknown>> = document.paths;
  const components: {
    parameters: Record<string, unknown>;
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  } = document.components;
  const csrf = { $ref: "#/components/parameters/CsrfToken" };
  const apiVersion = { $ref: "#/components/parameters/ApiVersion" };
  const taskId = { $ref: "#/components/parameters/TaskId" };
  const apiResponseHeaders = {
    "API-Version": { $ref: "#/components/headers/ApiVersion" },
    "Request-Id": { $ref: "#/components/headers/RequestId" },
    traceparent: { $ref: "#/components/headers/Traceparent" },
    Link: { $ref: "#/components/headers/Link" },
    "Idempotency-Replayed": { $ref: "#/components/headers/IdempotencyReplayed" },
  };
  const json = (schema: object) => ({ content: { "application/json": { schema } } });
  const apiResponse = (description: string, schema?: object) => ({
    description,
    headers: apiResponseHeaders,
    ...(schema ? json(schema) : {}),
  });
  const apiProblems = (...statuses: number[]) =>
    Object.fromEntries(
      statuses.map((status) => [
        String(status),
        {
          description: "Request rejected",
          headers: apiResponseHeaders,
          content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
        },
      ]),
    );
  const apiOperation = (operationId: string, scope: (typeof RESOURCE_SCOPES)[number], summary: string, responses: object, extra: object = {}) => ({
    operationId,
    tags: [scope.split(":", 1)[0]],
    summary,
    security: [{ realmroot: [scope] }, { browserSession: [] }],
    ...extra,
    responses,
  });

  paths["/boards/{boardId}"] = {
    ...paths["/boards/{boardId}"],
    patch: apiOperation(
      "updateBoard",
      "board:write",
      "Update a Board",
      {
        "200": apiResponse("Board updated", { $ref: "#/components/schemas/Board" }),
        ...apiProblems(400, 401, 403, 404, 500),
      },
      {
        parameters: [csrf],
        requestBody: { required: true, ...json({ $ref: "#/components/schemas/BoardUpdate" }) },
      },
    ),
    delete: apiOperation(
      "deleteBoard",
      "board:write",
      "Delete a Board",
      {
        "200": apiResponse("Board deleted", { $ref: "#/components/schemas/DeleteResult" }),
        ...apiProblems(401, 403, 404, 500),
      },
      { parameters: [csrf] },
    ),
  };
  paths["/boards/{boardId}/labels"] = {
    parameters: [{ name: "boardId", in: "path", required: true, schema: { type: "string" } }],
    post: apiOperation(
      "createBoardLabel",
      "board:write",
      "Create a Board Label",
      {
        "201": apiResponse("Board Label created", { $ref: "#/components/schemas/Board" }),
        ...apiProblems(400, 401, 403, 404, 409, 500),
      },
      {
        parameters: [csrf],
        requestBody: { required: true, ...json({ $ref: "#/components/schemas/BoardLabelWrite" }) },
      },
    ),
  };
  paths["/boards/{boardId}/labels/{labelName}"] = {
    parameters: [
      { name: "boardId", in: "path", required: true, schema: { type: "string" } },
      { name: "labelName", in: "path", required: true, schema: { type: "string" } },
    ],
    patch: apiOperation(
      "updateBoardLabel",
      "board:write",
      "Update a Board Label",
      {
        "200": apiResponse("Board Label updated", { $ref: "#/components/schemas/Board" }),
        ...apiProblems(400, 401, 403, 404, 409, 500),
      },
      {
        parameters: [csrf],
        requestBody: { required: true, ...json({ $ref: "#/components/schemas/BoardLabelUpdate" }) },
      },
    ),
    delete: apiOperation(
      "deleteBoardLabel",
      "board:write",
      "Delete a Board Label",
      {
        "200": apiResponse("Board Label deleted", { $ref: "#/components/schemas/Board" }),
        ...apiProblems(401, 403, 404, 500),
      },
      { parameters: [csrf] },
    ),
  };
  paths["/boards/{boardId}/stream"] = {
    parameters: [{ name: "boardId", in: "path", required: true, schema: { type: "string" } }],
    get: apiOperation("streamBoardEvents", "board:read", "Stream Board events", {
      "200": {
        description: "A bounded Server-Sent Events stream of Board Task activity",
        headers: apiResponseHeaders,
        content: { "text/event-stream": { schema: { type: "string" } } },
      },
      ...apiProblems(401, 403, 500),
    }),
  };

  paths["/repositories/{repositoryId}"] = {
    ...paths["/repositories/{repositoryId}"],
    delete: apiOperation(
      "deleteRepository",
      "repository:write",
      "Delete a Repository",
      {
        "200": apiResponse("Repository deleted", { $ref: "#/components/schemas/DeleteResult" }),
        ...apiProblems(401, 403, 404, 500),
      },
      { parameters: [csrf] },
    ),
  };
  paths["/github-app/config"] = {
    get: apiOperation("getGithubAppConfiguration", "repository:read", "Read the GitHub App configuration", {
      "200": apiResponse("GitHub App configuration", { $ref: "#/components/schemas/GithubAppConfiguration" }),
      ...apiProblems(401, 403, 500),
    }),
  };
  paths["/github-app/repositories"] = {
    get: apiOperation("listGithubAppRepositories", "repository:read", "List repositories visible to the GitHub App", {
      "200": apiResponse("Repositories visible to active installations", { $ref: "#/components/schemas/GithubAppRepositoryCollection" }),
      ...apiProblems(401, 403, 500, 502, 503),
    }),
  };
  paths["/repository-installations/{installationId}"] = {
    parameters: [
      {
        name: "installationId",
        in: "path",
        required: true,
        schema: { type: "integer", minimum: 1 },
      },
    ],
    put: apiOperation(
      "replaceRepositoryInstallation",
      "repository:write",
      "Accept a GitHub App installation for the current owner",
      {
        "204": apiResponse("Repository installation accepted"),
        ...apiProblems(400, 401, 403, 500, 502, 503),
      },
      { parameters: [csrf] },
    ),
  };

  paths["/tasks/{taskId}"] = {
    ...paths["/tasks/{taskId}"],
    patch: apiOperation(
      "updateTask",
      "task:write",
      "Update a Task",
      {
        "200": {
          ...apiResponse("Task updated", { $ref: "#/components/schemas/Task" }),
          headers: { ...apiResponseHeaders, ETag: { $ref: "#/components/headers/ETag" } },
        },
        ...apiProblems(400, 401, 403, 404, 409, 415, 422, 500),
      },
      {
        parameters: [csrf],
        requestBody: {
          required: true,
          content: { "application/merge-patch+json": { schema: { $ref: "#/components/schemas/TaskUpdate" } } },
        },
      },
    ),
    delete: apiOperation(
      "deleteTask",
      "task:write",
      "Delete a Task",
      {
        "204": apiResponse("Task deleted"),
        ...apiProblems(400, 401, 403, 404, 409, 412, 428, 500),
      },
      { parameters: [csrf, { $ref: "#/components/parameters/IfMatch" }] },
    ),
  };
  paths["/tasks/{taskId}/claims"] = {
    parameters: [taskId],
    post: apiOperation(
      "createTaskClaim",
      "task:claim",
      "Create a Task Claim",
      {
        "200": {
          ...apiResponse("Existing Task Claim", { $ref: "#/components/schemas/TaskClaim" }),
          headers: apiResponseHeaders,
        },
        "201": {
          ...apiResponse("Task Claim created", { $ref: "#/components/schemas/TaskClaim" }),
          headers: apiResponseHeaders,
        },
        ...apiProblems(400, 401, 403, 404, 409, 415, 422, 500),
      },
      { parameters: [csrf, { $ref: "#/components/parameters/IdempotencyKey" }] },
    ),
  };
  paths["/tasks/{taskId}/session"] = {
    parameters: [taskId],
    get: apiOperation("getTaskSession", "task:read", "Read a Task's Agency Session", {
      "200": apiResponse("The Agency Session bound to the Task", { $ref: "#/components/schemas/AgencySession" }),
      ...apiProblems(401, 403, 404, 500, 502, 503),
    }),
  };
  paths["/tasks/{taskId}/session/ws"] = {
    parameters: [taskId],
    get: apiOperation(
      "getTaskSessionSocket",
      "task:read",
      "Observe a Task's Agency Session over WebSocket",
      {
        "101": apiResponse("WebSocket relay established"),
        "200": apiResponse("WebSocket connection details", { $ref: "#/components/schemas/TaskSessionSocket" }),
        ...apiProblems(401, 403, 404, 500, 502, 503),
      },
      {
        parameters: [
          {
            name: "Upgrade",
            in: "header",
            required: false,
            description: "Set to websocket to establish the read-only relay; omit it to retrieve connection details.",
            schema: { type: "string", const: "websocket" },
          },
        ],
      },
    ),
  };
  paths["/tasks/{taskId}/stream"] = {
    parameters: [taskId],
    get: apiOperation(
      "streamTaskEvents",
      "task:read",
      "Stream Task Notes",
      {
        "200": {
          description: "A bounded Server-Sent Events stream of Task Notes",
          headers: apiResponseHeaders,
          content: { "text/event-stream": { schema: { type: "string" } } },
        },
        ...apiProblems(400, 401, 403, 404, 500),
      },
      {
        parameters: [
          {
            name: "Last-Event-ID",
            in: "header",
            required: false,
            description: "Resume after a previously observed Task Note identifier.",
            schema: { type: "string" },
          },
        ],
      },
    ),
  };

  components.securitySchemes.browserSession = {
    type: "apiKey",
    in: "cookie",
    name: "ak_session",
    description: "Opaque HttpOnly browser session established by the Realmroot OIDC sign-in flow.",
  };
  components.parameters.CsrfToken = {
    name: "X-CSRF-Token",
    in: "header",
    required: false,
    description: "Required for unsafe requests authenticated with browserSession; omitted for OAuth access-token authentication.",
    schema: { type: "string" },
  };
  Object.assign(components.schemas, {
    DeleteResult: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean", const: true } },
    },
    BoardLabel: {
      type: "object",
      additionalProperties: false,
      required: ["name", "color", "description"],
      properties: { name: { type: "string" }, color: { type: "string" }, description: { type: "string" } },
    },
    BoardLabelWrite: {
      type: "object",
      additionalProperties: false,
      required: ["name", "color"],
      properties: { name: { type: "string" }, color: { type: "string" }, description: { type: "string" } },
    },
    BoardLabelUpdate: {
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string" }, color: { type: "string" }, description: { type: "string" } },
    },
    BoardUpdate: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        description: { type: ["string", "null"] },
        visibility: { type: "string", enum: ["private", "public"] },
        labels: { type: "array", items: { $ref: "#/components/schemas/BoardLabel" } },
      },
    },
    TaskUpdate: {
      oneOf: [
        { $ref: "#/components/schemas/TaskFieldsUpdate" },
        { $ref: "#/components/schemas/TaskAssignmentUpdate" },
        { $ref: "#/components/schemas/TaskStatusUpdate" },
      ],
    },
    TaskFieldsUpdate: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: {
        title: { type: "string" },
        description: { type: ["string", "null"] },
        repositoryId: { type: ["string", "null"] },
        labels: { type: ["array", "null"], items: { type: "string" } },
        pullRequestUrl: { type: ["string", "null"], format: "uri", pattern: "^https?://" },
        input: { type: ["object", "null"], additionalProperties: true },
        metadata: { type: "object", additionalProperties: true },
        position: { type: "number" },
        scheduledAt: {
          type: ["string", "null"],
          format: "date-time",
          description:
            "Reserved. Delayed scheduling is not implemented; non-null writes return 422. Existing values remain readable and may be cleared with null.",
        },
        dependsOn: { type: "array", items: { type: "string" } },
      },
    },
    TaskAssignmentUpdate: {
      type: "object",
      additionalProperties: false,
      required: ["assignedTo"],
      properties: { assignedTo: { type: "string", minLength: 1, maxLength: 200 } },
    },
    TaskStatusUpdate: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status"],
          properties: {
            status: { type: "string", const: "in-review" },
            pullRequestUrl: { type: "string", format: "uri", pattern: "^https?://" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status"],
          properties: {
            status: { type: "string", const: "in-progress" },
            statusReason: { type: "string", maxLength: 4000 },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status"],
          properties: { status: { type: "string", enum: ["done", "cancelled"] } },
        },
      ],
    },
    GithubAppConfiguration: {
      type: "object",
      additionalProperties: false,
      required: ["configured", "slug", "installUrl", "installed", "accounts"],
      properties: {
        configured: { type: "boolean" },
        slug: { type: ["string", "null"] },
        installUrl: { type: ["string", "null"], format: "uri" },
        installed: { type: "boolean" },
        accounts: { type: "array", items: { type: "string" } },
      },
    },
    GithubAppRepository: {
      type: "object",
      additionalProperties: false,
      required: ["fullName", "name", "cloneUrl", "private", "alreadyAdded"],
      properties: {
        fullName: { type: "string" },
        name: { type: "string" },
        cloneUrl: { type: "string", format: "uri" },
        private: { type: "boolean" },
        alreadyAdded: { type: "boolean" },
      },
    },
    GithubAppRepositoryCollection: {
      type: "object",
      additionalProperties: false,
      required: ["installed", "repositories"],
      properties: {
        installed: { type: "boolean" },
        repositories: { type: "array", items: { $ref: "#/components/schemas/GithubAppRepository" } },
      },
    },
    AgencySession: {
      type: "object",
      additionalProperties: true,
      required: ["metadata", "spec", "status"],
      properties: {
        metadata: { type: "object", additionalProperties: true },
        spec: { type: "object", additionalProperties: true },
        status: { type: "object", additionalProperties: true },
      },
    },
    TaskSessionSocket: {
      type: "object",
      additionalProperties: false,
      required: ["url", "sessionId"],
      properties: { url: { type: "string", format: "uri" }, sessionId: { type: "string" } },
    },
  });
  for (const pathItem of Object.values(paths)) {
    for (const [method, value] of Object.entries(pathItem)) {
      if (method === "parameters" || !value || typeof value !== "object") continue;
      const operation = value as { parameters?: unknown[] };
      operation.parameters ??= [];
      if (!operation.parameters.some((parameter) => (parameter as { $ref?: string }).$ref === apiVersion.$ref))
        operation.parameters.unshift(apiVersion);
      if (
        !["get", "head", "options"].includes(method) &&
        !operation.parameters.some((parameter) => (parameter as { $ref?: string }).$ref === csrf.$ref)
      ) {
        operation.parameters.push(csrf);
      }
    }
  }
  return document;
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
