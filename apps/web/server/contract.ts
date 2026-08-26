import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "./types";

export const API_VERSION = "2026-08-22";
export const MAX_PAGE_SIZE = 100;

export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly title: string,
    readonly detail: string,
    readonly errors?: Array<{ pointer: string; detail: string }>,
  ) {
    super(detail);
  }
}

export function problem(c: Context, value: ApiProblem): Response {
  return c.json(
    {
      type: `https://agent-kanban.dev/problems/${value.type}`,
      title: value.title,
      status: value.status,
      detail: value.detail,
      instance: `urn:request:${c.get("requestId")}`,
      ...(value.errors ? { errors: value.errors } : {}),
    },
    value.status as 400,
    { "Content-Type": "application/problem+json" },
  );
}

export const contractMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  const incomingTrace = c.req.header("traceparent");
  const traceparent = incomingTrace && /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/.test(incomingTrace) ? incomingTrace : newTraceparent();
  c.set("traceparent", traceparent);
  const tracestate = c.req.header("tracestate");
  if (incomingTrace === traceparent && tracestate && tracestate.length <= 512 && /^[\x20-\x7e]+$/.test(tracestate)) c.set("tracestate", tracestate);
  const started = Date.now();
  let failure: { classification: string; cause?: string } | undefined;
  try {
    await next();
  } catch (error) {
    c.res =
      error instanceof ApiProblem
        ? problem(c, error)
        : problem(c, new ApiProblem(500, "internal", "Internal Server Error", "The request failed unexpectedly."));
    failure =
      error instanceof ApiProblem
        ? { classification: error.type }
        : { classification: "unexpected", cause: error instanceof Error ? error.message : String(error) };
  } finally {
    c.header("Request-Id", requestId);
    const mappedFailure = c.get("failureClassification")
      ? { classification: c.get("failureClassification"), ...(c.get("failureCause") ? { cause: c.get("failureCause") } : {}) }
      : undefined;
    const effectiveFailure = failure ?? mappedFailure;
    const entry = {
      event: "request.completed",
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - started,
      ...(effectiveFailure ? { failure: effectiveFailure } : {}),
    };
    if (effectiveFailure?.classification === "unexpected") console.error(JSON.stringify(entry));
    else console.log(JSON.stringify(entry));
  }
};

function newTraceparent(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `00-${hex.slice(0, 32)}-${hex.slice(32)}-01`;
}

export const apiVersionMiddleware: MiddlewareHandler = async (c, next) => {
  const version = c.req.header("api-version");
  if (!version) throw new ApiProblem(400, "api-version-required", "API Version Required", `API-Version: ${API_VERSION} is required.`);
  if (version !== API_VERSION)
    throw new ApiProblem(400, "api-version-unsupported", "Unsupported API Version", `Supported API-Version is ${API_VERSION}.`);
  c.header("API-Version", API_VERSION);
  c.header("Vary", appendVary(c.res.headers.get("Vary"), "API-Version"));
  await next();
};

function appendVary(existing: string | null, value: string): string {
  const values = new Set(
    (existing ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  values.add(value);
  return [...values].join(", ");
}

export async function jsonObject(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type")?.split(";", 1)[0];
  if (contentType !== "application/json" && contentType !== "application/merge-patch+json") {
    throw new ApiProblem(415, "unsupported-media-type", "Unsupported Media Type", "A JSON request body is required.");
  }
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiProblem(400, "invalid-json", "Invalid Request", "The request body must be a JSON object.");
  return body as Record<string, unknown>;
}

export function requiredString(body: Record<string, unknown>, name: string, max = 4096): string {
  const value = body[name];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new ApiProblem(422, "validation", "Validation Failed", "The request has invalid fields.", [
      { pointer: `#/body/${name}`, detail: `${name} must be a non-empty string of at most ${max} characters.` },
    ]);
  }
  return value.trim();
}

export function optionalString(body: Record<string, unknown>, name: string, max = 16384): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max)
    throw new ApiProblem(422, "validation", "Validation Failed", "The request has invalid fields.", [
      { pointer: `#/body/${name}`, detail: `${name} must be a string of at most ${max} characters.` },
    ]);
  return value;
}

export function requireIfMatch(c: Context, version: number): void {
  const expected = `"${version}"`;
  const supplied = c.req.header("if-match");
  if (!supplied) throw new ApiProblem(428, "precondition-required", "Precondition Required", "If-Match is required for this resource.");
  if (supplied !== expected) throw new ApiProblem(412, "precondition-failed", "Precondition Failed", "The resource has changed.");
}

export function etag(version: number): string {
  return `"${version}"`;
}

export type Cursor = { createdAt: string; id: string };

export async function pageRequest(c: Context<{ Bindings: Env }>): Promise<{ pageSize: number; cursor?: Cursor; queryFingerprint: string }> {
  const rawSize = c.req.query("pageSize");
  const pageSize = rawSize === undefined ? 50 : Number(rawSize);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE)
    throw new ApiProblem(400, "invalid-page-size", "Invalid Page Size", `pageSize must be between 1 and ${MAX_PAGE_SIZE}.`);
  const token = c.req.query("pageToken");
  const queryFingerprint = await cursorFingerprint(c);
  if (!token) return { pageSize, queryFingerprint };
  const tokenHash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    "SELECT cursor_created_at, cursor_id, tenant_id, api_version, query_fingerprint FROM pagination_snapshots WHERE token_hash = ? AND expires_at > datetime('now')",
  )
    .bind(tokenHash)
    .first<{ cursor_created_at: string; cursor_id: string; tenant_id: string; api_version: string; query_fingerprint: string }>();
  if (!row || row.tenant_id !== c.get("principal").tenantId || row.api_version !== API_VERSION || row.query_fingerprint !== queryFingerprint)
    throw new ApiProblem(400, "invalid-page-token", "Invalid Page Token", "pageToken is invalid, expired, or belongs to another query.");
  return { pageSize, queryFingerprint, cursor: { createdAt: row.cursor_created_at, id: row.cursor_id } };
}

export async function pageResponse<T extends { id: string; created_at?: string; createdAt?: string }>(
  c: Context<{ Bindings: Env }>,
  rows: T[],
  pageSize: number,
  queryFingerprint: string,
): Promise<{ items: T[]; pagination: { pageSize: number; nextPageToken?: string } }> {
  const hasNext = rows.length > pageSize;
  const items = hasNext ? rows.slice(0, pageSize) : rows;
  const last = items.at(-1);
  let nextPageToken: string | undefined;
  if (hasNext && last) {
    const cursorCreatedAt = last.created_at ?? last.createdAt;
    if (!cursorCreatedAt) throw new Error("Paginated resource has no creation timestamp");
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    nextPageToken = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await c.env.DB.prepare(
      "INSERT INTO pagination_snapshots (token_hash, tenant_id, api_version, query_fingerprint, cursor_created_at, cursor_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+15 minutes'))",
    )
      .bind(await sha256Hex(nextPageToken), c.get("principal").tenantId, API_VERSION, queryFingerprint, cursorCreatedAt, last.id)
      .run();
  }
  if (nextPageToken) {
    const next = new URL(c.req.url);
    next.searchParams.set("pageToken", nextPageToken);
    next.searchParams.set("pageSize", String(pageSize));
    c.header("Link", `<${next.toString()}>; rel="next"`);
  }
  return { items, pagination: { pageSize, ...(nextPageToken ? { nextPageToken } : {}) } };
}

async function cursorFingerprint(c: Context): Promise<string> {
  const url = new URL(c.req.url);
  url.searchParams.delete("pageToken");
  url.searchParams.delete("pageSize");
  url.searchParams.sort();
  return sha256Hex(`${API_VERSION}\0${c.req.path}\0${url.searchParams.toString()}`);
}

export async function requestHash(c: Context, body: unknown): Promise<string> {
  const canonical = JSON.stringify({ apiVersion: API_VERSION, method: c.req.method, path: c.req.path, body });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function idempotentCreate<T>(
  c: Context<{ Bindings: Env }>,
  body: unknown,
  idPrefix: string,
  create: (resourceId: string) => Promise<{ status: number; value: T; location: string }>,
  recover: (resourceId: string) => Promise<{ status: number; value: T; location: string } | null>,
): Promise<Response> {
  const key = c.req.header("idempotency-key");
  if (!key || key.length > 160)
    throw new ApiProblem(400, "idempotency-key-required", "Idempotency Key Required", "A valid Idempotency-Key header is required.");
  const tenantId = c.get("principal").tenantId;
  const hash = await requestHash(c, body);
  const resourceId = `${idPrefix}_${(await sha256Hex(`${tenantId}\0${c.req.path}\0${key}`)).slice(0, 24)}`;
  const claimed = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO idempotency_records (tenant_id, key, method, path, request_hash, resource_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+24 hours'))",
  )
    .bind(tenantId, key, c.req.method, c.req.path, hash, resourceId)
    .run();
  let reclaiming = false;
  if ((claimed.meta.changes ?? 0) === 0) {
    const existing = await c.env.DB.prepare(
      "SELECT request_hash, resource_id, status, response_json, location, updated_at FROM idempotency_records WHERE tenant_id = ? AND key = ? AND expires_at > datetime('now')",
    )
      .bind(tenantId, key)
      .first<{ request_hash: string; resource_id: string; status: number; response_json: string; location: string | null; updated_at: string }>();
    if (!existing)
      throw new ApiProblem(409, "idempotency-expired", "Idempotency Retry Required", "The idempotency record expired; retry with a new key.");
    if (existing.request_hash !== hash)
      throw new ApiProblem(409, "idempotency-conflict", "Idempotency Conflict", "The Idempotency-Key was already used for a different request.");
    if (existing.status === 0) {
      const stale = Date.parse(`${existing.updated_at.replace(" ", "T")}Z`) <= Date.now() - 5 * 60_000;
      if (!stale) {
        c.header("Retry-After", "1");
        throw new ApiProblem(409, "idempotency-in-progress", "Request In Progress", "A request with this Idempotency-Key is still in progress.");
      }
      const reclaimed = await c.env.DB.prepare(
        "UPDATE idempotency_records SET updated_at = datetime('now') WHERE tenant_id = ? AND key = ? AND status = 0 AND updated_at = ?",
      )
        .bind(tenantId, key, existing.updated_at)
        .run();
      if ((reclaimed.meta.changes ?? 0) !== 1) {
        c.header("Retry-After", "1");
        throw new ApiProblem(409, "idempotency-in-progress", "Request In Progress", "Another request recovered this Idempotency-Key.");
      }
      reclaiming = true;
    } else {
      return c.json(
        JSON.parse(existing.response_json),
        existing.status as 200,
        existing.location ? { Location: existing.location, "Idempotency-Replayed": "true" } : { "Idempotency-Replayed": "true" },
      );
    }
  }
  if (reclaiming) {
    const recovered = await recover(resourceId);
    if (recovered) return completeIdempotentCreate(c, tenantId, key, recovered, true);
  }
  try {
    const result = await create(resourceId);
    return await completeIdempotentCreate(c, tenantId, key, result, false);
  } catch (error) {
    const recovered = await recover(resourceId);
    if (recovered) return completeIdempotentCreate(c, tenantId, key, recovered, true);
    await c.env.DB.prepare("DELETE FROM idempotency_records WHERE tenant_id = ? AND key = ? AND status = 0").bind(tenantId, key).run();
    throw error;
  }
}

async function completeIdempotentCreate<T>(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  key: string,
  result: { status: number; value: T; location: string },
  replayed: boolean,
): Promise<Response> {
  const completed = await c.env.DB.prepare(
    "UPDATE idempotency_records SET status = ?, response_json = ?, location = ?, updated_at = datetime('now') WHERE tenant_id = ? AND key = ? AND status = 0",
  )
    .bind(result.status, JSON.stringify(result.value), result.location, tenantId, key)
    .run();
  if ((completed.meta.changes ?? 0) !== 1)
    throw new ApiProblem(409, "idempotency-lost", "Idempotency State Changed", "The idempotency record changed before the response was committed.");
  return c.json(result.value, result.status as 201, {
    Location: result.location,
    ...(replayed ? { "Idempotency-Replayed": "true" } : {}),
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonical(c: Context, path: string): string {
  const configuredOrigin = "AK_PUBLIC_ORIGIN" in c.env && typeof c.env.AK_PUBLIC_ORIGIN === "string" ? c.env.AK_PUBLIC_ORIGIN : undefined;
  const resourceOrigin = "AK_RESOURCE" in c.env && typeof c.env.AK_RESOURCE === "string" ? c.env.AK_RESOURCE : undefined;
  return new URL(path, configuredOrigin || resourceOrigin || c.req.url).toString();
}
