import { type Context, Hono } from "hono";
import skillDocument from "../../../skills/agent-kanban/SKILL.md?raw";
import { AccessRepo } from "./accessRepo";
import { AmaSessionTerminalError, amaSessionRequest, fetchAmaConsole, readAmaSession, resolveAmaAgent, validateAmaConnection } from "./ama";
import { AmaBindingRepo } from "./amaBindingRepo";
import { authenticationMiddleware, requireAssignedActor, requireBoardCapability } from "./auth";
import {
  API_VERSION,
  ApiProblem,
  apiVersionMiddleware,
  canonical,
  contractMiddleware,
  etag,
  idempotentCreate,
  jsonObject,
  optionalString,
  pageRequest,
  pageResponse,
  problem,
  requiredString,
  requireIfMatch,
} from "./contract";
import { isConstraintError, newId, ping, publicRow } from "./db";
import { ExecutionRepo } from "./executionRepo";
import { openApiDocument } from "./openapi";
import { type DomainRow, PlanningRepo } from "./planningRepo";
import {
  AmaUserGrantRequired,
  beginRealmrootLogin,
  endRealmrootWebSession,
  finishRealmrootLogin,
  readRealmrootWebSession,
  realmrootManagementBearerToken,
  releaseAmaGrantIfUnused,
  resourceUrl,
  revokeReleasedAmaGrant,
} from "./realmrootAuth";
import type { Env } from "./types";

type Row = DomainRow;
const CAPABILITIES = new Set(["plan", "assign", "work", "review", "maintain"]);

export const api = new Hono<{ Bindings: Env }>();

api.onError((error, c) => {
  const value =
    error instanceof ApiProblem
      ? error
      : error instanceof AmaUserGrantRequired
        ? new ApiProblem(error.status, "ama-user-grant-required", "AMA Authorization Required", error.message)
        : new ApiProblem(500, "internal", "Internal Server Error", "The request failed unexpectedly.");
  c.set("failureClassification", value.type);
  if (!(error instanceof ApiProblem)) c.set("failureCause", error instanceof Error ? error.message : String(error));
  return problem(c, value);
});

api.use("*", contractMiddleware);
api.get("/api/health", (c) => c.json({ status: "ok", version: API_VERSION }));
api.get("/api/ready", async (c) => {
  await ping(c.env.DB);
  return c.json({ status: "ready", version: API_VERSION });
});
api.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
api.get("/.well-known/oauth-protected-resource/api", protectedResourceMetadata);
api.get("/.well-known/agent-skills/index.json", async (c) =>
  c.json({
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [
      {
        name: "agent-kanban",
        type: "skill-md",
        description: "Operate Agent Kanban boards through Realmroot Toolbox.",
        url: canonical(c, "/skills/agent-kanban/SKILL.md"),
        digest: `sha256:${await textDigest(skillDocument)}`,
      },
    ],
  }),
);
api.get("/skills/agent-kanban/SKILL.md", (c) => c.text(skillDocument, 200, { "Content-Type": "text/markdown; charset=utf-8" }));
api.get("/api/openapi.json", (c) => c.json(openApiDocument(canonical(c, "/api/openapi.json"), c.env.REALMROOT_ISSUER)));
api.get("/api", (c) =>
  c.json({ name: "Agent Kanban", resource: resourceUrl(c.env, c.req.url), openapi: canonical(c, "/api/openapi.json") }, 200, {
    Link: `<${canonical(c, "/api/openapi.json")}>; rel="service-desc"; type="application/vnd.oai.openapi+json;version=3.1"`,
  }),
);

api.get("/api/auth/login", beginRealmrootLogin);
api.get("/api/auth/callback", finishRealmrootLogin);
api.get("/api/auth/session", readRealmrootWebSession);
api.post("/api/auth/logout", endRealmrootWebSession);

api.use("/api/*", apiVersionMiddleware);
api.use("/api/*", authenticationMiddleware);

api.get("/api/tenants/current", (c) => c.json({ id: c.get("principal").tenantId, links: { self: canonical(c, "/api/tenants/current") } }));

api.get("/api/console/ama-projects", async (c) => amaProjects(c));
api.get("/api/console/ama-connections/:connectionId/agents", async (c) => amaCollection(c, c.req.param("connectionId"), "/api/v1/agents?limit=100"));
api.post("/api/console/ama-connections/:connectionId/agents", async (c) =>
  amaMutation(c, c.req.param("connectionId"), "/api/v1/agents", "POST", await jsonObject(c)),
);
api.get("/api/console/ama-connections/:connectionId/agents/:agentId", async (c) =>
  amaResourceResponse(c, c.req.param("connectionId"), `/api/v1/agents/${encodeURIComponent(c.req.param("agentId"))}`),
);
api.patch("/api/console/ama-connections/:connectionId/agents/:agentId", async (c) =>
  amaMutation(c, c.req.param("connectionId"), `/api/v1/agents/${encodeURIComponent(c.req.param("agentId"))}`, "PATCH", await jsonObject(c)),
);
api.delete("/api/console/ama-connections/:connectionId/agents/:agentId", async (c) =>
  amaMutation(c, c.req.param("connectionId"), `/api/v1/agents/${encodeURIComponent(c.req.param("agentId"))}`, "DELETE"),
);
api.get("/api/console/ama-connections/:connectionId/environments", async (c) =>
  amaCollection(c, c.req.param("connectionId"), "/api/v1/environments?limit=100"),
);
api.get("/api/console/ama-connections/:connectionId/runners", async (c) =>
  amaCollection(c, c.req.param("connectionId"), "/api/v1/runners?limit=100"),
);
api.get("/api/console/ama-connections/:connectionId/sessions", async (c) =>
  amaCollection(c, c.req.param("connectionId"), "/api/v1/sessions?limit=100"),
);

api.get("/api/console/ama-connections/:connectionId/machines", async (c) => c.json({ items: await amaMachines(c, c.req.param("connectionId")) }));
api.get("/api/console/ama-connections/:connectionId/machines/:machineId", async (c) => {
  const machine = (await amaMachines(c, c.req.param("connectionId"))).find((item) => item.id === c.req.param("machineId"));
  if (!machine) throw new ApiProblem(404, "machine-not-found", "Machine Not Found", "AMA has no matching Environment.");
  return c.json(machine);
});
api.post("/api/console/ama-connections/:connectionId/machines", async (c) => {
  const body = await jsonObject(c);
  const name = requiredString(body, "name", 160);
  const type = body.type === "cloud" ? "cloud" : "self_hosted";
  return amaMutation(c, c.req.param("connectionId"), "/api/v1/environments", "POST", {
    metadata: { name, description: optionalString(body, "description") ?? null },
    spec: {
      scope: "project",
      type,
      networking: { type: "open", allowMcpServers: true, allowPackageManagers: true },
      packages: { type: "packages", apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
      variables: {},
    },
  });
});
api.delete("/api/console/ama-connections/:connectionId/machines/:machineId", async (c) =>
  amaMutation(c, c.req.param("connectionId"), `/api/v1/environments/${encodeURIComponent(c.req.param("machineId"))}`, "DELETE"),
);

api.get("/api/boards", async (c) => {
  const page = await pageRequest(c);
  const rows = await planning(c).boards(page.cursor ?? null, page.pageSize);
  return c.json(await pageResponse(c, rows.map((row) => resource(c, row, `/api/boards/${row.id}`)) as never, page.pageSize, page.queryFingerprint));
});

api.post("/api/boards", async (c) => {
  const body = await jsonObject(c);
  const name = requiredString(body, "name", 160);
  const description = optionalString(body, "description") ?? "";
  return idempotentCreate(
    c,
    body,
    "brd",
    async (id) => {
      await ensureTenant(c);
      await executeConstraint(() => planning(c).createBoard(id, name, description));
      const row = await boardRow(c, id);
      const value = resource(c, row, `/api/boards/${id}`);
      return { status: 201, value, location: value.links.self };
    },
    (id) => recoverCreated(c, () => boardRow(c, id), `/api/boards/${id}`),
  );
});

api.get("/api/boards/:boardId", async (c) => {
  const row = await boardRow(c, c.req.param("boardId"));
  c.header("ETag", etag(row.version));
  return c.json(resource(c, row, `/api/boards/${row.id}`));
});

api.patch("/api/boards/:boardId", async (c) => {
  const row = await boardRow(c, c.req.param("boardId"));
  await requireBoardCapability(c, row.id, "maintain");
  requireIfMatch(c, row.version);
  const body = await jsonObject(c);
  const name = patchNonEmptyString(body, "name", row.name, 160);
  const description = optionalString(body, "description") ?? row.description;
  const result = await executeConstraint(() => planning(c).updateBoard(row.id, row.version, name, description));
  requireChanged(result);
  const updated = await boardRow(c, row.id);
  c.header("ETag", etag(updated.version));
  return c.json(resource(c, updated, `/api/boards/${row.id}`));
});

api.delete("/api/boards/:boardId", async (c) => {
  const row = await boardRow(c, c.req.param("boardId"));
  await requireBoardCapability(c, row.id, "maintain");
  requireIfMatch(c, row.version);
  rejectBoardHistory(await planning(c).hasBoardExecutionHistory(row.id));
  const result = await planning(c).deleteBoardWithoutExecutionHistory(row.id, row.version);
  rejectBoardHistory(await planning(c).hasBoardExecutionHistory(row.id));
  requireChanged(result);
  return c.body(null, 204);
});

api.get("/api/repositories", async (c) => {
  const page = await pageRequest(c);
  const rows = await planning(c).repositories(page.cursor ?? null, page.pageSize);
  return c.json(
    await pageResponse(c, rows.map((row) => resource(c, row, `/api/repositories/${row.id}`)) as never, page.pageSize, page.queryFingerprint),
  );
});

api.post("/api/repositories", async (c) => {
  const body = await jsonObject(c);
  const name = requiredString(body, "name", 160);
  const url = validUrl(requiredString(body, "url", 2048));
  const defaultBranch = optionalString(body, "defaultBranch", 160) ?? "main";
  return idempotentCreate(
    c,
    body,
    "repo",
    async (id) => {
      await ensureTenant(c);
      await executeConstraint(() => planning(c).createRepository(id, name, url, defaultBranch));
      const row = await repositoryRow(c, id);
      const value = resource(c, row, `/api/repositories/${id}`);
      return { status: 201, value, location: value.links.self };
    },
    (id) => recoverCreated(c, () => repositoryRow(c, id), `/api/repositories/${id}`),
  );
});

api.get("/api/repositories/:repositoryId", async (c) => {
  const row = await repositoryRow(c, c.req.param("repositoryId"));
  c.header("ETag", etag(row.version));
  return c.json(resource(c, row, `/api/repositories/${row.id}`));
});

api.patch("/api/repositories/:repositoryId", async (c) => {
  const row = await repositoryRow(c, c.req.param("repositoryId"));
  requireIfMatch(c, row.version);
  const body = await jsonObject(c);
  const name = patchNonEmptyString(body, "name", row.name, 160);
  const defaultBranch = patchNonEmptyString(body, "defaultBranch", row.default_branch, 160);
  const result = await planning(c).updateRepository(row.id, row.version, name, defaultBranch);
  requireChanged(result);
  const updated = await repositoryRow(c, row.id);
  c.header("ETag", etag(updated.version));
  return c.json(resource(c, updated, `/api/repositories/${row.id}`));
});

api.delete("/api/repositories/:repositoryId", async (c) => {
  const row = await repositoryRow(c, c.req.param("repositoryId"));
  requireIfMatch(c, row.version);
  const result = await planning(c).deleteRepository(row.id, row.version);
  requireChanged(result);
  return c.body(null, 204);
});

api.get("/api/boards/:boardId/tasks", async (c) => {
  const board = await boardRow(c, c.req.param("boardId"));
  await requireBoardCapability(c, board.id, "plan");
  const page = await pageRequest(c);
  const status = c.req.query("status");
  if (status && !["todo", "queued", "in_progress", "in_review", "done"].includes(status))
    throw new ApiProblem(400, "invalid-status", "Invalid Status", "status is not supported.");
  const rows = await planning(c).tasks(board.id, status, page.cursor ?? null, page.pageSize);
  const resources = await taskCollectionResources(c, rows);
  return c.json(await pageResponse(c, resources as never, page.pageSize, page.queryFingerprint));
});

api.post("/api/boards/:boardId/tasks", async (c) => {
  const board = await boardRow(c, c.req.param("boardId"));
  await requireBoardCapability(c, board.id, "plan");
  const body = await jsonObject(c);
  const title = requiredString(body, "title", 240);
  const description = optionalString(body, "description") ?? "";
  const repositoryId = optionalString(body, "repositoryId", 80) ?? null;
  const createdFromTaskId = optionalString(body, "createdFromTaskId", 80) ?? null;
  const priority = body.priority === undefined ? 0 : Number(body.priority);
  if (!Number.isInteger(priority) || priority < -100 || priority > 100)
    throw new ApiProblem(422, "validation", "Validation Failed", "priority must be an integer from -100 to 100.");
  return idempotentCreate(
    c,
    body,
    "tsk",
    async (id) => {
      const principal = c.get("principal");
      if (repositoryId) await repositoryRow(c, repositoryId);
      if (createdFromTaskId) {
        const source = await taskRow(c, createdFromTaskId);
        if (source.board_id !== board.id)
          throw new ApiProblem(422, "cross-board-origin", "Invalid Task Origin", "createdFromTaskId must belong to this board.");
      }
      await executeConstraint(() =>
        planning(c).createTask({
          id,
          boardId: board.id,
          repositoryId,
          createdFromTaskId,
          title,
          description,
          priority,
          createdByIssuer: principal.actor?.issuer ?? null,
          createdBySubject: principal.actor?.subject ?? principal.subjectId,
        }),
      );
      const row = await taskRow(c, id);
      const value = taskResource(c, row);
      return { status: 201, value, location: value.links.self };
    },
    (id) =>
      recoverCreated(
        c,
        () => taskRow(c, id),
        `/api/tasks/${id}`,
        [],
        (row) => taskResource(c, row),
      ),
  );
});

api.get("/api/tasks/:taskId", async (c) => {
  const row = await taskRow(c, c.req.param("taskId"));
  c.header("ETag", etag(row.version));
  return c.json(taskResource(c, row));
});

api.patch("/api/tasks/:taskId", async (c) => {
  const row = await taskRow(c, c.req.param("taskId"));
  await requireBoardCapability(c, row.board_id, "plan");
  requireIfMatch(c, row.version);
  const body = await jsonObject(c);
  if ("status" in body) throw new ApiProblem(422, "status-read-only", "Validation Failed", "Task status is controlled by lifecycle resources.");
  const title = patchNonEmptyString(body, "title", row.title, 240);
  const description = optionalString(body, "description") ?? row.description;
  const priority = body.priority === undefined ? row.priority : Number(body.priority);
  if (!Number.isInteger(priority) || priority < -100 || priority > 100)
    throw new ApiProblem(422, "validation", "Validation Failed", "priority must be an integer from -100 to 100.");
  const result = await planning(c).updateTask(row.id, row.version, title, description, priority);
  requireChanged(result);
  const updated = await taskRow(c, row.id);
  c.header("ETag", etag(updated.version));
  return c.json(taskResource(c, updated));
});

api.delete("/api/tasks/:taskId", async (c) => {
  const row = await taskRow(c, c.req.param("taskId"));
  await requireBoardCapability(c, row.board_id, "maintain");
  requireIfMatch(c, row.version);
  rejectTaskHistory(await planning(c).hasTaskExecutionHistory(row.id));
  const result = await planning(c).deleteTaskWithoutExecutionHistory(row.id, row.version);
  rejectTaskHistory(await planning(c).hasTaskExecutionHistory(row.id));
  requireChanged(result);
  return c.body(null, 204);
});

api.get("/api/tasks/:taskId/dependencies", async (c) => {
  const task = await taskRow(c, c.req.param("taskId"));
  const page = await pageRequest(c);
  const rows = await planning(c).dependencies(task.id, page.cursor ?? null, page.pageSize);
  const resources = rows.map((row) => dependencyResource(c, task.id, row));
  return c.json(await pageResponse(c, resources as never, page.pageSize, page.queryFingerprint));
});

api.get("/api/tasks/:taskId/dependencies/:dependsOnTaskId", async (c) => {
  const task = await taskRow(c, c.req.param("taskId"));
  const row = await planning(c).dependency(task.id, c.req.param("dependsOnTaskId"));
  return c.json(dependencyResource(c, task.id, row));
});

api.put("/api/tasks/:taskId/dependencies/:dependsOnTaskId", async (c) => {
  const task = await taskRow(c, c.req.param("taskId"));
  await requireBoardCapability(c, task.board_id, "plan");
  if (task.status !== "todo")
    throw new ApiProblem(409, "task-dependencies-locked", "Task Dependencies Locked", "Dependencies cannot change after a task is assigned.");
  const dependency = await taskRow(c, c.req.param("dependsOnTaskId"));
  if (dependency.board_id !== task.board_id)
    throw new ApiProblem(422, "cross-board-dependency", "Invalid Dependency", "Dependencies must belong to the same board.");
  if (dependency.id === task.id) throw new ApiProblem(409, "dependency-cycle", "Dependency Cycle", "The dependency would create a cycle.");
  const outcome = await planning(c).addDependency(task.id, dependency.id);
  if (outcome === "locked")
    throw new ApiProblem(409, "task-dependencies-locked", "Task Dependencies Locked", "Dependencies cannot change after a task is assigned.");
  if (outcome === "cycle") throw new ApiProblem(409, "dependency-cycle", "Dependency Cycle", "The dependency would create a cycle.");
  const row = await planning(c).dependency(task.id, dependency.id);
  return c.json(dependencyResource(c, task.id, row), 201, {
    Location: canonical(c, `/api/tasks/${task.id}/dependencies/${dependency.id}`),
  });
});

api.delete("/api/tasks/:taskId/dependencies/:dependsOnTaskId", async (c) => {
  const task = await taskRow(c, c.req.param("taskId"));
  await requireBoardCapability(c, task.board_id, "plan");
  if (task.status !== "todo")
    throw new ApiProblem(409, "task-dependencies-locked", "Task Dependencies Locked", "Dependencies cannot change after a task is assigned.");
  const result = await planning(c).removeDependency(task.id, c.req.param("dependsOnTaskId"));
  if ((result.meta.changes ?? 0) === 0 && (await taskRow(c, task.id)).status !== "todo")
    throw new ApiProblem(409, "task-dependencies-locked", "Task Dependencies Locked", "Dependencies cannot change after a task is assigned.");
  return c.body(null, 204);
});

api.get("/api/boards/:boardId/labels", async (c) => {
  const board = await boardRow(c, c.req.param("boardId"));
  const page = await pageRequest(c);
  const rows = await planning(c).labels(board.id, page.cursor ?? null, page.pageSize);
  return c.json(await pageResponse(c, rows.map((row) => resource(c, row, `/api/labels/${row.id}`)) as never, page.pageSize, page.queryFingerprint));
});

api.post("/api/boards/:boardId/labels", async (c) => {
  const board = await boardRow(c, c.req.param("boardId"));
  await requireBoardCapability(c, board.id, "maintain");
  const body = await jsonObject(c);
  const name = requiredString(body, "name", 80);
  const color = requiredString(body, "color", 7);
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new ApiProblem(422, "validation", "Validation Failed", "color must be a six-digit hexadecimal color.");
  return idempotentCreate(
    c,
    body,
    "lbl",
    async (id) => {
      await executeConstraint(() => planning(c).createLabel(id, board.id, name, color));
      const row = await labelRow(c, id);
      const value = resource(c, row, `/api/labels/${id}`);
      return { status: 201, value, location: value.links.self };
    },
    (id) => recoverCreated(c, () => labelRow(c, id), `/api/labels/${id}`),
  );
});

api.get("/api/labels/:labelId", async (c) => {
  const row = await labelRow(c, c.req.param("labelId"));
  c.header("ETag", etag(row.version));
  return c.json(resource(c, row, `/api/labels/${row.id}`));
});

api.patch("/api/labels/:labelId", async (c) => {
  const row = await labelRow(c, c.req.param("labelId"));
  await requireBoardCapability(c, row.board_id, "maintain");
  requireIfMatch(c, row.version);
  const body = await jsonObject(c);
  const name = patchNonEmptyString(body, "name", row.name, 80);
  const color = optionalString(body, "color", 7) ?? row.color;
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new ApiProblem(422, "validation", "Validation Failed", "color must be a six-digit hexadecimal color.");
  const result = await executeConstraint(() => planning(c).updateLabel(row.id, row.version, name, color));
  requireChanged(result);
  const updated = await labelRow(c, row.id);
  c.header("ETag", etag(updated.version));
  return c.json(resource(c, updated, `/api/labels/${row.id}`));
});

api.delete("/api/labels/:labelId", async (c) => {
  const row = await labelRow(c, c.req.param("labelId"));
  await requireBoardCapability(c, row.board_id, "maintain");
  requireIfMatch(c, row.version);
  const result = await planning(c).deleteLabel(row.id, row.version);
  requireChanged(result);
  return c.body(null, 204);
});

api.put("/api/tasks/:taskId/labels/:labelId", async (c) => {
  const task = await taskRow(c, c.req.param("taskId"));
  await requireBoardCapability(c, task.board_id, "plan");
  const label = await labelRow(c, c.req.param("labelId"));
  if (label.board_id !== task.board_id) throw new ApiProblem(422, "cross-board-label", "Invalid Label", "The Label belongs to another board.");
  await planning(c).attachLabel(task.id, label.id);
  return c.json({ taskId: task.id, labelId: label.id, links: { self: canonical(c, `/api/tasks/${task.id}/labels/${label.id}`) } }, 201, {
    Location: canonical(c, `/api/tasks/${task.id}/labels/${label.id}`),
  });
});

api.get("/api/tasks/:taskId/labels", async (c) => {
  const task = await taskRow(c, c.req.param("taskId"));
  const page = await pageRequest(c);
  const rows = await planning(c).taskLabels(task.id, page.cursor ?? null, page.pageSize);
  return c.json(await pageResponse(c, rows.map((row) => resource(c, row, `/api/labels/${row.id}`)) as never, page.pageSize, page.queryFingerprint));
});

api.get("/api/tasks/:taskId/labels/:labelId", async (c) => {
  const task = await taskRow(c, c.req.param("taskId"));
  const label = await labelRow(c, c.req.param("labelId"));
  if (!(await planning(c).hasTaskLabel(task.id, label.id))) throw new ApiProblem(404, "not-found", "Not Found", "The task label does not exist.");
  return c.json({ taskId: task.id, labelId: label.id, links: { self: canonical(c, `/api/tasks/${task.id}/labels/${label.id}`) } });
});

api.delete("/api/tasks/:taskId/labels/:labelId", async (c) => {
  const task = await taskRow(c, c.req.param("taskId"));
  await requireBoardCapability(c, task.board_id, "plan");
  await planning(c).detachLabel(task.id, c.req.param("labelId"));
  return c.body(null, 204);
});

api.get("/api/boards/:boardId/memberships", async (c) => {
  const board = await boardRow(c, c.req.param("boardId"));
  await requireBoardCapability(c, board.id, "maintain");
  const page = await pageRequest(c);
  const rows = await access(c).memberships(board.id, page.cursor ?? null, page.pageSize);
  return c.json(
    await pageResponse(
      c,
      rows.map((row) => resource(c, row, `/api/board-memberships/${row.id}`, ["capabilities_json"])) as never,
      page.pageSize,
      page.queryFingerprint,
    ),
  );
});

api.post("/api/boards/:boardId/memberships", async (c) => {
  const board = await boardRow(c, c.req.param("boardId"));
  await requireBoardCapability(c, board.id, "maintain");
  const body = await jsonObject(c);
  const agentId = requiredString(body, "agentId", 200);
  const capabilities = capabilitiesFrom(body);
  return idempotentCreate(
    c,
    body,
    "mem",
    async (id) => {
      const principal = c.get("principal");
      const binding = await amaBindings(c).activeBinding(
        board.id,
        "The board needs an active AMA execution binding before adding Agent memberships.",
      );
      await resolveAmaAgent(c.env, principal.tenantId, binding.authorized_subject_id, binding.project_uri, agentId);
      await executeConstraint(() => access(c).createMembership(id, board.id, agentId, capabilities));
      const row = await membershipRow(c, id);
      const value = resource(c, row, `/api/board-memberships/${id}`, ["capabilities_json"]);
      return { status: 201, value, location: value.links.self };
    },
    (id) => recoverCreated(c, () => membershipRow(c, id), `/api/board-memberships/${id}`, ["capabilities_json"]),
  );
});

api.get("/api/board-memberships/:membershipId", async (c) => {
  const row = await membershipRow(c, c.req.param("membershipId"));
  c.header("ETag", etag(row.version));
  return c.json(resource(c, row, `/api/board-memberships/${row.id}`, ["capabilities_json"]));
});

api.patch("/api/board-memberships/:membershipId", async (c) => {
  const row = await membershipRow(c, c.req.param("membershipId"));
  await requireBoardCapability(c, row.board_id, "maintain");
  requireIfMatch(c, row.version);
  const body = await jsonObject(c);
  const capabilities = capabilitiesFrom(body);
  const result = await access(c).updateMembership(row.id, row.version, capabilities);
  requireChanged(result);
  const updated = await membershipRow(c, row.id);
  c.header("ETag", etag(updated.version));
  return c.json(resource(c, updated, `/api/board-memberships/${row.id}`, ["capabilities_json"]));
});

api.delete("/api/board-memberships/:membershipId", async (c) => {
  const row = await membershipRow(c, c.req.param("membershipId"));
  await requireBoardCapability(c, row.board_id, "maintain");
  requireIfMatch(c, row.version);
  const result = await access(c).deleteMembership(row.id, row.version);
  requireChanged(result);
  return c.body(null, 204);
});

api.get("/api/tasks/:taskId/assignments", async (c) => {
  const task = await taskRow(c, c.req.param("taskId"));
  const page = await pageRequest(c);
  const rows = await access(c).assignments(task.id, page.cursor ?? null, page.pageSize);
  return c.json(
    await pageResponse(c, rows.map((row) => resource(c, row, `/api/task-assignments/${row.id}`)) as never, page.pageSize, page.queryFingerprint),
  );
});

api.post("/api/tasks/:taskId/assignments", async (c) => {
  const task = await taskRow(c, c.req.param("taskId"));
  await requireBoardCapability(c, task.board_id, "assign");
  const body = await jsonObject(c);
  const agentId = requiredString(body, "agentId", 200);
  return idempotentCreate(
    c,
    body,
    "asn",
    async (id) => {
      if (task.status !== "todo") throw new ApiProblem(409, "task-not-assignable", "Task Not Assignable", "Only todo tasks can be assigned.");
      const principal = c.get("principal");
      const binding = await amaBindings(c).activeBinding(task.board_id);
      await resolveAmaAgent(c.env, principal.tenantId, binding.authorized_subject_id, binding.project_uri, agentId);
      if (!(await access(c).hasWorkMembership(task.board_id, agentId)))
        throw new ApiProblem(422, "agent-not-member", "Agent Not Eligible", "The Agent needs a BoardMembership with work capability.");
      try {
        if (!(await access(c).createAssignment(id, task.id, agentId)))
          throw new ApiProblem(409, "assignment-conflict", "Assignment Conflict", "The task already has an active assignment.");
      } catch (error) {
        if (isConstraintError(error))
          throw new ApiProblem(409, "assignment-conflict", "Assignment Conflict", "The task already has an active assignment.");
        throw error;
      }
      const row = await assignmentRow(c, id);
      const value = resource(c, row, `/api/task-assignments/${id}`);
      return { status: 201, value, location: value.links.self };
    },
    (id) => recoverCreated(c, () => assignmentRow(c, id), `/api/task-assignments/${id}`),
  );
});

api.get("/api/task-assignments/:assignmentId", async (c) => {
  const row = await assignmentRow(c, c.req.param("assignmentId"));
  c.header("ETag", etag(row.version));
  return c.json(resource(c, row, `/api/task-assignments/${row.id}`));
});

api.delete("/api/task-assignments/:assignmentId", async (c) => {
  const row = await assignmentRow(c, c.req.param("assignmentId"));
  const task = await taskRow(c, row.task_id);
  await requireBoardCapability(c, task.board_id, "assign");
  requireIfMatch(c, row.version);
  rejectAssignmentHistory(await access(c).hasAssignmentExecutionHistory(row.id));
  const result = await access(c).releaseAssignmentWithoutExecutionHistory(row.id, row.version);
  rejectAssignmentHistory(await access(c).hasAssignmentExecutionHistory(row.id));
  requireChanged(result);
  return c.body(null, 204);
});

api.get("/api/tasks/:taskId/runs", async (c) => {
  const task = await taskRow(c, c.req.param("taskId"));
  const page = await pageRequest(c);
  const rows = await execution(c).runs(task.id, page.cursor ?? null, page.pageSize);
  return c.json(
    await pageResponse(c, rows.map((row) => resource(c, row, `/api/task-runs/${row.id}`)) as never, page.pageSize, page.queryFingerprint),
  );
});

api.post("/api/tasks/:taskId/runs", async (c) => {
  const task = await taskRow(c, c.req.param("taskId"));
  await requireBoardCapability(c, task.board_id, "assign");
  const body = await jsonObject(c);
  return idempotentCreate(
    c,
    body,
    "run",
    async (id) => {
      if (task.status !== "queued")
        throw new ApiProblem(409, "task-not-runnable", "Task Not Runnable", "Only a newly queued task can create its initial TaskRun.");
      if (task.blocked) throw new ApiProblem(409, "task-blocked", "Task Blocked", "All dependency tasks must be done before creating a TaskRun.");
      const assignment = await access(c).activeAssignment(task.id);
      const binding = await amaBindings(c).activeBinding(task.board_id);
      const outboxId = newId("out");
      const taskUri = canonical(c, `/api/tasks/${task.id}`);
      const agent = await resolveAmaAgent(
        c.env,
        c.get("principal").tenantId,
        binding.authorized_subject_id,
        binding.project_uri,
        assignment.agent_id,
      );
      const repository = task.repository_id ? await repositoryRow(c, task.repository_id) : null;
      const payload = {
        authorizedSubjectId: binding.authorized_subject_id,
        projectUri: binding.project_uri,
        idempotencyKey: `ak:task-run:${id}`,
        traceparent: c.get("traceparent"),
        tracestate: c.get("tracestate"),
        request: amaSessionRequest(agent, repository, taskUri, task.description || task.title),
      };
      try {
        if (!(await execution(c).createInitialRun({ id, taskId: task.id, assignmentId: assignment.id, outboxId, payload: JSON.stringify(payload) })))
          throw new ApiProblem(409, "task-run-conflict", "TaskRun Conflict", "The task already has an initial TaskRun.");
      } catch (error) {
        if (isConstraintError(error)) throw new ApiProblem(409, "task-run-conflict", "TaskRun Conflict", "The task already has an active TaskRun.");
        throw error;
      }
      const row = await runRow(c, id);
      const value = resource(c, row, `/api/task-runs/${id}`);
      return { status: 201, value, location: value.links.self };
    },
    (id) => recoverCreated(c, () => runRow(c, id), `/api/task-runs/${id}`),
  );
});

api.get("/api/task-runs/:runId", async (c) => {
  const row = await runRow(c, c.req.param("runId"));
  c.header("ETag", etag(row.version));
  return c.json(resource(c, row, `/api/task-runs/${row.id}`));
});

api.get("/api/task-runs/:runId/progress-entries", async (c) => {
  const run = await runRow(c, c.req.param("runId"));
  const page = await pageRequest(c);
  const rows = await execution(c).progressEntries(run.id, page.cursor ?? null, page.pageSize);
  return c.json(
    await pageResponse(c, rows.map((row) => resource(c, row, `/api/task-progress-entries/${row.id}`)) as never, page.pageSize, page.queryFingerprint),
  );
});

api.post("/api/task-runs/:runId/progress-entries", async (c) => {
  const run = await runRow(c, c.req.param("runId"));
  const task = await taskRow(c, run.task_id);
  await requireBoardCapability(c, task.board_id, "work");
  await requireAssignedActor(c, task.id);
  const body = await jsonObject(c);
  const kind = requiredString(body, "kind", 32);
  if (!["note", "checkpoint", "blocked", "unblocked"].includes(kind))
    throw new ApiProblem(422, "validation", "Validation Failed", "kind is not supported.");
  const text = requiredString(body, "body", 16384);
  return idempotentCreate(
    c,
    body,
    "prg",
    async (id) => {
      if (!(await execution(c).addProgress({ id, runId: run.id, taskId: task.id, kind, body: text })))
        throw new ApiProblem(409, "run-not-active", "TaskRun Not Active", "Progress can only be added to the active TaskRun.");
      const row = await execution(c).progress(id);
      const value = resource(c, row, `/api/task-progress-entries/${id}`);
      return { status: 201, value, location: value.links.self };
    },
    (id) => recoverCreated(c, () => execution(c).progress(id), `/api/task-progress-entries/${id}`),
  );
});

api.get("/api/task-progress-entries/:entryId", async (c) => {
  const row = await execution(c).progress(c.req.param("entryId"));
  return c.json(resource(c, row, `/api/task-progress-entries/${row.id}`));
});

api.get("/api/tasks/:taskId/messages", async (c) => {
  const task = await taskRow(c, c.req.param("taskId"));
  const page = await pageRequest(c);
  const rows = await execution(c).messages(task.id, page.cursor ?? null, page.pageSize);
  return c.json(
    await pageResponse(c, rows.map((row) => resource(c, row, `/api/task-messages/${row.id}`)) as never, page.pageSize, page.queryFingerprint),
  );
});

api.post("/api/tasks/:taskId/messages", async (c) => {
  const task = await taskRow(c, c.req.param("taskId"));
  await requireBoardCapability(c, task.board_id, "work");
  const principal = c.get("principal");
  if (principal.type === "agent") await requireAssignedActor(c, task.id);
  const body = await jsonObject(c);
  const text = requiredString(body, "body", 16384);
  return idempotentCreate(
    c,
    body,
    "msg",
    async (id) => {
      const run = await execution(c).activeSession(task.id, task.board_id);
      if (!run?.ama_session_uri) throw new ApiProblem(409, "active-run-required", "Active Run Required", "Messages require an active AMA Session.");
      const outboxId = newId("out");
      if (
        !(await execution(c).createMessage({
          id,
          taskId: task.id,
          runId: run.id,
          senderIssuer: principal.actor?.issuer ?? null,
          senderSubject: principal.actor?.subject ?? principal.subjectId,
          body: text,
          outboxId,
          payload: JSON.stringify({
            authorizedSubjectId: run.authorized_subject_id,
            projectUri: run.project_uri,
            idempotencyKey: `ak:task-message:${id}`,
            traceparent: c.get("traceparent"),
            tracestate: c.get("tracestate"),
            request: { session: run.ama_session_uri, body: text },
          }),
        }))
      )
        throw new ApiProblem(409, "active-run-required", "Active Run Required", "Messages require an active AMA Session.");
      const row = await execution(c).message(id);
      const value = resource(c, row, `/api/task-messages/${id}`);
      return { status: 201, value, location: value.links.self };
    },
    (id) => recoverCreated(c, () => execution(c).message(id), `/api/task-messages/${id}`),
  );
});

api.get("/api/task-messages/:messageId", async (c) => {
  const row = await execution(c).message(c.req.param("messageId"));
  return c.json(resource(c, row, `/api/task-messages/${row.id}`));
});

api.get("/api/tasks/:taskId/submissions", async (c) => {
  const task = await taskRow(c, c.req.param("taskId"));
  const page = await pageRequest(c);
  const rows = await execution(c).submissions(task.id, page.cursor ?? null, page.pageSize);
  return c.json(
    await pageResponse(
      c,
      rows.map((row) => resource(c, row, `/api/task-submissions/${row.id}`, ["artifact_urls_json"])) as never,
      page.pageSize,
      page.queryFingerprint,
    ),
  );
});

api.post("/api/tasks/:taskId/submissions", async (c) => {
  const task = await taskRow(c, c.req.param("taskId"));
  await requireBoardCapability(c, task.board_id, "work");
  await requireAssignedActor(c, task.id);
  const body = await jsonObject(c);
  const summary = requiredString(body, "summary", 16384);
  const artifactUrls = urlArray(body.artifactUrls);
  const runId = requiredString(body, "runId", 80);
  const run = await runRow(c, runId);
  if (run.task_id !== task.id) throw new ApiProblem(422, "run-task-mismatch", "Invalid Run", "The TaskRun belongs to another task.");
  return idempotentCreate(
    c,
    body,
    "sub",
    async (id) => {
      if (task.status !== "in_progress" || (run.status !== "pending" && run.status !== "running"))
        throw new ApiProblem(409, "task-not-submittable", "Task Not Submittable", "The task is not being worked.");
      if (!(await execution(c).createSubmission({ id, taskId: task.id, runId: run.id, summary, artifactUrls })))
        throw new ApiProblem(409, "task-not-submittable", "Task Not Submittable", "The task or TaskRun is no longer active.");
      const row = await submissionRow(c, id);
      const value = resource(c, row, `/api/task-submissions/${id}`, ["artifact_urls_json"]);
      return { status: 201, value, location: value.links.self };
    },
    (id) => recoverCreated(c, () => submissionRow(c, id), `/api/task-submissions/${id}`, ["artifact_urls_json"]),
  );
});

api.get("/api/task-submissions/:submissionId", async (c) => {
  const row = await submissionRow(c, c.req.param("submissionId"));
  return c.json(resource(c, row, `/api/task-submissions/${row.id}`, ["artifact_urls_json"]));
});

api.get("/api/task-submissions/:submissionId/reviews", async (c) => {
  const submission = await submissionRow(c, c.req.param("submissionId"));
  const page = await pageRequest(c);
  const rows = await execution(c).reviews(submission.id, page.cursor ?? null, page.pageSize);
  return c.json(
    await pageResponse(c, rows.map((row) => resource(c, row, `/api/task-reviews/${row.id}`)) as never, page.pageSize, page.queryFingerprint),
  );
});

api.post("/api/task-submissions/:submissionId/reviews", async (c) => {
  const submission = await submissionRow(c, c.req.param("submissionId"));
  const task = await taskRow(c, submission.task_id);
  await requireBoardCapability(c, task.board_id, "review");
  const body = await jsonObject(c);
  const decision = requiredString(body, "decision", 16);
  if (decision !== "accepted" && decision !== "rejected")
    throw new ApiProblem(422, "validation", "Validation Failed", "decision must be accepted or rejected.");
  const text = optionalString(body, "body", 16384) ?? "";
  return idempotentCreate(
    c,
    body,
    "rev",
    async (id) => {
      if (submission.status !== "pending_review")
        throw new ApiProblem(409, "submission-reviewed", "Submission Already Reviewed", "The submission already has a terminal review.");
      const principal = c.get("principal");
      let continuation:
        | { kind: "feedback"; runId: string; outboxId: string; payload: string }
        | { kind: "replacement"; runId: string; assignmentId: string; outboxId: string; payload: string }
        | undefined;
      if (decision === "rejected") {
        let active = await execution(c).activeSession(task.id, task.board_id, ["running", "succeeded"]);
        if (active?.ama_session_uri) {
          let phase: string | undefined;
          try {
            phase = await readAmaSession(c.env, principal.tenantId, active.authorized_subject_id, active.project_uri, active.ama_session_uri);
          } catch (error) {
            if (error instanceof AmaSessionTerminalError) active = null;
            else
              throw new ApiProblem(
                502,
                "ama-unavailable",
                "AMA Unavailable",
                "AMA Session state could not be verified before rejecting the submission.",
              );
          }
          if (phase === "closed" || phase === "error") active = null;
        }
        const assignment = await access(c).activeAssignment(task.id);
        const prompt = `Continue ${canonical(c, `/api/tasks/${task.id}`)} after review rejection:\n${text || "Submission rejected."}`;
        const taskUri = canonical(c, `/api/tasks/${task.id}`);
        const repository = task.repository_id ? await repositoryRow(c, task.repository_id) : null;
        if (active?.ama_session_uri) {
          continuation = {
            kind: "feedback",
            runId: active.id,
            outboxId: newId("out"),
            payload: JSON.stringify({
              authorizedSubjectId: active.authorized_subject_id,
              projectUri: active.project_uri,
              idempotencyKey: `ak:task-review:${id}`,
              traceparent: c.get("traceparent"),
              tracestate: c.get("tracestate"),
              request: { session: active.ama_session_uri, body: text || "Submission rejected." },
              fallback: {
                assignmentId: assignment.id,
                previousRunId: active.id,
                agentId: assignment.agent_id,
                prompt,
                task: taskUri,
                repositoryId: repository?.id ?? null,
              },
            }),
          };
        } else {
          const binding = await amaBindings(c).activeBinding(task.board_id);
          const agent = await resolveAmaAgent(c.env, principal.tenantId, binding.authorized_subject_id, binding.project_uri, assignment.agent_id);
          const newRunId = newId("run");
          continuation = {
            kind: "replacement",
            runId: newRunId,
            assignmentId: assignment.id,
            outboxId: newId("out"),
            payload: JSON.stringify({
              authorizedSubjectId: binding.authorized_subject_id,
              projectUri: binding.project_uri,
              idempotencyKey: `ak:task-run:${newRunId}`,
              traceparent: c.get("traceparent"),
              tracestate: c.get("tracestate"),
              request: amaSessionRequest(agent, repository, taskUri, prompt),
            }),
          };
        }
      }
      if (
        !(await execution(c).applyReview({
          id,
          taskId: task.id,
          submissionId: submission.id,
          reviewerIssuer: principal.actor?.issuer ?? null,
          reviewerSubject: principal.actor?.subject ?? principal.subjectId,
          decision,
          body: text,
          continuation,
        }))
      )
        throw new ApiProblem(409, "submission-reviewed", "Submission Already Reviewed", "The submission already has a terminal review.");
      const row = await execution(c).review(id);
      const value = resource(c, row, `/api/task-reviews/${id}`);
      return { status: 201, value, location: value.links.self };
    },
    (id) => recoverCreated(c, () => execution(c).review(id), `/api/task-reviews/${id}`),
  );
});

api.get("/api/task-reviews/:reviewId", async (c) => {
  const row = await execution(c).review(c.req.param("reviewId"));
  return c.json(resource(c, row, `/api/task-reviews/${row.id}`));
});

api.get("/api/ama-connections", async (c) => {
  const page = await pageRequest(c);
  const rows = await amaBindings(c).connections(page.cursor ?? null, page.pageSize);
  return c.json(
    await pageResponse(c, rows.map((row) => resource(c, row, `/api/ama-connections/${row.id}`)) as never, page.pageSize, page.queryFingerprint),
  );
});

api.post("/api/ama-connections", async (c) => {
  const body = await jsonObject(c);
  const resourceUrlValue = validUrl(requiredString(body, "resourceUrl", 2048));
  const projectUri = validUrl(requiredString(body, "projectUri", 2048));
  const amaOrigin = new URL(c.env.AMA_ORIGIN).origin;
  if (new URL(resourceUrlValue).origin !== amaOrigin || new URL(projectUri).origin !== amaOrigin)
    throw new ApiProblem(422, "ama-origin-mismatch", "Invalid AMA Connection", "AMA Resource and Project URLs must use the configured AMA origin.");
  return idempotentCreate(
    c,
    body,
    "ama",
    async (id) => {
      const principal = c.get("principal");
      await ensureTenant(c);
      await validateAmaConnection(c.env, principal.tenantId, principal.subjectId, resourceUrlValue, projectUri);
      await executeConstraint(() => amaBindings(c).createConnection(id, resourceUrlValue, projectUri, principal.subjectId));
      const row = await amaConnectionRow(c, id);
      const value = resource(c, row, `/api/ama-connections/${id}`);
      return { status: 201, value, location: value.links.self };
    },
    (id) => recoverCreated(c, () => amaConnectionRow(c, id), `/api/ama-connections/${id}`),
  );
});

api.get("/api/ama-connections/:connectionId", async (c) => {
  const row = await amaConnectionRow(c, c.req.param("connectionId"));
  c.header("ETag", etag(row.version));
  return c.json(resource(c, row, `/api/ama-connections/${row.id}`));
});

api.patch("/api/ama-connections/:connectionId", async (c) => {
  const row = await amaConnectionRow(c, c.req.param("connectionId"));
  requireIfMatch(c, row.version);
  const body = await jsonObject(c);
  const status = requiredString(body, "status", 16);
  if (status !== "active" && status !== "disabled")
    throw new ApiProblem(422, "validation", "Validation Failed", "status must be active or disabled.");
  const result = await amaBindings(c).updateConnectionStatus(row.id, row.version, status);
  requireChanged(result);
  const updated = await amaConnectionRow(c, row.id);
  c.header("ETag", etag(updated.version));
  return c.json(resource(c, updated, `/api/ama-connections/${row.id}`));
});

api.delete("/api/ama-connections/:connectionId", async (c) => {
  const row = await amaConnectionRow(c, c.req.param("connectionId"));
  requireIfMatch(c, row.version);
  rejectConnectionInUse(await amaBindings(c).connectionInUse(row.id));
  const result = await amaBindings(c).deleteUnusedConnection(row.id, row.version);
  rejectConnectionInUse(await amaBindings(c).connectionInUse(row.id));
  requireChanged(result);
  await revokeReleasedAmaGrant(c.env, await releaseAmaGrantIfUnused(c.env, c.get("principal").tenantId, row.authorized_subject_id));
  return c.body(null, 204);
});

api.put("/api/boards/:boardId/execution-binding", async (c) => {
  const board = await boardRow(c, c.req.param("boardId"));
  await requireBoardCapability(c, board.id, "maintain");
  const body = await jsonObject(c);
  const connectionId = requiredString(body, "amaConnectionId", 80);
  await amaConnectionRow(c, connectionId);
  const id = `bnd_${board.id}`;
  const existing = await amaBindings(c).existingBinding(board.id);
  const created = !existing;
  if (existing) {
    if (typeof existing.version !== "number")
      throw new ApiProblem(500, "invalid-resource-version", "Invalid Resource Version", "The binding has no version.");
    const currentVersion = existing.version;
    requireIfMatch(c, currentVersion);
    rejectBindingHistory(await amaBindings(c).hasBoardExecutionHistory(board.id));
    const result = await amaBindings(c).replaceBindingWithoutHistory(board.id, connectionId, currentVersion);
    rejectBindingHistory(await amaBindings(c).hasBoardExecutionHistory(board.id));
    requireChanged(result);
  } else {
    await executeConstraint(() => amaBindings(c).createBinding(id, board.id, connectionId));
  }
  const row = await bindingRow(c, board.id);
  c.header("ETag", etag(row.version));
  const value = resource(c, row, `/api/boards/${board.id}/execution-binding`);
  return created ? c.json(value, 201, { Location: value.links.self }) : c.json(value, 200);
});

api.get("/api/boards/:boardId/execution-binding", async (c) => {
  const board = await boardRow(c, c.req.param("boardId"));
  const row = await bindingRow(c, board.id);
  c.header("ETag", etag(row.version));
  return c.json(resource(c, row, `/api/boards/${board.id}/execution-binding`));
});

api.delete("/api/boards/:boardId/execution-binding", async (c) => {
  const board = await boardRow(c, c.req.param("boardId"));
  await requireBoardCapability(c, board.id, "maintain");
  const row = await bindingRow(c, board.id);
  requireIfMatch(c, row.version);
  rejectBindingHistory(await amaBindings(c).hasBoardExecutionHistory(board.id));
  const result = await amaBindings(c).deleteBindingWithoutHistory(board.id, row.version);
  rejectBindingHistory(await amaBindings(c).hasBoardExecutionHistory(board.id));
  requireChanged(result);
  return c.body(null, 204);
});

api.notFound((c) => {
  throw new ApiProblem(404, "not-found", "Not Found", "The requested resource does not exist.");
});

function protectedResourceMetadata(c: Parameters<typeof resourceUrl>[0] extends never ? never : any) {
  return c.json({
    resource: resourceUrl(c.env, c.req.url),
    authorization_servers: [c.env.REALMROOT_ISSUER.replace(/\/$/, "")],
    bearer_methods_supported: ["header"],
    scopes_supported: [
      "boards:read",
      "boards:write",
      "repositories:read",
      "repositories:write",
      "tasks:read",
      "tasks:write",
      "memberships:read",
      "memberships:write",
      "execution:read",
      "execution:write",
      "work:read",
      "work:write",
      "reviews:read",
      "reviews:write",
    ],
    resource_documentation: canonical(c, "/api/openapi.json"),
  });
}

async function ensureTenant(c: any): Promise<void> {
  await planning(c).ensureTenant();
}

function resource(c: any, row: Row, path: string, jsonFields: string[] = []): any {
  const value = publicRow(row, jsonFields);
  delete value.authorizedSubjectId;
  return { ...value, links: { self: canonical(c, path) } };
}

function taskResource(c: any, row: Row): any {
  return {
    ...publicRow(row),
    links: {
      self: canonical(c, `/api/tasks/${row.id}`),
      board: canonical(c, `/api/boards/${row.board_id}`),
      ...(row.repository_id ? { repository: canonical(c, `/api/repositories/${row.repository_id}`) } : {}),
    },
  };
}

async function textDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function taskCollectionResources(c: any, rows: Row[]): Promise<any[]> {
  if (rows.length === 0) return [];
  const taskIds = rows.map((row) => row.id);
  const [labelRows, assignmentRows] = await Promise.all([planning(c).labelsForTasks(taskIds), access(c).activeAssignmentsForTasks(taskIds)]);
  const labels = new Map<string, Array<{ id: string; name: string; color: string }>>();
  for (const value of labelRows) {
    const taskLabels = labels.get(value.task_id) ?? [];
    taskLabels.push({ id: value.id, name: value.name, color: value.color });
    labels.set(value.task_id, taskLabels);
  }
  const assignments = new Map(assignmentRows.map((value) => [String(value.task_id), publicRow(value)]));
  return rows.map((row) => ({ ...taskResource(c, row), labels: labels.get(row.id) ?? [], assignment: assignments.get(row.id) ?? null }));
}

async function recoverCreated(
  c: any,
  read: () => Promise<Row>,
  path: string,
  jsonFields: string[] = [],
  render: (row: Row) => any = (row) => resource(c, row, path, jsonFields),
): Promise<{ status: number; value: any; location: string } | null> {
  try {
    const value = render(await read());
    return { status: 201, value, location: value.links.self };
  } catch (error) {
    if (error instanceof ApiProblem && error.status === 404) return null;
    throw error;
  }
}

function dependencyResource(c: any, taskId: string, row: Row): any {
  return {
    ...publicRow(row),
    links: {
      self: canonical(c, `/api/tasks/${taskId}/dependencies/${row.depends_on_task_id}`),
      task: canonical(c, `/api/tasks/${taskId}`),
      dependsOnTask: canonical(c, `/api/tasks/${row.depends_on_task_id}`),
    },
  };
}

async function boardRow(c: any, id: string): Promise<any> {
  return planning(c).board(id);
}
async function repositoryRow(c: any, id: string): Promise<any> {
  return planning(c).repository(id);
}
async function taskRow(c: any, id: string): Promise<any> {
  return planning(c).task(id);
}
async function labelRow(c: any, id: string): Promise<any> {
  return planning(c).label(id);
}
async function membershipRow(c: any, id: string): Promise<any> {
  return access(c).membership(id);
}
async function assignmentRow(c: any, id: string): Promise<any> {
  return access(c).assignment(id);
}
async function runRow(c: any, id: string): Promise<any> {
  return execution(c).run(id);
}
async function submissionRow(c: any, id: string): Promise<any> {
  return execution(c).submission(id);
}
async function amaConnectionRow(c: any, id: string): Promise<any> {
  return amaBindings(c).connection(id);
}
async function bindingRow(c: any, boardId: string): Promise<any> {
  return amaBindings(c).binding(boardId);
}

function planning(c: any): PlanningRepo {
  return new PlanningRepo(c.env.DB, c.get("principal").tenantId);
}

function access(c: any): AccessRepo {
  return new AccessRepo(c.env.DB, c.get("principal").tenantId);
}

function execution(c: any): ExecutionRepo {
  return new ExecutionRepo(c.env.DB, c.get("principal").tenantId);
}

function amaBindings(c: any): AmaBindingRepo {
  return new AmaBindingRepo(c.env.DB, c.get("principal").tenantId);
}

type AmaPage = { data?: Array<Record<string, any>>; pagination?: { hasMore?: boolean; nextCursor?: string | null; [key: string]: unknown } };

async function amaProjects(c: Context<any>): Promise<Response> {
  const principal = c.get("principal");
  const items: Array<Record<string, any>> = [];
  const target = new URL("/api/v1/projects?limit=100", "http://ama.invalid");
  const cursors = new Set<string>();
  let complete = false;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const body = (await amaBody(
      await fetchAmaConsole(c.env, principal.tenantId, principal.subjectId, `${target.pathname}${target.search}`),
    )) as AmaPage;
    if (!body || !Array.isArray(body.data))
      throw new ApiProblem(502, "ama-invalid-response", "AMA Contract Mismatch", "AMA returned an invalid Project collection.");
    if (body.data.some((project) => typeof project.id !== "string" || typeof project.name !== "string"))
      throw new ApiProblem(502, "ama-invalid-response", "AMA Contract Mismatch", "AMA returned an invalid Project representation.");
    items.push(...body.data);
    if (!body.pagination?.hasMore) {
      complete = true;
      break;
    }
    const cursor = body.pagination.nextCursor;
    if (typeof cursor !== "string" || !cursor || cursors.has(cursor))
      throw new ApiProblem(502, "ama-invalid-response", "AMA Contract Mismatch", "AMA returned invalid Project pagination metadata.");
    cursors.add(cursor);
    target.searchParams.set("cursor", cursor);
  }
  if (!complete) throw new ApiProblem(502, "ama-invalid-response", "AMA Contract Mismatch", "AMA Project pagination exceeded the safety limit.");
  return c.json({
    items: items.map((project) => ({
      ...project,
      uri: new URL(`/api/v1/projects/${encodeURIComponent(String(project.id))}`, c.env.AMA_ORIGIN).toString(),
      resourceUrl: c.env.AMA_RESOURCE,
    })),
    pagination: { pageSize: items.length },
  });
}

async function amaProject(c: Context<any>, connectionId: string): Promise<{ id: string; name: string }> {
  let connection: any;
  try {
    connection = await amaConnectionRow(c, connectionId);
  } catch (error) {
    if (error instanceof ApiProblem && error.status === 404)
      throw new ApiProblem(404, "ama-connection-required", "AMA Connection Required", "Connect an AMA Project before using this product surface.");
    throw error;
  }
  const target = new URL(connection.project_uri);
  if (target.origin !== new URL(c.env.AMA_ORIGIN).origin)
    throw new ApiProblem(502, "ama-contract-invalid", "AMA Contract Invalid", "The saved AMA Project origin is invalid.");
  const match = target.pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
  if (!match || target.search || target.hash)
    throw new ApiProblem(502, "ama-contract-invalid", "AMA Contract Invalid", "The saved AMA Project URI is invalid.");
  return { id: decodeURIComponent(match[1]), name: connection.project_uri };
}

async function amaRequest(c: Context<any>, connectionId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const principal = c.get("principal");
  const project = await amaProject(c, connectionId);
  const headers = new Headers(init.headers);
  headers.set("X-AMA-Project-ID", project.id);
  try {
    return await fetchAmaConsole(c.env, principal.tenantId, principal.subjectId, path, { ...init, headers });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError")
      throw new ApiProblem(503, "ama-unavailable", "AMA Unavailable", "AMA did not respond before the request deadline.");
    throw error;
  }
}

async function amaBody(response: Response): Promise<unknown> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    if (response.status === 401)
      throw new ApiProblem(401, "ama-grant-required", "AMA Authorization Required", "The AMA authorization is missing or expired.");
    if (response.status >= 500)
      throw new ApiProblem(503, "ama-unavailable", "AMA Unavailable", `AMA returned HTTP ${response.status} without a readable problem response.`);
    throw new ApiProblem(502, "ama-invalid-response", "AMA Contract Mismatch", "AMA returned a response that is not valid JSON.");
  }
  if (!response.ok) {
    const problem = body as { error?: { message?: string }; detail?: string } | null;
    if (response.status === 401)
      throw new ApiProblem(
        401,
        "ama-grant-required",
        "AMA Authorization Required",
        problem?.detail ?? "The AMA authorization is missing or expired.",
      );
    if (response.status === 403)
      throw new ApiProblem(403, "ama-forbidden", "AMA Access Denied", problem?.detail ?? "This account cannot access the requested AMA resources.");
    if (response.status >= 500)
      throw new ApiProblem(503, "ama-unavailable", "AMA Unavailable", problem?.detail ?? `AMA returned HTTP ${response.status}.`);
    if (response.status === 400 || response.status === 422)
      throw new ApiProblem(
        response.status,
        "ama-validation",
        "AMA Validation Failed",
        problem?.error?.message ?? problem?.detail ?? "AMA rejected the request.",
      );
    if (response.status === 429)
      throw new ApiProblem(429, "ama-rate-limited", "AMA Rate Limited", problem?.detail ?? "AMA rate limited the request.");
    throw new ApiProblem(
      response.status === 404 ? 404 : response.status === 409 ? 409 : response.status === 422 ? 422 : 502,
      "ama-request-failed",
      "AMA Request Failed",
      problem?.error?.message ?? problem?.detail ?? `AMA returned HTTP ${response.status}.`,
    );
  }
  return body;
}

async function amaCollection(c: Context<any>, connectionId: string, path: string): Promise<Response> {
  const project = await amaProject(c, connectionId);
  const items = await amaAll(c, connectionId, path);
  return c.json({ items, project, pagination: { pageSize: items.length } });
}

async function amaAll(c: Context<any>, connectionId: string, path: string): Promise<Array<Record<string, any>>> {
  const target = new URL(path, "http://ama.invalid");
  const items: Array<Record<string, any>> = [];
  const cursors = new Set<string>();
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const requestPath = `${target.pathname}${target.search}`;
    const body = (await amaBody(await amaRequest(c, connectionId, requestPath))) as AmaPage;
    if (!body || !Array.isArray(body.data))
      throw new ApiProblem(502, "ama-invalid-response", "AMA Contract Mismatch", "AMA returned an invalid collection representation.");
    if (target.pathname === "/api/v1/agents") for (const item of body.data) validateAmaAgent(item);
    if (target.pathname === "/api/v1/sessions") for (const item of body.data) validateAmaSession(item);
    if (target.pathname === "/api/v1/environments") for (const item of body.data) validateAmaEnvironment(item);
    if (target.pathname === "/api/v1/runners") for (const item of body.data) validateAmaRunner(item);
    items.push(...body.data);
    if (!body.pagination?.hasMore) return items;
    const cursor = body.pagination.nextCursor;
    if (typeof cursor !== "string" || !cursor || cursors.has(cursor))
      throw new ApiProblem(502, "ama-invalid-response", "AMA Contract Mismatch", "AMA returned invalid cursor pagination metadata.");
    cursors.add(cursor);
    target.searchParams.set("cursor", cursor);
  }
  throw new ApiProblem(502, "ama-invalid-response", "AMA Contract Mismatch", "AMA collection pagination exceeded the safety limit.");
}

async function amaResourceResponse(c: Context<any>, connectionId: string, path: string): Promise<Response> {
  const value = await amaBody(await amaRequest(c, connectionId, path));
  validateAmaValue(path, value);
  return c.json(value as never);
}

async function amaMutation(
  c: Context<any>,
  connectionId: string,
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: Record<string, unknown>,
): Promise<Response> {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  const idempotencyKey = c.req.header("Idempotency-Key");
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  if ((method === "POST" && path === "/api/v1/agents") || (method === "DELETE" && /^\/api\/v1\/agents\/[^/]+$/.test(path))) {
    const principal = c.get("principal");
    headers.set("X-AMA-Realmroot-Authorization", `Bearer ${await realmrootManagementBearerToken(c.env, principal.tenantId, principal.subjectId)}`);
  }
  const response = await amaRequest(c, connectionId, path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (method === "POST" && path === "/api/v1/agents" && response.ok && response.status !== 201)
    throw new ApiProblem(502, "ama-invalid-response", "AMA Contract Mismatch", "AMA Agent creation did not return HTTP 201.");
  const retryAfter = response.headers.get("Retry-After");
  const location = response.headers.get("Location");
  if (retryAfter) c.header("Retry-After", retryAfter);
  if (location) c.header("Location", location);
  const value = await amaBody(response);
  if (value !== null) {
    if (method === "POST" && path === "/api/v1/agents") validateAmaAgent(value as Record<string, any>);
    else if (method === "POST" && path === "/api/v1/environments") validateAmaEnvironment(value);
    else if (method === "PATCH" && /^\/api\/v1\/agents\/[^/]+$/.test(path)) validateAmaAgent(value as Record<string, any>);
  }
  return value === null
    ? new Response(null, { status: response.status })
    : new Response(JSON.stringify(value), { status: response.status, headers: { "content-type": "application/json" } });
}

async function amaMachines(c: Context<any>, connectionId: string): Promise<Array<Record<string, unknown>>> {
  const [environmentResult, runnerResult, sessionResult, agentResult] = await Promise.allSettled([
    amaAll(c, connectionId, "/api/v1/environments?limit=100"),
    amaAll(c, connectionId, "/api/v1/runners?limit=100"),
    amaAll(c, connectionId, "/api/v1/sessions?limit=100"),
    amaAll(c, connectionId, "/api/v1/agents?limit=100"),
  ]);
  if (environmentResult.status === "rejected") throw environmentResult.reason;
  const environments = environmentResult.value;
  const runners = runnerResult.status === "fulfilled" ? runnerResult.value : [];
  const sessions = sessionResult.status === "fulfilled" ? sessionResult.value : [];
  const agents = agentResult.status === "fulfilled" ? agentResult.value : [];
  for (const environment of environments) {
    if (typeof environment.metadata?.uid !== "string" || typeof environment.metadata?.name !== "string" || typeof environment.spec?.type !== "string")
      throw new ApiProblem(502, "ama-invalid-response", "AMA Contract Mismatch", "AMA returned an invalid Environment representation.");
  }
  for (const runner of runners) {
    validateAmaRunner(runner);
  }
  for (const session of sessions) {
    validateAmaSession(session);
  }
  const warnings = [
    ...(runnerResult.status === "rejected" ? ["AMA Runners are temporarily unavailable."] : []),
    ...(sessionResult.status === "rejected" ? ["AMA Sessions are temporarily unavailable."] : []),
    ...(agentResult.status === "rejected" ? ["AMA Agents are temporarily unavailable."] : []),
  ];
  const machine = (environment: Record<string, any> | null, attached: Array<Record<string, any>>) => {
    const id = environment?.metadata?.uid ?? `runner-${attached[0].id}`;
    const relatedSessions = sessions.filter((session) => session.spec?.environmentId === environment?.metadata?.uid);
    const heartbeats = attached
      .map((runner) => runner.lastHeartbeatAt)
      .filter((value): value is string => typeof value === "string")
      .sort();
    return {
      id,
      name: environment?.metadata?.name ?? attached[0]?.name ?? "Unbound runner",
      description: environment?.metadata?.description ?? null,
      type: environment?.spec?.type ?? "self_hosted",
      phase: environment?.status?.phase ?? "active",
      status: attached.some((runner) => runner.state === "active") ? "online" : "offline",
      lastHeartbeatAt: heartbeats.at(-1) ?? null,
      sessionCount: relatedSessions.length,
      activeSessionCount: relatedSessions.filter((session) => ["pending", "running", "idle"].includes(session.status?.phase)).length,
      runtimes: attached.flatMap((runner) => runner.runtimes ?? []),
      runners: attached,
      sessions: relatedSessions,
      agents: agents.filter((agent) => relatedSessions.some((session) => session.spec?.agentId === agent.metadata?.uid)),
      warnings,
      environment,
    };
  };
  const result = environments.map((environment) =>
    machine(
      environment,
      runners.filter((runner) => runner.environmentId === environment.metadata?.uid),
    ),
  );
  for (const runner of runners.filter((item) => !item.environmentId)) result.push(machine(null, [runner]));
  return result;
}

function validateAmaValue(path: string, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiProblem(502, "ama-invalid-response", "AMA Contract Mismatch", "AMA returned an invalid resource representation.");
  const resource = value as Record<string, any>;
  if (/^\/api\/v1\/agents\/[^/]+$/.test(path)) validateAmaAgent(resource);
}

function validateAmaEnvironment(value: unknown): void {
  const environment = value as Record<string, any> | null;
  if (
    !environment ||
    typeof environment.metadata?.uid !== "string" ||
    typeof environment.metadata?.name !== "string" ||
    !(environment.metadata.description === null || typeof environment.metadata.description === "string") ||
    !["cloud", "self_hosted"].includes(environment.spec?.type) ||
    typeof environment.status?.phase !== "string"
  )
    throw new ApiProblem(502, "ama-invalid-response", "AMA Contract Mismatch", "AMA returned an invalid Environment representation.");
}

function validateAmaSession(value: unknown): void {
  const session = value as Record<string, any> | null;
  if (
    !session ||
    typeof session.metadata?.uid !== "string" ||
    typeof session.metadata?.name !== "string" ||
    typeof session.spec?.agentId !== "string" ||
    typeof session.status?.phase !== "string"
  )
    throw new ApiProblem(502, "ama-invalid-response", "AMA Contract Mismatch", "AMA returned an invalid Session representation.");
}

function validateAmaAgent(agent: Record<string, any>): void {
  if (
    typeof agent.metadata?.uid !== "string" ||
    typeof agent.metadata?.name !== "string" ||
    !(agent.metadata.description === null || typeof agent.metadata.description === "string") ||
    typeof agent.identity?.issuer !== "string" ||
    typeof agent.identity?.subject !== "string" ||
    typeof agent.identity?.username !== "string" ||
    typeof agent.spec?.runtime !== "string" ||
    typeof agent.spec?.systemPrompt !== "string" ||
    !(agent.spec.provider === null || typeof agent.spec.provider === "string") ||
    !(agent.spec.model === null || typeof agent.spec.model === "string") ||
    !isStringArray(agent.spec.skills) ||
    !isStringArray(agent.spec.allowedTools) ||
    typeof agent.status?.ready !== "boolean" ||
    typeof agent.status?.phase !== "string" ||
    typeof agent.status?.version !== "number"
  )
    throw new ApiProblem(502, "ama-invalid-response", "AMA Contract Mismatch", "AMA returned an invalid Agent representation.");
}

function validateAmaRunner(runner: Record<string, any>): void {
  const validRuntimes =
    Array.isArray(runner.runtimes) &&
    runner.runtimes.every(
      (runtime: Record<string, any>) =>
        runtime &&
        typeof runtime === "object" &&
        typeof runtime.runtime === "string" &&
        isStringArray(runtime.models) &&
        typeof runtime.state === "string" &&
        (runtime.version === undefined || typeof runtime.version === "string") &&
        (runtime.detail === undefined || typeof runtime.detail === "string"),
    );
  if (
    !runner ||
    typeof runner.id !== "string" ||
    typeof runner.name !== "string" ||
    typeof runner.state !== "string" ||
    typeof runner.currentLoad !== "number" ||
    typeof runner.maxConcurrent !== "number" ||
    !(runner.environmentId == null || typeof runner.environmentId === "string") ||
    !(runner.lastHeartbeatAt == null || typeof runner.lastHeartbeatAt === "string") ||
    !validRuntimes
  )
    throw new ApiProblem(502, "ama-invalid-response", "AMA Contract Mismatch", "AMA returned an invalid Runner representation.");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function capabilitiesFrom(body: Record<string, unknown>): string[] {
  if (
    !Array.isArray(body.capabilities) ||
    body.capabilities.length === 0 ||
    body.capabilities.some((item) => typeof item !== "string" || !CAPABILITIES.has(item))
  )
    throw new ApiProblem(422, "validation", "Validation Failed", "capabilities must contain plan, assign, work, review, or maintain.");
  return [...new Set(body.capabilities as string[])];
}

function validUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error();
    return url.toString();
  } catch {
    throw new ApiProblem(422, "validation", "Validation Failed", "A valid HTTPS URL is required.");
  }
}

function urlArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32 || value.some((item) => typeof item !== "string"))
    throw new ApiProblem(422, "validation", "Validation Failed", "artifactUrls must be an array of URLs.");
  return value.map(validUrl);
}

async function executeConstraint<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isConstraintError(error)) throw new ApiProblem(409, "constraint-conflict", "Conflict", "The resource conflicts with existing state.");
    throw error;
  }
}

function patchNonEmptyString(body: Record<string, unknown>, name: string, current: string, max: number): string {
  return name in body ? requiredString(body, name, max) : current;
}

function requireChanged(result: { meta: { changes?: number } }): void {
  if ((result.meta.changes ?? 0) !== 1)
    throw new ApiProblem(412, "precondition-failed", "Precondition Failed", "The resource changed before this mutation completed.");
}

function rejectBoardHistory(history: unknown | null): void {
  if (history)
    throw new ApiProblem(409, "board-has-execution-history", "Board Has Execution History", "Boards with TaskRun history cannot be deleted.");
}

function rejectTaskHistory(history: unknown | null): void {
  if (history) throw new ApiProblem(409, "task-has-execution-history", "Task Has Execution History", "Tasks with TaskRun history cannot be deleted.");
}

function rejectAssignmentHistory(history: unknown | null): void {
  if (history)
    throw new ApiProblem(
      409,
      "assignment-has-execution-history",
      "Assignment Has Execution History",
      "Assignments with TaskRun history cannot be released.",
    );
}

function rejectConnectionInUse(inUse: unknown | null): void {
  if (inUse)
    throw new ApiProblem(
      409,
      "ama-connection-in-use",
      "AMA Connection In Use",
      "Detach every Board execution binding before deleting this AMA Connection.",
    );
}

function rejectBindingHistory(history: unknown | null): void {
  if (history)
    throw new ApiProblem(
      409,
      "execution-binding-has-history",
      "Execution Binding Has History",
      "Execution bindings for Boards with TaskRun history cannot be changed.",
    );
}
