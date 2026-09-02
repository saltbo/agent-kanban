import { AmaProjectionError } from "@server/adapters/agency/resourceProjections";
import { ResourceIdempotencyConflict, ResourceIdempotencyReplay } from "@server/adapters/d1/resourceIdempotency";
import { RealmrootDelegationFailure } from "@server/adapters/realmroot/delegatedAmaToken";
import { replayResponse } from "@server/http/middleware/idempotency";
import { applyRequestIdHeader } from "@server/http/middleware/requestContext";
import { isPublishedV2Operation, v2Problem } from "@server/http/middleware/v2Contract";
import { AmaProjectInitializationBusy } from "@server/usecases/ama/ensureAmaProject";
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";

export const apiErrorHandler: ErrorHandler = (error, c) => {
  applyRequestIdHeader(c);
  const published = isPublishedV2Operation(c.req.method, c.req.path);
  if (error instanceof ResourceIdempotencyReplay) return replayResponse(error.response);
  if (error instanceof ResourceIdempotencyConflict) {
    return v2Problem(c, 409, "idempotency-key-conflict", "Idempotency key conflict", error.message);
  }
  if (error instanceof RealmrootDelegationFailure) {
    const status = error.status === 401 || error.status === 403 || error.status === 502 || error.status === 503 ? error.status : 502;
    return v2Problem(
      c,
      status,
      status === 401 || status === 403 ? "delegation-denied" : "delegation-unavailable",
      status === 401 || status === 403 ? "Delegation denied" : "Realmroot delegation unavailable",
      error.message,
    );
  }
  if (error instanceof AmaProjectInitializationBusy) {
    c.header("Retry-After", "1");
    return v2Problem(c, 503, "ama-initialization-busy", "AMA initialization in progress", error.message);
  }
  if (error instanceof AmaProjectionError) {
    const status =
      error.status === 404
        ? 404
        : error.status === 401 || error.status === 403
          ? 403
          : error.status === 409 || error.status === 422
            ? 409
            : error.status === 502
              ? 502
              : 503;
    return v2Problem(c, status, "ama-projection-failed", status === 503 ? "AMA unavailable" : "AMA projection failed", error.message);
  }
  if (error instanceof HTTPException) {
    if (published) {
      const title = error.status === 404 ? "Resource not found" : error.status === 403 ? "Permission denied" : "Request rejected";
      return v2Problem(c, error.status, "request-rejected", title, error.message);
    }
    return c.json({ error: { code: error.message, message: error.message } }, error.status);
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  c.set("requestError", {
    error_name: error.name,
    error_message: error.message,
    error_stack: error.stack,
    error_cause: cause instanceof Error ? cause.message : cause === undefined ? undefined : String(cause),
  });
  if (published) {
    const invalidJson = error instanceof SyntaxError;
    return v2Problem(
      c,
      invalidJson ? 400 : 500,
      invalidJson ? "invalid-json" : "internal-error",
      invalidJson ? "Invalid JSON" : "Internal server error",
      invalidJson ? "The request body must be valid JSON" : "The server could not complete the request",
    );
  }
  return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
};
