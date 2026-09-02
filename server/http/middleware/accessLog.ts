import type { Env } from "@server/env";
import type { Context, Next } from "hono";

interface AccessLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createAccessLogMiddleware(logger: AccessLogger) {
  return async function accessLogMiddleware(c: Context<{ Bindings: Env }>, next: Next): Promise<void> {
    const start = Date.now();
    await next();

    const status = c.res.status;
    const fields: Record<string, unknown> = {
      method: c.req.method,
      path: c.req.path,
      status,
      duration_ms: Date.now() - start,
      request_id: c.get("requestId"),
      trace_id: c.get("traceId"),
      span_id: c.get("spanId"),
      result: status >= 500 ? "server_error" : status >= 400 ? "client_error" : "success",
      ...(status >= 500 ? errorDiagnosticFields(c.get("requestError")) : {}),
    };

    if (status >= 500) logger.error("request completed", fields);
    else if (status >= 400) logger.warn("request completed", fields);
    else logger.info("request completed", fields);
  };
}

function errorDiagnosticFields(error: Error | undefined): Record<string, unknown> {
  if (!error) return {};
  const kind = "kind" in error && typeof error.kind === "string" ? error.kind : undefined;
  return {
    error_name: error.name,
    error_kind: kind,
    error_message: error.message,
    error_stack: error.stack,
    error_cause: serializeCause(error.cause),
  };
}

function serializeCause(cause: unknown, seen = new Set<Error>()): unknown {
  if (!(cause instanceof Error)) return cause === undefined ? undefined : String(cause);
  if (seen.has(cause)) return { name: cause.name, message: cause.message, circular: true };
  seen.add(cause);
  const kind = "kind" in cause && typeof cause.kind === "string" ? cause.kind : undefined;
  return {
    name: cause.name,
    kind,
    message: cause.message,
    stack: cause.stack,
    cause: serializeCause(cause.cause, seen),
  };
}
