import type { Env } from "@server/env";
import { effectiveApiVersion, v2Problem } from "@server/http/middleware/v2Contract";
import { assertSigningKey, base64UrlDecode, base64UrlEncode, constantTimeEqual, signTokenPayload } from "@server/http/resource-server/signedToken";
import type { Context } from "hono";

type CursorToken = {
  version: 1;
  context: string;
  sourceCursor: string;
  tenantId: string;
  actorId: string;
  apiVersion: string;
  expiresAt: number;
};

export async function readExternalPage(c: Context<{ Bindings: Env }>): Promise<{ pageSize: number; sourceCursor: string | null } | Response> {
  const requested = c.req.query("pageSize");
  const pageSize = requested === undefined ? 50 : Number(requested);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return v2Problem(c, 400, "invalid-pagination", "Invalid pagination", "pageSize must be an integer from 1 through 100");
  }
  const raw = c.req.query("pageToken");
  if (!raw) return { pageSize, sourceCursor: null };
  const token = await decode(raw, c.env.AK_SIGNING_KEY);
  const principal = c.get("principal");
  if (
    !token ||
    token.context !== context(c.req.url) ||
    token.tenantId !== principal.tenantId ||
    token.actorId !== (principal.actorId ?? principal.subjectId) ||
    token.apiVersion !== effectiveApiVersion(c) ||
    token.expiresAt <= Date.now()
  ) {
    return v2Problem(c, 400, "invalid-pagination", "Invalid pagination", "pageToken does not belong to this collection and filter set");
  }
  return { pageSize, sourceCursor: token.sourceCursor };
}

export async function externalPageResponse<T>(c: Context<{ Bindings: Env }>, items: T[], nextSourceCursor: string | null): Promise<Response> {
  const pagination: { pageSize: number; nextPageToken?: string } = { pageSize: items.length };
  if (nextSourceCursor) {
    const principal = c.get("principal");
    pagination.nextPageToken = await encode(
      {
        version: 1,
        context: context(c.req.url),
        sourceCursor: nextSourceCursor,
        tenantId: principal.tenantId,
        actorId: principal.actorId ?? principal.subjectId,
        apiVersion: effectiveApiVersion(c),
        expiresAt: Date.now() + 15 * 60_000,
      },
      c.env.AK_SIGNING_KEY,
    );
    const next = new URL(c.req.url);
    next.searchParams.set("pageToken", pagination.nextPageToken);
    c.header("Link", `<${next}>; rel="next"`);
  }
  return c.json({ items, pagination });
}

function context(requestUrl: string): string {
  const url = new URL(requestUrl);
  url.searchParams.delete("pageSize");
  url.searchParams.delete("pageToken");
  url.searchParams.sort();
  return `${url.pathname}?${url.searchParams}`;
}

async function encode(token: CursorToken, secret: string): Promise<string> {
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(token)));
  return `${payload}.${await signTokenPayload(payload, secret)}`;
}

async function decode(value: string, secret: string): Promise<CursorToken | null> {
  assertSigningKey(secret);
  try {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra !== undefined || !constantTimeEqual(signature, await signTokenPayload(payload, secret))) return null;
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as Partial<CursorToken>;
    if (
      parsed.version !== 1 ||
      typeof parsed.context !== "string" ||
      typeof parsed.sourceCursor !== "string" ||
      typeof parsed.tenantId !== "string" ||
      typeof parsed.actorId !== "string" ||
      typeof parsed.apiVersion !== "string" ||
      typeof parsed.expiresAt !== "number"
    )
      return null;
    return parsed as CursorToken;
  } catch {
    return null;
  }
}
