import { API_VERSION } from "./contract";

type Method = "get" | "post" | "put" | "patch" | "delete";
type Operation = { method: Method; path: string; operationId: string; tag: string; summary: string; mutable?: boolean; conditionalReplace?: boolean };

const operations: Operation[] = [
  { method: "get", path: "/tenants/current", operationId: "getCurrentTenant", tag: "Tenancy", summary: "Get the caller tenant" },
  ...crud("boards", "Board", "Boards"),
  ...crud("repositories", "Repository", "Repositories"),
  { method: "get", path: "/boards/{boardId}/tasks", operationId: "listTasks", tag: "Tasks", summary: "List board tasks" },
  { method: "post", path: "/boards/{boardId}/tasks", operationId: "createTask", tag: "Tasks", summary: "Create a task" },
  { method: "get", path: "/tasks/{taskId}", operationId: "getTask", tag: "Tasks", summary: "Get a task" },
  { method: "patch", path: "/tasks/{taskId}", operationId: "updateTask", tag: "Tasks", summary: "Update task planning fields", mutable: true },
  { method: "delete", path: "/tasks/{taskId}", operationId: "deleteTask", tag: "Tasks", summary: "Delete a task", mutable: true },
  { method: "get", path: "/tasks/{taskId}/dependencies", operationId: "listTaskDependencies", tag: "Tasks", summary: "List task dependencies" },
  {
    method: "get",
    path: "/tasks/{taskId}/dependencies/{dependsOnTaskId}",
    operationId: "getTaskDependency",
    tag: "Tasks",
    summary: "Get a task dependency",
  },
  {
    method: "put",
    path: "/tasks/{taskId}/dependencies/{dependsOnTaskId}",
    operationId: "replaceTaskDependency",
    tag: "Tasks",
    summary: "Create a task dependency",
  },
  {
    method: "delete",
    path: "/tasks/{taskId}/dependencies/{dependsOnTaskId}",
    operationId: "deleteTaskDependency",
    tag: "Tasks",
    summary: "Delete a task dependency",
  },
  { method: "get", path: "/boards/{boardId}/labels", operationId: "listLabels", tag: "Boards", summary: "List board labels" },
  { method: "post", path: "/boards/{boardId}/labels", operationId: "createLabel", tag: "Boards", summary: "Create a label" },
  { method: "get", path: "/tasks/{taskId}/labels", operationId: "listTaskLabels", tag: "Tasks", summary: "List task labels" },
  { method: "get", path: "/labels/{labelId}", operationId: "getLabel", tag: "Boards", summary: "Get a label" },
  { method: "patch", path: "/labels/{labelId}", operationId: "updateLabel", tag: "Boards", summary: "Update a label", mutable: true },
  { method: "delete", path: "/labels/{labelId}", operationId: "deleteLabel", tag: "Boards", summary: "Delete a label", mutable: true },
  { method: "put", path: "/tasks/{taskId}/labels/{labelId}", operationId: "replaceTaskLabel", tag: "Tasks", summary: "Attach a label" },
  { method: "get", path: "/tasks/{taskId}/labels/{labelId}", operationId: "getTaskLabel", tag: "Tasks", summary: "Get a task label" },
  { method: "delete", path: "/tasks/{taskId}/labels/{labelId}", operationId: "deleteTaskLabel", tag: "Tasks", summary: "Detach a label" },
  {
    method: "get",
    path: "/boards/{boardId}/memberships",
    operationId: "listBoardMemberships",
    tag: "Memberships",
    summary: "List board memberships",
  },
  {
    method: "post",
    path: "/boards/{boardId}/memberships",
    operationId: "createBoardMembership",
    tag: "Memberships",
    summary: "Create a board membership",
  },
  {
    method: "get",
    path: "/board-memberships/{membershipId}",
    operationId: "getBoardMembership",
    tag: "Memberships",
    summary: "Get a board membership",
  },
  {
    method: "patch",
    path: "/board-memberships/{membershipId}",
    operationId: "updateBoardMembership",
    tag: "Memberships",
    summary: "Update a board membership",
    mutable: true,
  },
  {
    method: "delete",
    path: "/board-memberships/{membershipId}",
    operationId: "deleteBoardMembership",
    tag: "Memberships",
    summary: "Delete a board membership",
    mutable: true,
  },
  { method: "get", path: "/tasks/{taskId}/assignments", operationId: "listTaskAssignments", tag: "Execution", summary: "List task assignments" },
  {
    method: "post",
    path: "/tasks/{taskId}/assignments",
    operationId: "createTaskAssignment",
    tag: "Execution",
    summary: "Create an assignment for an AMA Agent ID",
  },
  { method: "get", path: "/task-assignments/{assignmentId}", operationId: "getTaskAssignment", tag: "Execution", summary: "Get an assignment" },
  {
    method: "delete",
    path: "/task-assignments/{assignmentId}",
    operationId: "deleteTaskAssignment",
    tag: "Execution",
    summary: "Release an assignment",
    mutable: true,
  },
  { method: "get", path: "/tasks/{taskId}/runs", operationId: "listTaskRuns", tag: "Execution", summary: "List task runs" },
  { method: "post", path: "/tasks/{taskId}/runs", operationId: "createTaskRun", tag: "Execution", summary: "Create a task run" },
  { method: "get", path: "/task-runs/{runId}", operationId: "getTaskRun", tag: "Execution", summary: "Get a task run" },
  { method: "get", path: "/task-runs/{runId}/progress-entries", operationId: "listTaskProgressEntries", tag: "Work", summary: "List run progress" },
  {
    method: "post",
    path: "/task-runs/{runId}/progress-entries",
    operationId: "createTaskProgressEntry",
    tag: "Work",
    summary: "Add progress to an assigned run",
  },
  { method: "get", path: "/task-progress-entries/{entryId}", operationId: "getTaskProgressEntry", tag: "Work", summary: "Get a progress entry" },
  { method: "get", path: "/tasks/{taskId}/messages", operationId: "listTaskMessages", tag: "Work", summary: "List task messages" },
  { method: "post", path: "/tasks/{taskId}/messages", operationId: "createTaskMessage", tag: "Work", summary: "Create and dispatch a task message" },
  { method: "get", path: "/task-messages/{messageId}", operationId: "getTaskMessage", tag: "Work", summary: "Get a task message" },
  { method: "get", path: "/tasks/{taskId}/submissions", operationId: "listTaskSubmissions", tag: "Reviews", summary: "List task submissions" },
  { method: "post", path: "/tasks/{taskId}/submissions", operationId: "createTaskSubmission", tag: "Reviews", summary: "Submit assigned work" },
  { method: "get", path: "/task-submissions/{submissionId}", operationId: "getTaskSubmission", tag: "Reviews", summary: "Get a submission" },
  {
    method: "get",
    path: "/task-submissions/{submissionId}/reviews",
    operationId: "listTaskReviews",
    tag: "Reviews",
    summary: "List submission reviews",
  },
  {
    method: "post",
    path: "/task-submissions/{submissionId}/reviews",
    operationId: "createTaskReview",
    tag: "Reviews",
    summary: "Create a terminal review",
  },
  { method: "get", path: "/task-reviews/{reviewId}", operationId: "getTaskReview", tag: "Reviews", summary: "Get a task review" },
  { method: "get", path: "/ama-connections", operationId: "listAmaConnections", tag: "Execution", summary: "List AMA connections" },
  { method: "post", path: "/ama-connections", operationId: "createAmaConnection", tag: "Execution", summary: "Create an AMA connection" },
  { method: "get", path: "/ama-connections/{connectionId}", operationId: "getAmaConnection", tag: "Execution", summary: "Get an AMA connection" },
  {
    method: "patch",
    path: "/ama-connections/{connectionId}",
    operationId: "updateAmaConnection",
    tag: "Execution",
    summary: "Update an AMA connection",
    mutable: true,
  },
  {
    method: "delete",
    path: "/ama-connections/{connectionId}",
    operationId: "deleteAmaConnection",
    tag: "Execution",
    summary: "Delete an AMA connection",
    mutable: true,
  },
  {
    method: "get",
    path: "/boards/{boardId}/execution-binding",
    operationId: "getBoardExecutionBinding",
    tag: "Execution",
    summary: "Get the board execution binding",
  },
  {
    method: "put",
    path: "/boards/{boardId}/execution-binding",
    operationId: "replaceBoardExecutionBinding",
    tag: "Execution",
    summary: "Create or replace the board execution binding",
    conditionalReplace: true,
  },
  {
    method: "delete",
    path: "/boards/{boardId}/execution-binding",
    operationId: "deleteBoardExecutionBinding",
    tag: "Execution",
    summary: "Delete the board execution binding",
    mutable: true,
  },
];

const scopeDescriptions = {
  "boards:read": "Read boards and labels",
  "boards:write": "Create and maintain boards and labels",
  "repositories:read": "Read repositories",
  "repositories:write": "Create and maintain repositories",
  "tasks:read": "Read tasks and dependencies",
  "tasks:write": "Plan tasks and dependencies",
  "memberships:read": "Read board memberships",
  "memberships:write": "Manage board memberships",
  "execution:read": "Read assignments, runs, and AMA bindings",
  "execution:write": "Assign and dispatch task runs",
  "work:read": "Read progress and messages",
  "work:write": "Write progress and messages for assigned work",
  "reviews:read": "Read submissions and reviews",
  "reviews:write": "Submit and review work",
};

function crud(collection: string, singular: string, tag: string): Operation[] {
  const id = `${singular[0].toLowerCase()}${singular.slice(1)}Id`;
  return [
    { method: "get", path: `/${collection}`, operationId: `list${singular}s`, tag, summary: `List ${singular}s` },
    { method: "post", path: `/${collection}`, operationId: `create${singular}`, tag, summary: `Create a ${singular}` },
    { method: "get", path: `/${collection}/{${id}}`, operationId: `get${singular}`, tag, summary: `Get a ${singular}` },
    { method: "patch", path: `/${collection}/{${id}}`, operationId: `update${singular}`, tag, summary: `Update a ${singular}`, mutable: true },
    { method: "delete", path: `/${collection}/{${id}}`, operationId: `delete${singular}`, tag, summary: `Delete a ${singular}`, mutable: true },
  ];
}

export function openApiDocument(requestUrl: string, issuer: string): Record<string, unknown> {
  const origin = new URL(requestUrl).origin;
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const parameters: unknown[] = [
      header("API-Version", { type: "string", const: API_VERSION }, true),
      header("Request-Id", { type: "string" }, false),
      header("traceparent", { type: "string" }, false),
      header("tracestate", { type: "string" }, false),
    ];
    for (const match of operation.path.matchAll(/\{([^}]+)\}/g))
      parameters.push({ name: match[1], in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 256 } });
    if (operation.method === "get" && (operation.operationId.startsWith("list") || operation.path.endsWith("/tasks")))
      parameters.push({ $ref: "#/components/parameters/PageSize" }, { $ref: "#/components/parameters/PageToken" });
    if (operation.operationId === "listTasks")
      parameters.push({ name: "status", in: "query", schema: { type: "string", enum: ["todo", "queued", "in_progress", "in_review", "done"] } });
    if (operation.method === "post") parameters.push({ $ref: "#/components/parameters/IdempotencyKey" });
    if (operation.mutable) parameters.push({ $ref: "#/components/parameters/IfMatch" });
    if (operation.conditionalReplace)
      parameters.push({
        name: "If-Match",
        in: "header",
        required: false,
        description: "Required when replacing an existing execution binding; omit when creating it.",
        schema: { type: "string" },
      });
    const schema = requestSchema(operation.operationId);
    const hasBody = schema !== undefined;
    const success = operation.method === "delete" ? "204" : operation.method === "post" || operation.method === "put" ? "201" : "200";
    const resourceSchema = responseSchema(operation);
    const pathItem = paths[operation.path] ?? {};
    pathItem[operation.method] = {
      operationId: operation.operationId,
      tags: [operation.tag],
      summary: operation.summary,
      parameters,
      ...(hasBody
        ? {
            requestBody: {
              required: true,
              content: { [operation.method === "patch" ? "application/merge-patch+json" : "application/json"]: { schema } },
            },
          }
        : {}),
      security: [{ RealmrootOAuth: [scopeFor(operation)] }],
      responses: {
        ...(operation.conditionalReplace
          ? {
              "200": {
                description: "Existing resource replaced",
                headers: responseHeaders(),
                content: { "application/json": { schema: resourceSchema } },
              },
            }
          : {}),
        [success]: {
          description: operation.conditionalReplace ? "Resource created" : "Success",
          headers: responseHeaders(),
          ...(success === "204" ? {} : { content: { "application/json": { schema: resourceSchema } } }),
        },
        "400": { $ref: "#/components/responses/Problem" },
        "401": { $ref: "#/components/responses/Problem" },
        "403": { $ref: "#/components/responses/Problem" },
        "404": { $ref: "#/components/responses/Problem" },
        "409": { $ref: "#/components/responses/Problem" },
        "412": { $ref: "#/components/responses/Problem" },
        "422": { $ref: "#/components/responses/Problem" },
        "428": { $ref: "#/components/responses/Problem" },
      },
    };
    paths[operation.path] = pathItem;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Agent Kanban",
      version: API_VERSION,
      description: "Resource-oriented Agent Kanban v2 API. OpenAPI is the source for the Realmroot Toolbox named agent-kanban.",
      "x-realmroot-toolbox-name": "agent-kanban",
    },
    servers: [{ url: `${origin}/api` }],
    tags: [...new Set(operations.map((operation) => operation.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        RealmrootOAuth: {
          type: "oauth2",
          "x-dpop-required": true,
          flows: {
            authorizationCode: {
              authorizationUrl: `${issuer.replace(/\/$/, "")}/oauth2/authorize`,
              tokenUrl: `${issuer.replace(/\/$/, "")}/oauth2/token`,
              scopes: scopeDescriptions,
            },
          },
        },
      },
      parameters: {
        PageSize: { name: "pageSize", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
        PageToken: { name: "pageToken", in: "query", schema: { type: "string" } },
        IdempotencyKey: header("Idempotency-Key", { type: "string", minLength: 1, maxLength: 160 }, true),
        IfMatch: header("If-Match", { type: "string" }, true),
      },
      schemas: {
        Links: {
          type: "object",
          required: ["self"],
          properties: { self: { type: "string", format: "uri" } },
          additionalProperties: { type: "string", format: "uri" },
        },
        Pagination: {
          type: "object",
          required: ["pageSize"],
          properties: { pageSize: { type: "integer", minimum: 0 }, nextPageToken: { type: "string" } },
          additionalProperties: false,
        },
        Tenant: resourceObject({ id: { type: "string" } }, ["id"]),
        Board: resourceObject(
          {
            id: { type: "string" },
            tenantId: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            version: { type: "integer" },
            createdAt: { type: "string" },
            updatedAt: { type: "string" },
          },
          ["id", "tenantId", "name", "description", "version", "createdAt", "updatedAt"],
        ),
        Repository: resourceObject(
          {
            id: { type: "string" },
            tenantId: { type: "string" },
            name: { type: "string" },
            url: { type: "string", format: "uri" },
            defaultBranch: { type: "string" },
            version: { type: "integer" },
            createdAt: { type: "string" },
            updatedAt: { type: "string" },
          },
          ["id", "tenantId", "name", "url", "defaultBranch", "version", "createdAt", "updatedAt"],
        ),
        Task: resourceObject(
          {
            id: { type: "string" },
            tenantId: { type: "string" },
            boardId: { type: "string" },
            repositoryId: { type: ["string", "null"] },
            createdFromTaskId: { type: ["string", "null"] },
            title: { type: "string" },
            description: { type: "string" },
            status: { type: "string", enum: ["todo", "queued", "in_progress", "in_review", "done"] },
            blocked: { type: "boolean" },
            priority: { type: "integer" },
            createdByIssuer: { type: ["string", "null"] },
            createdBySubject: { type: "string" },
            labels: { type: "array", items: { $ref: "#/components/schemas/TaskLabelSummary" } },
            assignment: { oneOf: [{ $ref: "#/components/schemas/TaskAssignmentSummary" }, { type: "null" }] },
            version: { type: "integer" },
            createdAt: { type: "string" },
            updatedAt: { type: "string" },
          },
          [
            "id",
            "tenantId",
            "boardId",
            "title",
            "description",
            "status",
            "blocked",
            "priority",
            "createdBySubject",
            "version",
            "createdAt",
            "updatedAt",
          ],
        ),
        Label: resourceObject(
          { id: { type: "string" }, boardId: { type: "string" }, name: { type: "string" }, color: { type: "string" }, version: { type: "integer" } },
          ["id", "boardId", "name", "color", "version"],
        ),
        TaskLabelSummary: {
          type: "object",
          required: ["id", "name", "color"],
          properties: { id: { type: "string" }, name: { type: "string" }, color: { type: "string" } },
          additionalProperties: false,
        },
        BoardMembership: resourceObject(
          {
            id: { type: "string" },
            boardId: { type: "string" },
            agentId: { type: "string" },
            capabilities: { type: "array", items: { type: "string", enum: ["plan", "assign", "work", "review", "maintain"] } },
            version: { type: "integer" },
          },
          ["id", "boardId", "agentId", "capabilities", "version"],
        ),
        TaskAssignment: resourceObject(
          {
            id: { type: "string" },
            taskId: { type: "string" },
            agentId: { type: "string" },
            status: { type: "string", enum: ["active", "released", "completed"] },
            version: { type: "integer" },
          },
          ["id", "taskId", "agentId", "status", "version"],
        ),
        TaskAssignmentSummary: {
          type: "object",
          required: ["id", "tenantId", "taskId", "agentId", "status", "version", "createdAt", "updatedAt"],
          properties: {
            id: { type: "string" },
            tenantId: { type: "string" },
            taskId: { type: "string" },
            agentId: { type: "string" },
            status: { type: "string", enum: ["active"] },
            version: { type: "integer" },
            createdAt: { type: "string" },
            updatedAt: { type: "string" },
          },
          additionalProperties: false,
        },
        TaskRun: resourceObject(
          {
            id: { type: "string" },
            taskId: { type: "string" },
            assignmentId: { type: "string" },
            amaSessionUri: { type: ["string", "null"], format: "uri" },
            status: { type: "string", enum: ["pending", "running", "succeeded", "failed", "cancelled"] },
            failureCode: { type: ["string", "null"] },
            version: { type: "integer" },
          },
          ["id", "taskId", "assignmentId", "status", "version"],
        ),
        TaskProgressEntry: resourceObject(
          {
            id: { type: "string" },
            taskId: { type: "string" },
            runId: { type: "string" },
            kind: { type: "string", enum: ["note", "checkpoint", "blocked", "unblocked"] },
            body: { type: "string" },
            createdAt: { type: "string" },
          },
          ["id", "taskId", "runId", "kind", "body", "createdAt"],
        ),
        TaskMessage: resourceObject(
          {
            id: { type: "string" },
            taskId: { type: "string" },
            senderIssuer: { type: ["string", "null"] },
            senderSubject: { type: "string" },
            body: { type: "string" },
            deliveryStatus: { type: "string", enum: ["pending", "delivered", "failed"] },
            createdAt: { type: "string" },
          },
          ["id", "taskId", "senderSubject", "body", "deliveryStatus", "createdAt"],
        ),
        TaskSubmission: resourceObject(
          {
            id: { type: "string" },
            taskId: { type: "string" },
            runId: { type: "string" },
            summary: { type: "string" },
            artifactUrls: { type: "array", items: { type: "string", format: "uri" } },
            status: { type: "string", enum: ["pending_review", "accepted", "rejected"] },
          },
          ["id", "taskId", "runId", "summary", "artifactUrls", "status"],
        ),
        TaskReview: resourceObject(
          {
            id: { type: "string" },
            taskId: { type: "string" },
            submissionId: { type: "string" },
            reviewerIssuer: { type: ["string", "null"] },
            reviewerSubject: { type: "string" },
            decision: { type: "string", enum: ["accepted", "rejected"] },
            body: { type: "string" },
            createdAt: { type: "string" },
          },
          ["id", "taskId", "submissionId", "reviewerSubject", "decision", "body", "createdAt"],
        ),
        AmaConnection: resourceObject(
          {
            id: { type: "string" },
            resourceUrl: { type: "string", format: "uri" },
            projectUri: { type: "string", format: "uri" },
            status: { type: "string", enum: ["active", "disabled"] },
            version: { type: "integer" },
          },
          ["id", "resourceUrl", "projectUri", "status", "version"],
        ),
        BoardExecutionBinding: resourceObject(
          { id: { type: "string" }, boardId: { type: "string" }, amaConnectionId: { type: "string" }, version: { type: "integer" } },
          ["id", "boardId", "amaConnectionId", "version"],
        ),
        TaskDependency: {
          type: "object",
          required: ["id", "taskId", "dependsOnTaskId", "createdAt", "links"],
          properties: {
            id: { type: "string" },
            taskId: { type: "string" },
            dependsOnTaskId: { type: "string" },
            createdAt: { type: "string" },
            links: { $ref: "#/components/schemas/Links" },
          },
          additionalProperties: false,
        },
        TaskLabel: {
          type: "object",
          required: ["taskId", "labelId", "links"],
          properties: { taskId: { type: "string" }, labelId: { type: "string" }, links: { $ref: "#/components/schemas/Links" } },
          additionalProperties: false,
        },
        Problem: {
          type: "object",
          required: ["type", "title", "status", "detail", "instance"],
          properties: {
            type: { type: "string", format: "uri" },
            title: { type: "string" },
            status: { type: "integer" },
            detail: { type: "string" },
            instance: { type: "string", pattern: "^urn:request:" },
            errors: {
              type: "array",
              items: {
                type: "object",
                required: ["pointer", "detail"],
                properties: { pointer: { type: "string", pattern: "^#/body/" }, detail: { type: "string" } },
              },
            },
          },
        },
      },
      responses: {
        Problem: {
          description: "Problem Details",
          headers: responseHeaders(),
          content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
        },
      },
    },
  };
}

function header(name: string, schema: Record<string, unknown>, required: boolean): Record<string, unknown> {
  return { name, in: "header", required, schema };
}
function responseHeaders(): Record<string, unknown> {
  return {
    "Request-Id": { schema: { type: "string" } },
    "API-Version": { schema: { type: "string", const: API_VERSION } },
    ETag: { schema: { type: "string" } },
    Location: { schema: { type: "string", format: "uri" } },
    Link: { schema: { type: "string" } },
  };
}

function scopeFor(operation: Operation): keyof typeof scopeDescriptions {
  const access = operation.method === "get" ? "read" : "write";
  const domain =
    operation.tag === "Repositories"
      ? "repositories"
      : operation.tag === "Tasks"
        ? "tasks"
        : operation.tag === "Memberships"
          ? "memberships"
          : operation.tag === "Execution"
            ? "execution"
            : operation.tag === "Work"
              ? "work"
              : operation.tag === "Reviews"
                ? "reviews"
                : "boards";
  return `${domain}:${access}` as keyof typeof scopeDescriptions;
}

function requestSchema(operationId: string): Record<string, unknown> | undefined {
  const object = (properties: Record<string, unknown>, required: string[] = []) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
  const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
  switch (operationId) {
    case "createBoard":
      return object({ name: text(160), description: { type: "string", maxLength: 16384 } }, ["name"]);
    case "updateBoard":
      return object({ name: text(160), description: { type: "string", maxLength: 16384 } });
    case "createRepository":
      return object({ name: text(160), url: { type: "string", format: "uri", maxLength: 2048 }, defaultBranch: text(160) }, ["name", "url"]);
    case "updateRepository":
      return object({ name: text(160), defaultBranch: text(160) });
    case "createTask":
      return object(
        {
          title: text(240),
          description: { type: "string", maxLength: 16384 },
          repositoryId: { type: "string" },
          createdFromTaskId: { type: "string" },
          priority: { type: "integer", minimum: -100, maximum: 100 },
        },
        ["title"],
      );
    case "updateTask":
      return object({
        title: text(240),
        description: { type: "string", maxLength: 16384 },
        priority: { type: "integer", minimum: -100, maximum: 100 },
      });
    case "createLabel":
      return object({ name: text(80), color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" } }, ["name", "color"]);
    case "updateLabel":
      return object({ name: text(80), color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" } });
    case "createBoardMembership":
      return object(
        {
          agentId: text(200),
          capabilities: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", enum: ["plan", "assign", "work", "review", "maintain"] },
          },
        },
        ["agentId", "capabilities"],
      );
    case "updateBoardMembership":
      return object(
        {
          capabilities: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", enum: ["plan", "assign", "work", "review", "maintain"] },
          },
        },
        ["capabilities"],
      );
    case "createTaskAssignment":
      return object({ agentId: text(200) }, ["agentId"]);
    case "createTaskRun":
      return object({});
    case "createTaskProgressEntry":
      return object({ kind: { type: "string", enum: ["note", "checkpoint", "blocked", "unblocked"] }, body: text(16384) }, ["kind", "body"]);
    case "createTaskMessage":
      return object({ body: text(16384) }, ["body"]);
    case "createTaskSubmission":
      return object(
        { runId: text(80), summary: text(16384), artifactUrls: { type: "array", maxItems: 32, items: { type: "string", format: "uri" } } },
        ["runId", "summary"],
      );
    case "createTaskReview":
      return object({ decision: { type: "string", enum: ["accepted", "rejected"] }, body: { type: "string", maxLength: 16384 } }, ["decision"]);
    case "createAmaConnection":
      return object({ resourceUrl: { type: "string", format: "uri" }, projectUri: { type: "string", format: "uri" } }, ["resourceUrl", "projectUri"]);
    case "updateAmaConnection":
      return object({ status: { type: "string", enum: ["active", "disabled"] } }, ["status"]);
    case "replaceBoardExecutionBinding":
      return object({ amaConnectionId: text(80) }, ["amaConnectionId"]);
    default:
      return undefined;
  }
}

function resourceObject(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return {
    type: "object",
    required: [...required, "links"],
    properties: {
      tenantId: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
      ...properties,
      links: { $ref: "#/components/schemas/Links" },
    },
    additionalProperties: false,
  };
}

function responseSchema(operation: Operation): Record<string, unknown> {
  const id = operation.operationId;
  const name = id.includes("BoardExecutionBinding")
    ? "BoardExecutionBinding"
    : id.includes("AmaConnection")
      ? "AmaConnection"
      : id.includes("TaskProgressEntr")
        ? "TaskProgressEntry"
        : id.includes("TaskAssignment")
          ? "TaskAssignment"
          : id.includes("TaskSubmission")
            ? "TaskSubmission"
            : id.includes("TaskReview")
              ? "TaskReview"
              : id.includes("TaskMessage")
                ? "TaskMessage"
                : id.includes("TaskRun")
                  ? "TaskRun"
                  : id.includes("BoardMembership")
                    ? "BoardMembership"
                    : id.includes("TaskDependency")
                      ? "TaskDependency"
                      : id.includes("TaskLabel")
                        ? "TaskLabel"
                        : id.includes("Repository")
                          ? "Repository"
                          : id.includes("Label")
                            ? "Label"
                            : id.includes("Task")
                              ? "Task"
                              : id.includes("Board")
                                ? "Board"
                                : "Tenant";
  if (operation.method === "get" && id.startsWith("list"))
    return {
      type: "object",
      required: ["items", "pagination"],
      properties: {
        items: { type: "array", items: { $ref: `#/components/schemas/${name}` } },
        pagination: { $ref: "#/components/schemas/Pagination" },
      },
      additionalProperties: false,
    };
  return { $ref: `#/components/schemas/${name}` };
}
