import { connectSessionSocket, EnborApiError, type EnborClient, type Session } from "@realmroot/enbor-sdk";
import { createAgencyClient } from "@server/adapters/agency/client";
import {
  addTaskAction,
  assertTaskOwner,
  createTask,
  deleteTask,
  getTask,
  getTaskAction,
  getTaskNotes,
  listTaskNotePage,
  listTaskPage,
  listTasks,
  updateTask,
} from "@server/adapters/d1/taskRepo";
import { createSSEResponse } from "@server/adapters/stream/sse";
import type { Env } from "@server/env";
import { amaAuthorization } from "@server/http/resource-server/amaDependencies";
import { pageResponse, readPageWindow } from "@server/http/resource-server/pagination";
import { taskNoteResource, taskResource } from "@server/http/resource-server/representation";
import {
  assertRequiredResourceString,
  assertResourceWriteFields,
  isResourcePrincipal,
  readJsonBody,
  resolveActor,
  resourceIdempotencyFor,
  setCreatedResourceHeaders,
} from "@server/http/resource-server/request";
import { normalizeTaskCreate, normalizeTaskUpdate } from "@server/http/tasks/request";
import { TASK_STATUSES, type Task } from "@shared";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerTaskResourceRoutes(api: Hono<{ Bindings: Env }>): void {
  registerTaskOwnership(api);
  api.post("/api/tasks", createTaskResource);
  api.get("/api/tasks", listTaskResources);
  api.get("/api/tasks/:id", getTaskResource);
  api.patch("/api/tasks/:id", updateTaskResource);
  api.delete("/api/tasks/:id", deleteTaskResource);
  api.get("/api/tasks/:id/session", getTaskSession);
  api.get("/api/tasks/:id/session/ws", getTaskSessionWebSocket);
  api.post("/api/tasks/:id/notes", createTaskNote);
  api.get("/api/tasks/:id/notes", listTaskNotes);
  api.get("/api/tasks/:id/notes/:noteId", getTaskNote);
  api.get("/api/tasks/:id/stream", streamTask);
}

type TaskContext = Context<{ Bindings: Env }>;

function registerTaskOwnership(api: Hono<{ Bindings: Env }>): void {
  api.use("/api/tasks/:id/*", async (c, next) => {
    await assertTaskOwner(c.env.DB, c.req.param("id"), c.get("ownerId"));
    return next();
  });
  api.use("/api/tasks/:id", async (c, next) => {
    if (c.req.method === "POST") return next();
    await assertTaskOwner(c.env.DB, c.req.param("id"), c.get("ownerId"));
    return next();
  });
}

async function createTaskResource(c: TaskContext): Promise<Response> {
  const body = await readJsonBody<Record<string, unknown>>(c);
  if (body instanceof Response) return body;
  normalizeTaskCreate(body, isResourcePrincipal(c));
  const { actorType, actorId } = resolveActor(c);
  const task = await createTask(
    c.env.DB,
    c.get("ownerId"),
    { ...body, actorType, actorId },
    resourceIdempotencyFor(
      c,
      "tasks",
      (resource) => resource.updated_at,
      (resource) => taskResource(resource, c.req.url),
    ),
  );
  if (isResourcePrincipal(c)) {
    setCreatedResourceHeaders(c, "tasks", task.id, task.updated_at);
    return c.json(taskResource(task, c.req.url), 201);
  }
  return c.json(task, 201);
}

async function listTaskResources(c: TaskContext): Promise<Response> {
  const query = c.req.query();
  const filters = {
    repository_id: isResourcePrincipal(c) ? query.repositoryId : query.repository_id,
    board_id: isResourcePrincipal(c) ? query.boardId : query.board_id,
    assigned_to: isResourcePrincipal(c) ? query.assignedTo : query.assigned_to,
    status: isResourcePrincipal(c) ? query.status?.replaceAll("-", "_") : query.status,
    label: query.label,
    parent: query.parent,
  };
  if (filters.status !== undefined && !TASK_STATUSES.includes(filters.status as (typeof TASK_STATUSES)[number])) {
    throw new HTTPException(400, { message: `status must be one of: ${TASK_STATUSES.join(", ")}` });
  }
  if (isResourcePrincipal(c)) {
    const window = await readPageWindow(c);
    if (window instanceof Response) return window;
    return pageResponse(c, await listTaskPage(c.env.DB, c.get("ownerId"), filters, window), window, taskResource);
  }
  return c.json(await listTasks(c.env.DB, c.get("ownerId"), filters));
}

async function getTaskResource(c: TaskContext): Promise<Response> {
  const task = await requireTask(c);
  if (isResourcePrincipal(c)) {
    c.header("ETag", `"${task.updated_at}"`);
    return c.json(taskResource(task, c.req.url));
  }
  return c.json(task);
}

async function updateTaskResource(c: TaskContext): Promise<Response> {
  const body = await c.req.json();
  normalizeTaskUpdate(body);
  await requireTask(c);
  const task = await updateTask(c.env.DB, taskId(c), body, c.get("ownerId"));
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  return c.json(task);
}

async function deleteTaskResource(c: TaskContext): Promise<Response> {
  await requireTask(c);
  if (!(await deleteTask(c.env.DB, taskId(c), c.get("ownerId")))) {
    throw new HTTPException(404, { message: "Task not found" });
  }
  return c.json({ ok: true });
}

async function createTaskNote(c: TaskContext): Promise<Response> {
  const body = await readJsonBody<{ detail: string }>(c);
  if (body instanceof Response) return body;
  if (isResourcePrincipal(c)) {
    assertResourceWriteFields(body, new Set(["detail"]), "Task Note");
    assertRequiredResourceString(body, "detail", "Task Note");
  }
  if (!body.detail) throw new HTTPException(400, { message: "detail is required" });
  await requireTask(c);
  const { actorType, actorId, sessionId } = resolveActor(c);
  const note = await addTaskAction(
    c.env.DB,
    taskId(c),
    actorType,
    actorId,
    "commented",
    body.detail,
    sessionId,
    resourceIdempotencyFor(
      c,
      `tasks/${encodeURIComponent(taskId(c))}/notes`,
      (resource) => resource.id,
      (resource) => taskNoteResource(resource, c.req.url),
    ),
  );
  if (isResourcePrincipal(c)) {
    setCreatedResourceHeaders(c, `tasks/${encodeURIComponent(taskId(c))}/notes`, note.id, note.id);
    return c.json(taskNoteResource(note, c.req.url), 201);
  }
  return c.json(note, 201);
}

async function listTaskNotes(c: TaskContext): Promise<Response> {
  await requireTask(c);
  const since = c.req.query("since") || undefined;
  if (isResourcePrincipal(c)) {
    const window = await readPageWindow(c);
    if (window instanceof Response) return window;
    return pageResponse(c, await listTaskNotePage(c.env.DB, taskId(c), window, since), window, taskNoteResource);
  }
  return c.json(await getTaskNotes(c.env.DB, taskId(c), since));
}

async function getTaskNote(c: TaskContext): Promise<Response> {
  await requireTask(c);
  const note = await getTaskAction(c.env.DB, taskId(c), noteId(c));
  if (note?.action !== "commented") throw new HTTPException(404, { message: "Task Note not found" });
  if (isResourcePrincipal(c)) {
    c.header("ETag", `"${note.id}"`);
    return c.json(taskNoteResource(note, c.req.url));
  }
  return c.json(note);
}

async function getTaskSession(c: TaskContext): Promise<Response> {
  const task = await requireTask(c);
  const binding = requireTaskSession(task);
  try {
    return c.json(await resolveAgencySession(c, binding));
  } catch (error) {
    return mapSessionObservationFailure(c, error);
  }
}

async function getTaskSessionWebSocket(c: TaskContext): Promise<Response> {
  const task = await requireTask(c);
  const binding = requireTaskSession(task);
  try {
    const upgrade = c.req.header("Upgrade")?.toLowerCase() === "websocket";
    const client = await taskSessionClient(c, upgrade ? ["sessions:read", "sessions:write"] : ["sessions:read"]);
    const session = await readAgencySession(client.client, binding.runtime_session_id, client.projectId);
    if (!upgrade) {
      const url = new URL(c.req.url);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return c.json({ url: url.toString(), sessionId: session.metadata.uid });
    }
    const socketClient = createAgencyClient(
      client.origin,
      {
        token: client.token,
        projectId: client.projectId,
        traceparent: c.get("traceparent"),
      },
      { Upgrade: "websocket" },
    );
    const { response } = await connectSessionSocket({
      client: socketClient.raw,
      path: { sessionId: session.metadata.uid },
      parseAs: "stream",
    });
    if (response?.status !== 101 || !response.webSocket) {
      throw new EnborApiError(response?.status, "Session socket upgrade failed", null);
    }
    return relayReadOnlyAgencySocket(response.webSocket);
  } catch (error) {
    return mapSessionObservationFailure(c, error);
  }
}

async function resolveAgencySession(c: TaskContext, binding: NonNullable<Task["session_binding"]>) {
  const client = await taskSessionClient(c, ["sessions:read"]);
  return readAgencySession(client.client, binding.runtime_session_id, client.projectId);
}

async function taskSessionClient(c: TaskContext, scopes: readonly string[]) {
  const { projectId, token, origin } = await amaAuthorization(c, scopes);
  return {
    projectId,
    token,
    origin,
    client: createAgencyClient(origin, { token, projectId, traceparent: c.get("traceparent") }),
  };
}

async function readAgencySession(client: EnborClient, sessionId: string, projectId: string): Promise<Session> {
  const session = await client.sessions.get(sessionId);
  if (!session?.metadata) throw new EnborApiError(502, "Agency returned an invalid Session response", session);
  if (session.metadata.uid !== sessionId || session.metadata.projectId !== projectId) {
    throw new EnborApiError(502, "Agency returned a Session outside the requested identity or Project", session);
  }
  return session;
}

function relayReadOnlyAgencySocket(upstream: WebSocket): Response {
  const pair = new WebSocketPair();
  const browser = pair[1];
  let closed = false;

  const close = (target: WebSocket, event: CloseEvent) => {
    if (closed) return;
    closed = true;
    if ([1004, 1005, 1006, 1015].includes(event.code)) target.close();
    else target.close(event.code, event.reason);
  };
  const fail = () => {
    if (closed) return;
    closed = true;
    for (const socket of [browser, upstream]) {
      try {
        socket.close(1011, "Session observation relay failed");
      } catch {
        // A peer may already be closed after the first failed send.
      }
    }
  };

  browser.addEventListener("message", (event) => {
    try {
      if (!isBackfillRequest(event.data)) {
        browser.send(JSON.stringify({ type: "error", code: "read_only", message: "Task Session observation is read-only" }));
        return;
      }
      upstream.send(event.data);
    } catch {
      fail();
    }
  });
  upstream.addEventListener("message", (event) => {
    try {
      browser.send(event.data);
    } catch {
      fail();
    }
  });
  browser.addEventListener("close", (event) => close(upstream, event));
  upstream.addEventListener("close", (event) => close(browser, event));
  browser.addEventListener("error", fail);
  upstream.addEventListener("error", fail);
  browser.accept();
  upstream.accept();
  return new Response(null, { status: 101, webSocket: pair[0] });
}

function isBackfillRequest(value: string | ArrayBuffer): value is string {
  if (typeof value !== "string") return false;
  try {
    const frame = JSON.parse(value) as unknown;
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) return false;
    const record = frame as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["type", "requestId", "limit", "cursor"].includes(key))) return false;
    return (
      record.type === "backfill" &&
      typeof record.requestId === "string" &&
      record.requestId.length > 0 &&
      record.requestId.length <= 200 &&
      Number.isInteger(record.limit) &&
      (record.limit as number) >= 1 &&
      (record.limit as number) <= 200 &&
      (record.cursor === undefined || (Number.isInteger(record.cursor) && (record.cursor as number) >= 0))
    );
  } catch {
    return false;
  }
}

function mapSessionObservationFailure(c: TaskContext, error: unknown): Response {
  if (error instanceof EnborApiError && error.status === 404) {
    return c.json({ error: { code: "AMA_SESSION_NOT_FOUND", message: "Agency Session not found for the Task" } }, 404);
  }
  if (error instanceof EnborApiError) {
    return c.json({ error: { code: "AMA_SESSION_UNAVAILABLE", message: "Agency Session observation is unavailable" } }, 503);
  }
  throw error;
}

async function streamTask(c: TaskContext): Promise<Response> {
  const task = await requireTask(c);
  return createSSEResponse(c.env, task.id, c.req.header("Last-Event-ID") || null);
}

async function requireTask(c: TaskContext): Promise<Task> {
  const task = await getTask(c.env.DB, taskId(c), c.get("ownerId"));
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  return task;
}

function requireTaskSession(task: Task) {
  if (!task.session_binding) throw new HTTPException(404, { message: "Task is not bound to a runtime Session" });
  return task.session_binding;
}

function taskId(c: TaskContext): string {
  const id = c.req.param("id");
  if (!id) throw new HTTPException(400, { message: "Task ID is required" });
  return id;
}

function noteId(c: TaskContext): string {
  const id = c.req.param("noteId");
  if (!id) throw new HTTPException(400, { message: "Task Note ID is required" });
  return id;
}
