import {
  completeIdempotency,
  type ResourceIdempotency,
  ResourceIdempotencyReplay,
  resolveIdempotentResponse,
} from "@server/adapters/d1/resourceIdempotency";
import type { Env } from "@server/env";
import { v2Problem } from "@server/http/middleware/v2Contract";
import type { TaskActionWriteActorType } from "@shared";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

type ApiContext = Context<{ Bindings: Env }>;

export function isResourcePrincipal(c: ApiContext): boolean {
  return c.get("principal")?.source === "token";
}

export function resolveActor(c: ApiContext): { actorType: TaskActionWriteActorType; actorId: string; sessionId: null } {
  const identity = c.get("identityType") || "user";
  if (identity !== "user" && identity !== "realmroot:agent") {
    throw new HTTPException(403, { message: "User or Agent identity is required" });
  }
  const actorId = identity === "user" ? c.get("ownerId") : c.get("principal")?.actorId;
  if (!actorId) throw new HTTPException(403, { message: "Actor identity is required" });
  return { actorType: identity, actorId, sessionId: null };
}

export function assertResourceWriteFields(
  body: unknown,
  allowed: ReadonlySet<string>,
  resourceName: string,
): asserts body is Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HTTPException(422, { message: `${resourceName} must be a JSON object` });
  }
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new HTTPException(422, { message: `${resourceName} contains unsupported properties: ${unknown.join(", ")}` });
  }
}

export function assertRequiredResourceString(body: Record<string, unknown>, field: string, resourceName: string): void {
  if (typeof body[field] !== "string" || body[field].length === 0) {
    throw new HTTPException(422, { message: `${resourceName}.${field} must be a non-empty string` });
  }
}

export function assertOptionalResourceString(body: Record<string, unknown>, field: string, resourceName: string): void {
  if (body[field] !== undefined && typeof body[field] !== "string") {
    throw new HTTPException(422, { message: `${resourceName}.${field} must be a string` });
  }
}

export function assertOptionalResourceStringArray(body: Record<string, unknown>, field: string, resourceName: string): void {
  const value = body[field];
  if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
    throw new HTTPException(422, { message: `${resourceName}.${field} must be an array of strings` });
  }
}

export function assertOptionalResourceObject(body: Record<string, unknown>, field: string, resourceName: string): void {
  const value = body[field];
  if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) {
    throw new HTTPException(422, { message: `${resourceName}.${field} must be a JSON object or null` });
  }
}

export async function rejectRequestBody(c: ApiContext, resourceName: string): Promise<Response | null> {
  if ((await c.req.raw.clone().arrayBuffer()).byteLength === 0) return null;
  return v2Problem(c, 400, "request-body-not-allowed", "Request body not allowed", `${resourceName} has no client-writable representation`);
}

export function setCreatedResourceHeaders(c: ApiContext, collection: string, id: string, version: string): void {
  c.header("Location", new URL(`/api/${collection}/${encodeURIComponent(id)}`, c.req.url).toString());
  c.header("ETag", `"${version}"`);
}

export function externalCreationIdempotencyKey(c: ApiContext): string {
  const idempotency = c.get("resourceIdempotency");
  if (!idempotency) throw new Error("External creation requires idempotency middleware");
  return idempotency.upstreamKey;
}

export function resourceIdempotencyFor<T extends { id: string }>(
  c: ApiContext,
  collection: string,
  versionOf: (resource: T) => string,
  represent: (resource: T) => unknown,
): ResourceIdempotency<T> | undefined {
  const idempotency = c.get("resourceIdempotency");
  if (!idempotency) return undefined;
  return {
    ...idempotency,
    responseFor: (resource) => {
      const id = resource.id;
      return {
        status: 201,
        body: JSON.stringify(represent(resource)),
        contentType: "application/json; charset=UTF-8",
        location: new URL(`/api/${collection}/${encodeURIComponent(id)}`, c.req.url).toString(),
        etag: `"${versionOf(resource)}"`,
      };
    },
  };
}

export async function readJsonBody<T>(c: ApiContext): Promise<T | Response> {
  if (isResourcePrincipal(c) && c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return v2Problem(c, 415, "unsupported-media-type", "Unsupported media type", "Content-Type must be application/json");
  }
  try {
    return await c.req.json<T>();
  } catch {
    if (isResourcePrincipal(c)) {
      return v2Problem(c, 400, "invalid-json", "Invalid JSON", "The request body must be valid JSON");
    }
    throw new HTTPException(400, { message: "The request body must be valid JSON" });
  }
}

export async function completeExternalCreation(
  c: ApiContext,
  collection: string,
  resourceId: string,
  version: string,
  responseBody: unknown,
): Promise<void> {
  const idempotency = c.get("resourceIdempotency");
  if (!idempotency) return;
  const location = new URL(`/api/${collection}/${encodeURIComponent(resourceId)}`, c.req.url).toString();
  const etag = `"${version}"`;
  const completed = {
    ...idempotency,
    responseFor: () => ({
      status: 201,
      body: JSON.stringify(responseBody),
      contentType: "application/json; charset=UTF-8",
      location,
      etag,
    }),
  };
  try {
    await c.env.DB.batch([completeIdempotency(c.env.DB, completed, resourceId, responseBody)]);
  } catch (error) {
    const winner = await resolveIdempotentResponse(c.env.DB, idempotency);
    if (winner) throw new ResourceIdempotencyReplay(winner);
    throw error;
  }
}
