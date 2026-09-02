import type { Env } from "@server/env";
import type { Context, Next } from "hono";

export async function requestContextMiddleware(c: Context<{ Bindings: Env }>, next: Next): Promise<void> {
  const requestId = crypto.randomUUID();
  const incoming = parseTraceparent(c.req.header("traceparent"));
  const traceId = incoming?.traceId ?? randomHex(16);
  const spanId = randomHex(8);
  const traceparent = `00-${traceId}-${spanId}-${incoming?.flags ?? "01"}`;

  c.set("requestId", requestId);
  c.set("traceId", traceId);
  c.set("spanId", spanId);
  c.set("traceparent", traceparent);
  applyRequestIdHeader(c);
  await next();
  applyRequestIdHeader(c);
}

export function applyRequestIdHeader(c: Context<{ Bindings: Env }>): void {
  c.header("Request-Id", c.get("requestId"));
  c.header("traceparent", c.get("traceparent"));
}

function parseTraceparent(value: string | undefined): { traceId: string; flags: string } | null {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec(value ?? "");
  if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return null;
  return { traceId: match[1]!.toLowerCase(), flags: match[3]!.toLowerCase() };
}

function randomHex(byteLength: number): string {
  return [...crypto.getRandomValues(new Uint8Array(byteLength))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
