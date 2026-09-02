import {
  deleteExpiredIdempotencyRecords,
  type IdempotentHttpResponse,
  type ResourceIdempotency,
  ResourceIdempotencyConflict,
  ResourceIdempotencyReplay,
  resolveIdempotentResponse,
} from "@server/adapters/d1/resourceIdempotency";
import type { Env } from "@server/env";
import { apiErrorHandler } from "@server/http/middleware/errorHandler";
import { effectiveApiVersion, v2Problem } from "@server/http/middleware/v2Contract";
import type { Context, ErrorHandler, Next } from "hono";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;

export async function idempotencyMiddleware(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | undefined> {
  const principal = c.get("principal");
  const resourceKind = creationResourceKind(c.req.method, c.req.path);
  const browserProjectionCreation = principal.source === "session" && (resourceKind === "agent" || resourceKind === "machine");
  if (!resourceKind || (principal.source !== "token" && !browserProjectionCreation)) {
    await next();
    return undefined;
  }

  const key = c.req.header("idempotency-key");
  if (!key) return v2Problem(c, 428, "idempotency-key-required", "Idempotency key required", "Idempotency-Key is required for this creation");
  if (!IDEMPOTENCY_KEY.test(key)) {
    return v2Problem(c, 400, "invalid-idempotency-key", "Invalid idempotency key", "Idempotency-Key must contain 8 to 200 safe characters");
  }

  const actorId = principal.actorId ?? principal.subjectId;
  const ownerId = c.get("ownerId");
  const apiVersion = effectiveApiVersion(c);
  const requestHash = await hashRequest(
    actorId,
    apiVersion,
    c.req.method,
    c.req.path,
    c.req.header("content-type") ?? "",
    await c.req.raw.clone().arrayBuffer(),
  );
  const idempotency: ResourceIdempotency = {
    ownerId,
    actorId,
    apiVersion,
    key,
    method: c.req.method,
    path: c.req.path,
    requestHash,
    upstreamKey: await hashUpstreamKey(ownerId, actorId, apiVersion, c.req.method, c.req.path, key),
    resourceKind,
  };

  await deleteExpiredIdempotencyRecords(c.env.DB);
  try {
    const replay = await resolveIdempotentResponse(c.env.DB, idempotency);
    if (replay) return replayResponse(replay);
  } catch (error) {
    if (error instanceof ResourceIdempotencyConflict) {
      return v2Problem(c, 409, "idempotency-key-conflict", "Idempotency key conflict", error.message);
    }
    throw error;
  }
  c.set("resourceIdempotency", idempotency);
  await next();
  return undefined;
}

export const resourceServerErrorHandler: ErrorHandler = (error, c) => {
  if (error instanceof ResourceIdempotencyReplay) return replayResponse(error.response);
  if (error instanceof ResourceIdempotencyConflict) {
    return v2Problem(c, 409, "idempotency-key-conflict", "Idempotency key conflict", error.message);
  }
  return apiErrorHandler(error, c);
};

async function hashUpstreamKey(ownerId: string, actorId: string, apiVersion: string, method: string, path: string, key: string): Promise<string> {
  const input = new TextEncoder().encode(`${ownerId}\n${actorId}\n${apiVersion}\n${method}\n${path}\n${key}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `ak-${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function replayResponse(response: IdempotentHttpResponse): Response {
  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": response.contentType,
      Location: response.location,
      ETag: response.etag,
      "Idempotency-Replayed": "true",
    },
  });
}

function creationResourceKind(method: string, path: string): string | null {
  if (method !== "POST") return null;
  if (path === "/api/boards") return "board";
  if (path === "/api/repositories") return "repository";
  if (path === "/api/tasks") return "task";
  if (path === "/api/agents") return "agent";
  if (path === "/api/machines") return "machine";
  if (/^\/api\/tasks\/[^/]+\/notes$/.test(path)) return "task-note";
  return null;
}

async function hashRequest(
  actorId: string,
  apiVersion: string,
  method: string,
  path: string,
  contentType: string,
  bodyBuffer: ArrayBuffer,
): Promise<string> {
  const body = new Uint8Array(bodyBuffer);
  const prefix = new TextEncoder().encode(`${actorId}\n${apiVersion}\n${method}\n${path}\n${contentType}\n`);
  const bytes = new Uint8Array(prefix.length + body.length);
  bytes.set(prefix);
  bytes.set(body, prefix.length);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
