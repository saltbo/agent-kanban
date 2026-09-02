import type { PageWindow } from "@server/domain/pagination";
import type { Env } from "@server/env";
import { effectiveApiVersion, v2Problem } from "@server/http/middleware/v2Contract";
import { assertSigningKey, base64UrlDecode, base64UrlEncode, constantTimeEqual, signTokenPayload } from "@server/http/resource-server/signedToken";
import type { Context } from "hono";

interface PageToken {
  version: 1;
  context: string;
  snapshot: string;
  afterCreatedAt: string;
  afterId: string;
  tenantId: string;
  actorId: string;
  apiVersion: string;
  expiresAt: number;
}

export async function readPageWindow(c: Context<{ Bindings: Env }>): Promise<PageWindow | Response> {
  const rawPageSize = c.req.query("pageSize");
  const pageSize = rawPageSize === undefined ? 50 : Number(rawPageSize);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return v2Problem(c, 400, "invalid-pagination", "Invalid pagination", "pageSize must be an integer from 1 through 100");
  }
  const rawToken = c.req.query("pageToken");
  if (!rawToken) return { pageSize, snapshot: new Date().toISOString(), afterCreatedAt: null, afterId: null };
  const token = await decodePageToken(rawToken, c.env.AK_SIGNING_KEY);
  const principal = c.get("principal");
  const actorId = principal.actorId ?? principal.subjectId;
  if (
    !token ||
    token.context !== pageContext(c.req.url) ||
    token.tenantId !== c.get("ownerId") ||
    token.actorId !== actorId ||
    token.apiVersion !== effectiveApiVersion(c) ||
    token.expiresAt <= Date.now()
  ) {
    return v2Problem(c, 400, "invalid-pagination", "Invalid pagination", "pageToken does not belong to this collection and filter set");
  }
  return { pageSize, snapshot: token.snapshot, afterCreatedAt: token.afterCreatedAt, afterId: token.afterId };
}

export async function pageResponse<T extends { id: string; created_at: string }>(
  c: Context<{ Bindings: Env }>,
  rows: T[],
  window: PageWindow,
  serialize: (row: T, requestUrl: string) => unknown,
): Promise<Response> {
  const hasMore = rows.length > window.pageSize;
  const page = rows.slice(0, window.pageSize);
  const body: { items: unknown[]; pagination: { pageSize: number; nextPageToken?: string } } = {
    items: page.map((row) => serialize(row, c.req.url)),
    pagination: { pageSize: page.length },
  };
  if (hasMore) {
    const last = page.at(-1)!;
    const principal = c.get("principal");
    body.pagination.nextPageToken = await encodePageToken(
      {
        version: 1,
        context: pageContext(c.req.url),
        snapshot: window.snapshot,
        afterCreatedAt: last.created_at,
        afterId: last.id,
        tenantId: c.get("ownerId"),
        actorId: principal.actorId ?? principal.subjectId,
        apiVersion: effectiveApiVersion(c),
        expiresAt: Date.now() + 15 * 60_000,
      },
      c.env.AK_SIGNING_KEY,
    );
    const next = new URL(c.req.url);
    next.searchParams.set("pageSize", String(window.pageSize));
    next.searchParams.set("pageToken", body.pagination.nextPageToken);
    c.header("Link", `<${next.toString()}>; rel="next"`);
  }
  return c.json(body);
}

function pageContext(requestUrl: string): string {
  const url = new URL(requestUrl);
  url.searchParams.delete("pageSize");
  url.searchParams.delete("pageToken");
  url.searchParams.sort();
  return `${url.pathname}?${url.searchParams.toString()}`;
}

async function encodePageToken(token: PageToken, secret: string): Promise<string> {
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(token)));
  return `${payload}.${await sign(payload, secret)}`;
}

async function decodePageToken(value: string, secret: string): Promise<PageToken | null> {
  assertSigningKey(secret);
  try {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra !== undefined || !constantTimeEqual(signature, await sign(payload, secret))) return null;
    const bytes = base64UrlDecode(payload);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<PageToken>;
    if (
      parsed.version !== 1 ||
      typeof parsed.context !== "string" ||
      typeof parsed.snapshot !== "string" ||
      typeof parsed.afterCreatedAt !== "string" ||
      typeof parsed.afterId !== "string" ||
      typeof parsed.tenantId !== "string" ||
      typeof parsed.actorId !== "string" ||
      typeof parsed.apiVersion !== "string" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    return parsed as PageToken;
  } catch {
    return null;
  }
}

async function sign(payload: string, secret: string): Promise<string> {
  return signTokenPayload(payload, secret);
}
