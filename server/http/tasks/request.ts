import {
  assertOptionalResourceObject,
  assertOptionalResourceString,
  assertOptionalResourceStringArray,
  assertRequiredResourceString,
  assertResourceWriteFields,
} from "@server/http/resource-server/request";
import type { CreateTaskInput } from "@shared";
import { parseScheduledAt } from "@shared";
import { HTTPException } from "hono/http-exception";

const TASK_CREATE_FIELDS = new Set([
  "title",
  "description",
  "repository_id",
  "labels",
  "input",
  "metadata",
  "board_id",
  "depends_on",
  "created_from",
  "scheduled_at",
]);

export function normalizeTaskCreate(
  body: Record<string, unknown>,
  resourcePrincipal: boolean,
): asserts body is Record<string, unknown> & CreateTaskInput {
  if (resourcePrincipal) normalizeToolboxTaskWrite(body);
  normalizeTaskDetailAlias(body);
  rejectTaskAssignmentFields(body);
  const unsupportedFields = Object.keys(body).filter((field) => !TASK_CREATE_FIELDS.has(field));
  if (unsupportedFields.length > 0) {
    throw new HTTPException(400, {
      message: `Unsupported Task create field${unsupportedFields.length === 1 ? "" : "s"}: ${unsupportedFields.join(", ")}`,
    });
  }
  if (!body.title) throw new HTTPException(400, { message: "title is required" });
  normalizeTaskValues(body);
}

export function normalizeTaskUpdate(body: Record<string, unknown>): void {
  normalizeTaskDetailAlias(body);
  rejectTaskAssignmentFields(body);
  normalizeTaskValues(body);
}

function normalizeToolboxTaskWrite(body: Record<string, unknown>): void {
  assertResourceWriteFields(
    body,
    new Set(["title", "description", "boardId", "repositoryId", "labels", "dependsOn", "createdFrom", "input", "metadata", "scheduledAt"]),
    "Task",
  );
  assertRequiredResourceString(body, "title", "Task");
  for (const field of ["description", "boardId", "repositoryId", "createdFrom", "scheduledAt"]) {
    assertOptionalResourceString(body, field, "Task");
  }
  assertOptionalResourceStringArray(body, "labels", "Task");
  assertOptionalResourceStringArray(body, "dependsOn", "Task");
  assertOptionalResourceObject(body, "input", "Task");
  assertOptionalResourceObject(body, "metadata", "Task");
  const mappings = {
    boardId: "board_id",
    repositoryId: "repository_id",
    dependsOn: "depends_on",
    createdFrom: "created_from",
    scheduledAt: "scheduled_at",
  } as const;
  for (const [external, internal] of Object.entries(mappings)) {
    if (body[external] !== undefined) body[internal] = body[external];
    delete body[external];
  }
}

function normalizeTaskDetailAlias(body: Record<string, unknown>): void {
  if (body.detail === undefined) return;
  if (typeof body.detail !== "string") throw new HTTPException(400, { message: "detail must be a string" });
  if (body.description === undefined) body.description = body.detail;
  delete body.detail;
}

function rejectTaskAssignmentFields(body: Record<string, unknown>): void {
  if (body.assigned_to !== undefined || body.agent_id !== undefined || body.assignee_identity_type !== undefined) {
    throw new HTTPException(400, { message: "Assign the Task through /api/task-assignments/{taskId}" });
  }
}

function normalizeTaskValues(body: Record<string, unknown>): void {
  if (body.input !== undefined && body.input !== null && typeof body.input !== "object") {
    throw new HTTPException(400, { message: "input must be a JSON object or null" });
  }
  if (body.metadata !== undefined && body.metadata !== null && (typeof body.metadata !== "object" || Array.isArray(body.metadata))) {
    throw new HTTPException(400, { message: "metadata must be a JSON object or null" });
  }
  if (body.scheduled_at !== undefined && body.scheduled_at !== null) {
    if (typeof body.scheduled_at !== "string") {
      throw new HTTPException(400, { message: "scheduled_at must be ISO 8601 with timezone (e.g. 2026-03-28T09:00:00Z)" });
    }
    const normalized = parseScheduledAt(body.scheduled_at);
    if (!normalized) {
      throw new HTTPException(400, { message: "scheduled_at must be ISO 8601 with timezone (e.g. 2026-03-28T09:00:00Z)" });
    }
    body.scheduled_at = normalized;
  }
}
