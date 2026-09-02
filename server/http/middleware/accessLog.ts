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
      ...c.get("requestError"),
    };

    if (status >= 500) logger.error("request completed", fields);
    else if (status >= 400) logger.warn("request completed", fields);
    else logger.info("request completed", fields);
  };
}
