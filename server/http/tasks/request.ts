import {
  assertOptionalResourceObject,
  assertOptionalResourceString,
  assertOptionalResourceStringArray,
  assertRequiredResourceString,
  assertResourceWriteFields,
} from "@server/http/resource-server/request";
import type { CreateTaskInput } from "@shared";
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

export function normalizeTaskCreate(body: Record<string, unknown>): asserts body is Record<string, unknown> & CreateTaskInput {
  normalizeTaskWrite(
    body,
    new Set(["title", "description", "boardId", "repositoryId", "labels", "dependsOn", "createdFrom", "input", "metadata", "scheduledAt"]),
  );
  rejectTaskAssignmentFields(body);
  const unsupportedFields = Object.keys(body).filter((field) => !TASK_CREATE_FIELDS.has(field));
  if (unsupportedFields.length > 0) {
    throw new HTTPException(400, {
      message: `Unsupported Task create field${unsupportedFields.length === 1 ? "" : "s"}: ${unsupportedFields.join(", ")}`,
    });
  }
  if (!body.title) throw new HTTPException(400, { message: "title is required" });
  if (body.scheduled_at === null) {
    throw new HTTPException(400, { message: "scheduledAt must be ISO 8601 with timezone (e.g. 2026-03-28T09:00:00Z)" });
  }
  normalizeTaskValues(body);
}

export function normalizeTaskUpdate(body: Record<string, unknown>): void {
  normalizeTaskWrite(
    body,
    new Set(["title", "description", "repositoryId", "labels", "pullRequestUrl", "input", "metadata", "position", "scheduledAt", "dependsOn"]),
  );
  rejectTaskAssignmentFields(body);
  if (body.title === null) throw new HTTPException(422, { message: "Task.title cannot be null" });
  if (body.metadata === null) throw new HTTPException(422, { message: "Task.metadata cannot be null" });
  if (body.position !== undefined && (typeof body.position !== "number" || !Number.isFinite(body.position))) {
    throw new HTTPException(422, { message: "Task.position must be a finite number" });
  }
  if (body.pr_url !== undefined && body.pr_url !== null && (typeof body.pr_url !== "string" || !isHttpUrl(body.pr_url))) {
    throw new HTTPException(422, { message: "Task.pullRequestUrl must be an absolute HTTP or HTTPS URL" });
  }
  normalizeTaskValues(body);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeTaskWrite(body: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  assertResourceWriteFields(body, allowed, "Task");
  if (allowed.has("boardId")) assertRequiredResourceString(body, "title", "Task");
  for (const field of ["title", "description", "boardId", "repositoryId", "pullRequestUrl", "createdFrom", "scheduledAt"]) {
    if (body[field] !== null) assertOptionalResourceString(body, field, "Task");
  }
  if (body.labels !== null) assertOptionalResourceStringArray(body, "labels", "Task");
  assertOptionalResourceStringArray(body, "dependsOn", "Task");
  assertOptionalResourceObject(body, "input", "Task");
  assertOptionalResourceObject(body, "metadata", "Task");
  const mappings = {
    boardId: "board_id",
    repositoryId: "repository_id",
    pullRequestUrl: "pr_url",
    dependsOn: "depends_on",
    createdFrom: "created_from",
    scheduledAt: "scheduled_at",
  } as const;
  for (const [external, internal] of Object.entries(mappings)) {
    if (body[external] !== undefined) body[internal] = body[external];
    delete body[external];
  }
}

function rejectTaskAssignmentFields(body: Record<string, unknown>): void {
  if (body.assigned_to !== undefined || body.agent_id !== undefined || body.assignee_identity_type !== undefined) {
    throw new HTTPException(400, { message: "Assign the Task by patching its assignedTo field" });
  }
}

function normalizeTaskValues(body: Record<string, unknown>): void {
  if (body.input !== undefined && body.input !== null && typeof body.input !== "object") {
    throw new HTTPException(400, { message: "input must be a JSON object or null" });
  }
  if (body.metadata !== undefined && body.metadata !== null && (typeof body.metadata !== "object" || Array.isArray(body.metadata))) {
    throw new HTTPException(400, { message: "metadata must be a JSON object or null" });
  }
  if (body.metadata && typeof body.metadata === "object") {
    const metadata = body.metadata as Record<string, unknown>;
    if (Object.keys(metadata).some((key) => key.startsWith("agent-kanban.dev/"))) {
      throw new HTTPException(422, { message: "Agent Kanban Task execution metadata is read-only" });
    }
    if (Object.hasOwn(metadata, "annotations")) {
      const annotations = metadata.annotations;
      if (!annotations || typeof annotations !== "object" || Array.isArray(annotations)) {
        throw new HTTPException(422, { message: "Task metadata.annotations must be an object" });
      }
      if (Object.keys(annotations).some((key) => key.startsWith("agent-kanban.dev/"))) {
        throw new HTTPException(422, { message: "Agent Kanban Task execution annotations are read-only" });
      }
    }
  }
  if (body.scheduled_at !== undefined && body.scheduled_at !== null) {
    throw new HTTPException(422, {
      message: "Delayed task scheduling is not implemented. Omit scheduledAt to create an unscheduled Task; use null to clear an existing schedule.",
    });
  }
}
