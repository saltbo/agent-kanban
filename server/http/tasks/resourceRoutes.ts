import { connectSessionSocket, EnborApiError, type EnborClient, type Session } from "@realmroot/enbor-sdk";
import { createAgencyClient } from "@server/adapters/agency/client";
import {
  addTaskAction,
  createTask,
  deleteTask,
  getTask,
  getTaskAction,
  listTaskNotePage,
  listTaskPage,
  updateTask,
} from "@server/adapters/d1/taskRepo";
import { d1TaskAssignmentRepository } from "@server/adapters/d1/tasks/d1TaskAssignments";
import { d1TaskCancellationRepository } from "@server/adapters/d1/tasks/d1TaskCancellations";
import { d1TaskReviewDecisionRepository } from "@server/adapters/d1/tasks/d1TaskReviewDecisions";
import { d1TaskReviewSubmissionRepository } from "@server/adapters/d1/tasks/d1TaskReviewSubmissions";
import { inboxTaskLifecycleNotifier } from "@server/adapters/realmroot/inboxTaskLifecycleNotifier";
import { createSSEResponse } from "@server/adapters/stream/sse";
import { authorizeScope } from "@server/auth/middleware";
import type { Env } from "@server/env";
import { idempotencyMiddleware } from "@server/http/middleware/idempotency";
import { v2Problem } from "@server/http/middleware/v2Contract";
import { agencyAuthorization } from "@server/http/resource-server/agencyDependencies";
import { pageResponse, readPageWindow } from "@server/http/resource-server/pagination";
import { taskNoteResource, taskResource } from "@server/http/resource-server/representation";
import {
  assertRequiredResourceString,
  assertResourceWriteFields,
  readJsonBody,
  resolveActor,
  resourceIdempotencyFor,
  setCreatedResourceHeaders,
} from "@server/http/resource-server/request";
import { normalizeTaskCreate, normalizeTaskUpdate } from "@server/http/tasks/request";
import { AgencySessionInvalidResponse } from "@server/usecases/agency/failures";
import { replaceTaskAssignment, TaskAssignmentFailure } from "@server/usecases/tasks/replaceTaskAssignment";
import { replaceTaskCancellation, TaskCancellationFailure } from "@server/usecases/tasks/replaceTaskCancellation";
import { replaceTaskReviewCompletion, replaceTaskReviewRejection, TaskReviewDecisionFailure } from "@server/usecases/tasks/replaceTaskReviewDecision";
import {
  readTaskReviewSubmission,
  replaceTaskReviewSubmission,
  TaskReviewSubmissionFailure,
} from "@server/usecases/tasks/replaceTaskReviewSubmission";
import { notifyTaskLifecycle } from "@server/usecases/tasks/taskLifecycleNotifications";
import { TASK_STATUSES, type Task } from "@shared";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { mediaType, readStrongVersionPrecondition, requestActorId, taskWorkflowActor } from "./workflowSupport";

export function registerTaskResourceRoutes(api: Hono<{ Bindings: Env }>): void {
  api.post("/api/tasks", authorizeScope("task:write"), idempotencyMiddleware, createTaskResource);
  api.get("/api/tasks", authorizeScope("task:read"), listTaskResources);
  api.get("/api/tasks/:id", authorizeScope("task:read"), getTaskResource);
  api.patch("/api/tasks/:id", authorizeScope("task:write"), updateTaskResource);
  api.delete("/api/tasks/:id", authorizeScope("task:write"), deleteTaskResource);
  api.get("/api/tasks/:id/session", authorizeScope("task:read"), getTaskSession);
  api.get("/api/tasks/:id/session/ws", authorizeScope("task:read"), getTaskSessionWebSocket);
  api.post("/api/tasks/:id/notes", authorizeScope("task:write"), idempotencyMiddleware, createTaskNote);
  api.get("/api/tasks/:id/notes", authorizeScope("task:read"), listTaskNotes);
  api.get("/api/tasks/:id/notes/:noteId", authorizeScope("task:read"), getTaskNote);
  api.get("/api/tasks/:id/stream", authorizeScope("task:read"), streamTask);
}

type TaskContext = Context<{ Bindings: Env }>;

async function createTaskResource(c: TaskContext): Promise<Response> {
  const body = await readJsonBody<Record<string, unknown>>(c);
  if (body instanceof Response) return body;
  normalizeTaskCreate(body);
  const { actorType, actorId } = resolveActor(c);
  const task = await createTask(
    c.env.DB,
    c.get("ownerId"),
    { ...body, actorType, actorId },
    resourceIdempotencyFor(
      c,
      "tasks",
      (resource) => String(resource.version),
      (resource) => taskResource(resource, c.req.url),
    ),
  );
  setCreatedResourceHeaders(c, "tasks", task.id, String(task.version));
  return c.json(taskResource(task, c.req.url), 201);
}

async function listTaskResources(c: TaskContext): Promise<Response> {
  const query = c.req.query();
  const filters = {
    repository_id: query.repositoryId,
    board_id: query.boardId,
    assigned_to: query.assignedTo,
    status: query.status?.replaceAll("-", "_"),
    label: query.label,
    parent: query.parent,
  };
  if (filters.status !== undefined && !TASK_STATUSES.includes(filters.status as (typeof TASK_STATUSES)[number])) {
    throw new HTTPException(400, { message: `status must be one of: ${TASK_STATUSES.join(", ")}` });
  }
  const window = await readPageWindow(c);
  if (window instanceof Response) return window;
  return pageResponse(c, await listTaskPage(c.env.DB, c.get("ownerId"), filters, window), window, taskResource);
}

async function getTaskResource(c: TaskContext): Promise<Response> {
  const task = await requireTask(c);
  c.header("ETag", `"${task.version}"`);
  return c.json(taskResource(task, c.req.url));
}

async function updateTaskResource(c: TaskContext): Promise<Response> {
  if (mediaType(c) !== "application/merge-patch+json") {
    return v2Problem(c, 415, "unsupported-media-type", "Unsupported media type", "Content-Type must be application/merge-patch+json");
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return v2Problem(c, 400, "invalid-json", "Invalid JSON", "The request body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return v2Problem(c, 422, "invalid-task-patch", "Invalid Task patch", "Task patch must be a JSON object");
  }
  const current = await requireTask(c);

  const patch = body as Record<string, unknown>;
  if (Object.keys(patch).length === 0) {
    return v2Problem(c, 422, "invalid-task-patch", "Invalid Task patch", "Task patch must contain at least one property");
  }
  const isAssignment = Object.hasOwn(patch, "assignedTo");
  const isTransition = Object.hasOwn(patch, "status");
  if (isAssignment && isTransition) {
    return v2Problem(c, 422, "invalid-task-patch", "Invalid Task patch", "Assignment and status changes must be separate requests");
  }
  if (isAssignment) return patchTaskAssignment(c, patch, current.version);
  if (isTransition) return patchTaskStatus(c, patch, current.version);

  normalizeTaskUpdate(patch);
  const task = await updateTask(c.env.DB, taskId(c), patch, c.get("ownerId"), current.version);
  if (!task) return taskUpdateConflict(c, "Task changed before the patch was committed; reread it before retrying");
  c.header("ETag", `"${task.version}"`);
  return c.json(taskResource(task, c.req.url));
}

async function patchTaskAssignment(c: TaskContext, patch: Record<string, unknown>, expectedTaskVersion: number): Promise<Response> {
  if (Object.keys(patch).length !== 1 || typeof patch.assignedTo !== "string" || !patch.assignedTo.trim() || patch.assignedTo.length > 200) {
    return v2Problem(
      c,
      422,
      "invalid-task-assignment",
      "Invalid Task assignment",
      "assignedTo must be the only property and contain an Agent actor ID",
    );
  }
  try {
    const result = await replaceTaskAssignment(d1TaskAssignmentRepository(c.env.DB), {
      ownerId: c.get("ownerId"),
      taskId: taskId(c),
      assigneeActorId: patch.assignedTo,
      assignedByActorId: taskWorkflowActor(c).id,
      expectedTaskVersion,
    });
    await notifyTaskLifecycle(inboxTaskLifecycleNotifier(c.env), {
      taskId: result.assignment.taskId,
      assigneeActorId: result.assignment.agentActorId,
      ownerId: c.get("ownerId"),
      event: "assigned",
      version: result.version,
    });
    return updatedTaskResponse(c);
  } catch (error) {
    if (!(error instanceof TaskAssignmentFailure)) throw error;
    if (await taskVersionChanged(c, expectedTaskVersion)) {
      return taskUpdateConflict(c, "Task changed before the assignment was committed; reread it before retrying");
    }
    if (error.code === "TASK_NOT_FOUND") return v2Problem(c, 404, "task-not-found", "Task not found", error.message);
    return v2Problem(c, 409, "task-assignment-conflict", "Task assignment conflict", error.message);
  }
}

async function patchTaskStatus(c: TaskContext, patch: Record<string, unknown>, expectedTaskVersion: number): Promise<Response> {
  const status = patch.status;
  if (typeof status !== "string" || !["in-review", "in-progress", "done", "cancelled"].includes(status)) {
    return v2Problem(c, 422, "invalid-task-status", "Invalid Task status", "status must be in-review, in-progress, done, or cancelled");
  }
  const allowed =
    status === "in-review"
      ? new Set(["status", "pullRequestUrl"])
      : status === "in-progress"
        ? new Set(["status", "statusReason"])
        : new Set(["status"]);
  if (Object.keys(patch).some((field) => !allowed.has(field))) {
    return v2Problem(c, 422, "invalid-task-transition", "Invalid Task transition", `Unsupported properties for transition to ${status}`);
  }
  if (patch.pullRequestUrl !== undefined && (typeof patch.pullRequestUrl !== "string" || !isHttpUrl(patch.pullRequestUrl))) {
    return v2Problem(c, 422, "invalid-task-transition", "Invalid Task transition", "pullRequestUrl must be an absolute HTTP or HTTPS URL");
  }
  if (patch.statusReason !== undefined && (typeof patch.statusReason !== "string" || patch.statusReason.length > 4000)) {
    return v2Problem(c, 422, "invalid-task-transition", "Invalid Task transition", "statusReason must be a string of at most 4000 characters");
  }

  try {
    if (status === "in-review") {
      await replaceTaskReviewSubmission(d1TaskReviewSubmissionRepository(c.env.DB), {
        ownerId: c.get("ownerId"),
        taskId: taskId(c),
        agentActorId: requestActorId(c),
        pullRequestUrl: (patch.pullRequestUrl as string | undefined) ?? null,
        expectedTaskVersion,
      });
    } else if (status === "cancelled") {
      await replaceTaskCancellation(d1TaskCancellationRepository(c.env.DB), {
        ownerId: c.get("ownerId"),
        taskId: taskId(c),
        actor: taskWorkflowActor(c),
        expectedTaskVersion,
      });
    } else {
      const submission = await readTaskReviewSubmission(d1TaskReviewSubmissionRepository(c.env.DB), {
        ownerId: c.get("ownerId"),
        taskId: taskId(c),
      });
      if (status === "in-progress") {
        const result = await replaceTaskReviewRejection(d1TaskReviewDecisionRepository(c.env.DB), {
          ownerId: c.get("ownerId"),
          taskId: taskId(c),
          reviewSubmissionVersion: submission.version,
          actor: taskWorkflowActor(c),
          reason: (patch.statusReason as string | undefined) || null,
          expectedTaskVersion,
        });
        await notifyTaskLifecycle(inboxTaskLifecycleNotifier(c.env), {
          taskId: result.rejection.taskId,
          assigneeActorId: result.assigneeActorId,
          ownerId: c.get("ownerId"),
          event: "review_rejected",
          version: result.version,
        });
      } else {
        await replaceTaskReviewCompletion(d1TaskReviewDecisionRepository(c.env.DB), {
          ownerId: c.get("ownerId"),
          taskId: taskId(c),
          reviewSubmissionVersion: submission.version,
          actor: taskWorkflowActor(c),
          expectedTaskVersion,
        });
      }
    }
    return updatedTaskResponse(c);
  } catch (error) {
    if (error instanceof TaskReviewSubmissionFailure) {
      if (await taskVersionChanged(c, expectedTaskVersion)) {
        return taskUpdateConflict(c, "Task changed before the transition was committed; reread it before retrying");
      }
      if (error.code === "TASK_NOT_FOUND") return v2Problem(c, 404, "task-not-found", "Task not found", error.message);
      if (error.code === "TASK_REVIEW_FORBIDDEN") return v2Problem(c, 403, "task-transition-forbidden", "Task transition forbidden", error.message);
      return v2Problem(c, 409, "task-transition-conflict", "Task transition conflict", error.message);
    }
    if (error instanceof TaskReviewDecisionFailure) {
      if (await taskVersionChanged(c, expectedTaskVersion)) {
        return taskUpdateConflict(c, "Task changed before the transition was committed; reread it before retrying");
      }
      if (error.code === "TASK_NOT_FOUND") return v2Problem(c, 404, "task-not-found", "Task not found", error.message);
      if (error.code === "TASK_REVIEW_DECISION_FORBIDDEN")
        return v2Problem(c, 403, "task-transition-forbidden", "Task transition forbidden", error.message);
      if (error.code === "TASK_REVIEW_PRECONDITION_FAILED") return taskUpdateConflict(c, `${error.message}; reread the Task before retrying`);
      return v2Problem(c, 409, "task-transition-conflict", "Task transition conflict", error.message);
    }
    if (error instanceof TaskCancellationFailure) {
      if (await taskVersionChanged(c, expectedTaskVersion)) {
        return taskUpdateConflict(c, "Task changed before the transition was committed; reread it before retrying");
      }
      if (error.code === "TASK_NOT_FOUND") return v2Problem(c, 404, "task-not-found", "Task not found", error.message);
      return v2Problem(c, 409, "task-transition-conflict", "Task transition conflict", error.message);
    }
    throw error;
  }
}

function taskUpdateConflict(c: TaskContext, detail: string): Response {
  return v2Problem(c, 409, "task-update-conflict", "Task update conflict", detail);
}

async function taskVersionChanged(c: TaskContext, expectedTaskVersion: number): Promise<boolean> {
  const task = await getTask(c.env.DB, taskId(c), c.get("ownerId"));
  return task !== null && task.version !== expectedTaskVersion;
}

async function updatedTaskResponse(c: TaskContext): Promise<Response> {
  const task = await getTask(c.env.DB, taskId(c), c.get("ownerId"));
  if (!task) return v2Problem(c, 404, "task-not-found", "Task not found", "Task not found");
  c.header("ETag", `"${task.version}"`);
  return c.json(taskResource(task, c.req.url));
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function deleteTaskResource(c: TaskContext): Promise<Response> {
  const expectedVersion = readStrongVersionPrecondition(c, "Task");
  if (expectedVersion instanceof Response) return expectedVersion;
  const current = await requireTask(c);
  if (String(current.version) !== expectedVersion) {
    return v2Problem(c, 412, "task-precondition-failed", "Task precondition failed", "If-Match does not identify the current Task version");
  }
  if (!(await deleteTask(c.env.DB, taskId(c), c.get("ownerId"), current.version))) {
    const latest = await getTask(c.env.DB, taskId(c), c.get("ownerId"));
    if (latest) return v2Problem(c, 412, "task-precondition-failed", "Task precondition failed", "Task changed before deletion was committed");
    throw new HTTPException(404, { message: "Task not found" });
  }
  return c.body(null, 204);
}

async function createTaskNote(c: TaskContext): Promise<Response> {
  const body = await readJsonBody<{ detail: string }>(c);
  if (body instanceof Response) return body;
  assertResourceWriteFields(body, new Set(["detail"]), "Task Note");
  assertRequiredResourceString(body, "detail", "Task Note");
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
  setCreatedResourceHeaders(c, `tasks/${encodeURIComponent(taskId(c))}/notes`, note.id, note.id);
  return c.json(taskNoteResource(note, c.req.url), 201);
}

async function listTaskNotes(c: TaskContext): Promise<Response> {
  await requireTask(c);
  const since = c.req.query("since") || undefined;
  const window = await readPageWindow(c);
  if (window instanceof Response) return window;
  return pageResponse(c, await listTaskNotePage(c.env.DB, taskId(c), window, since), window, taskNoteResource);
}

async function getTaskNote(c: TaskContext): Promise<Response> {
  await requireTask(c);
  const note = await getTaskAction(c.env.DB, taskId(c), noteId(c));
  if (note?.action !== "commented") throw new HTTPException(404, { message: "Task Note not found" });
  c.header("ETag", `"${note.id}"`);
  return c.json(taskNoteResource(note, c.req.url));
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
  const { projectId, token, origin } = await agencyAuthorization(c, scopes);
  return {
    projectId,
    token,
    origin,
    client: createAgencyClient(origin, { token, projectId, traceparent: c.get("traceparent") }),
  };
}

async function readAgencySession(client: EnborClient, sessionId: string, projectId: string): Promise<Session> {
  const session = await client.sessions.get(sessionId);
  if (!session?.metadata) throw new AgencySessionInvalidResponse("Agency returned an invalid Session response");
  if (session.metadata.uid !== sessionId || session.metadata.projectId !== projectId) {
    throw new AgencySessionInvalidResponse("Agency returned a Session outside the requested identity or Project");
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
    return v2Problem(c, 404, "agency-session-not-found", "Agency Session not found", "Agency Session not found for the Task");
  }
  if (error instanceof AgencySessionInvalidResponse) {
    return v2Problem(c, 502, "agency-session-invalid-response", "Invalid Agency Session response", "Agency returned an invalid Session response");
  }
  if (error instanceof EnborApiError) {
    return v2Problem(c, 503, "agency-session-unavailable", "Agency Session unavailable", "Agency Session observation is unavailable");
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
