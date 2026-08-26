import type { Context, Next } from "hono";
import type { Env } from "./types";

export async function metricsMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const start = Date.now();
  await next();

  const machineId = c.get("machineId");
  if (!machineId) return;

  const latencyMs = Date.now() - start;
  const point = {
    indexes: [machineId],
    blobs: [c.req.method, c.req.path, c.get("identityType") ?? "unknown"],
    doubles: [c.res.status, latencyMs],
  };
  // Hono's c.executionCtx getter throws when no ExecutionContext exists (e.g. in tests).
  // In CF Workers, waitUntil keeps the write alive after the response is sent.
  try {
    c.executionCtx.waitUntil(Promise.resolve(c.env.AE.writeDataPoint(point)));
  } catch {
    c.env.AE.writeDataPoint(point);
  }
}
