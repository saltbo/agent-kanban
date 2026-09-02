import type { Env } from "@server/env";
import { v2Problem } from "@server/http/middleware/v2Contract";
import type { Context } from "hono";

export type TaskContext = Context<{ Bindings: Env }>;

export function verifiedAgentActorId(c: TaskContext): string | null {
  const principal = c.get("principal");
  return principal.type === "agent" && principal.actorId ? principal.actorId : null;
}

export function verifiedAgentRuntimeSession(c: TaskContext): { runtime: string; sessionId: string } | null {
  const principal = c.get("principal");
  return principal.type === "agent" && principal.runtime && principal.runtimeSessionId
    ? { runtime: principal.runtime, sessionId: principal.runtimeSessionId }
    : null;
}

export function taskWorkflowActor(c: TaskContext): { type: "agent" | "human"; id: string } | null {
  const principal = c.get("principal");
  if (principal.type === "agent" && principal.actorId) return { type: "agent", id: principal.actorId };
  if (principal.type === "human") return { type: "human", id: principal.subjectId };
  return null;
}

export function actorRequired(c: TaskContext): Response {
  return v2Problem(c, 403, "permission-denied", "Permission denied", "A Realmroot human or verified Agent actor is required");
}

export function agentActorRequired(c: TaskContext): Response {
  return v2Problem(c, 403, "permission-denied", "Permission denied", "A verified Realmroot Agent actor is required");
}

export function agentRuntimeSessionRequired(c: TaskContext): Response {
  return v2Problem(
    c,
    403,
    "runtime-session-required",
    "Runtime Session required",
    "Task Claim requires verified Realmroot Remote runtime Session context",
  );
}

export function taskNotFound(c: TaskContext, detail: string): Response {
  return v2Problem(c, 404, "task-not-found", "Task not found", detail);
}

export function mediaType(c: TaskContext): string | undefined {
  return c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

export function resourceLocation(c: TaskContext, collection: string, taskId: string): string {
  return new URL(`/api/${collection}/${encodeURIComponent(taskId)}`, c.req.url).toString();
}

export function readStrongVersionPrecondition(c: TaskContext, resourceName: string): string | Response {
  const value = c.req.header("if-match");
  if (!value) {
    return v2Problem(c, 428, "precondition-required", "Precondition required", `If-Match must contain the current ${resourceName} ETag`);
  }
  const match = /^"([^"\\]{1,200})"$/.exec(value);
  if (!match) {
    return v2Problem(c, 400, "invalid-precondition", "Invalid precondition", `If-Match must contain one strong ${resourceName} ETag`);
  }
  return match[1]!;
}

export async function rejectNonEmptyRepresentation(c: TaskContext, type: string, title: string, detail: string): Promise<Response | null> {
  if (c.req.raw.body === null) return null;
  const contentType = mediaType(c);
  if (!contentType) {
    return (await c.req.text()).length === 0
      ? null
      : v2Problem(c, 415, "unsupported-media-type", "Unsupported media type", "Content-Type must be application/json");
  }
  if (contentType !== "application/json") {
    return v2Problem(c, 415, "unsupported-media-type", "Unsupported media type", "Content-Type must be application/json");
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return v2Problem(c, 400, "invalid-json", "Invalid JSON", "The request body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0) {
    return v2Problem(c, 422, type, title, detail);
  }
  return null;
}
