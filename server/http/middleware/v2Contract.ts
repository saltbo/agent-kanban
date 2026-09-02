import type { Env } from "@server/env";
import { V2_API_VERSION as SHARED_V2_API_VERSION } from "@shared";
import type { Context, Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const V2_API_VERSION = SHARED_V2_API_VERSION;

export function isPublishedV2Operation(method: string, path: string): boolean {
  if (/^\/api\/task-(?:claims|assignments|cancellations|events|review-submissions|review-rejections|review-completions)(?:\/|$)/.test(path)) {
    return true;
  }
  if (path === "/api/boards") return method === "GET" || method === "POST";
  if (/^\/api\/boards\/[^/]+$/.test(path)) return method === "GET";
  if (path === "/api/repositories") return method === "GET" || method === "POST";
  if (/^\/api\/repositories\/[^/]+$/.test(path)) return method === "GET";
  if (path === "/api/agents") return method === "GET" || method === "POST";
  if (/^\/api\/agents\/[^/]+$/.test(path)) return method === "GET";
  if (path === "/api/machines") return method === "GET" || method === "POST";
  if (/^\/api\/machines\/[^/]+$/.test(path)) return method === "GET" || method === "DELETE";
  if (path === "/api/tasks") return method === "GET" || method === "POST";
  if (/^\/api\/tasks\/[^/]+$/.test(path)) return method === "GET";
  if (/^\/api\/tasks\/[^/]+\/notes$/.test(path)) return method === "GET" || method === "POST";
  if (/^\/api\/tasks\/[^/]+\/notes\/[^/]+$/.test(path)) return method === "GET";
  return false;
}

export async function v2ApiVersionMiddleware(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | undefined> {
  const requestedVersion = c.req.header("API-Version");
  if (requestedVersion !== undefined && requestedVersion !== V2_API_VERSION) {
    return v2Problem(c, 400, "invalid-api-version", "Invalid API version", `Unsupported API-Version: ${requestedVersion}`);
  }
  c.header("API-Version", V2_API_VERSION);
  c.header("Vary", "API-Version");
  await next();
  return undefined;
}

export function effectiveApiVersion(c: Context): string {
  return c.req.header("API-Version") ?? V2_API_VERSION;
}

export function v2Problem(c: Context<{ Bindings: Env }>, status: ContentfulStatusCode, type: string, title: string, detail: string): Response {
  return c.json(
    {
      type: new URL(`/api/problems/${type}`, c.req.url).toString(),
      title,
      status,
      detail,
      instance: `urn:request:${c.get("requestId")}`,
    },
    status,
    { "Content-Type": "application/problem+json", "API-Version": V2_API_VERSION, Vary: "API-Version" },
  );
}
