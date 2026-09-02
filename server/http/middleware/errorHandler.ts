import { applyRequestIdHeader } from "@server/http/middleware/requestContext";
import { isPublishedV2Operation, v2Problem } from "@server/http/middleware/v2Contract";
import { AmaProjectInitializationBusy } from "@server/usecases/ama/ensureAmaProject";
import { AmaProjectionError, RealmrootDelegationFailure } from "@server/usecases/ama/failures";
import { ApplicationError } from "@server/usecases/applicationError";
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";

export const apiErrorHandler: ErrorHandler = (error, c) => {
  applyRequestIdHeader(c);
  const published = isPublishedV2Operation(c.req.method, c.req.path);
  if (error instanceof RealmrootDelegationFailure) {
    const status = delegationStatus(error.kind);
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
    const status = amaProjectionStatus(error.kind);
    return v2Problem(c, status, "ama-projection-failed", status === 503 ? "AMA unavailable" : "AMA projection failed", error.message);
  }
  if (error instanceof ApplicationError) {
    const status = applicationStatus(error.kind);
    if (published) {
      const title =
        status === 404 ? "Resource not found" : status === 409 ? "Request conflict" : status === 500 ? "Internal server error" : "Request rejected";
      const detail = status === 500 ? "The server could not complete the request" : error.message;
      return v2Problem(c, status, status === 500 ? "internal-error" : "request-rejected", title, detail);
    }
    return c.json(
      {
        error: {
          code: status === 500 ? "INTERNAL_ERROR" : error.message,
          message: status === 500 ? "Internal server error" : error.message,
        },
      },
      status,
    );
  }
  if (error instanceof HTTPException) {
    if (published) {
      const title = error.status === 404 ? "Resource not found" : error.status === 403 ? "Permission denied" : "Request rejected";
      return v2Problem(c, error.status, "request-rejected", title, error.message);
    }
    return c.json({ error: { code: error.message, message: error.message } }, error.status);
  }
  c.set("requestError", {
    error_name: error.name,
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

function applicationStatus(kind: ApplicationError["kind"]): 400 | 404 | 409 | 500 {
  if (kind === "not-found") return 404;
  if (kind === "conflict") return 409;
  return kind === "invariant-failed" ? 500 : 400;
}

function amaProjectionStatus(kind: AmaProjectionError["kind"]): 403 | 404 | 409 | 502 | 503 {
  if (kind === "not-found") return 404;
  if (kind === "denied") return 403;
  if (kind === "rejected") return 409;
  return kind === "invalid-response" ? 502 : 503;
}

function delegationStatus(kind: RealmrootDelegationFailure["kind"]): 401 | 403 | 502 | 503 {
  if (kind === "reauthenticate") return 401;
  if (kind === "authority-required" || kind === "denied") return 403;
  return kind === "invalid-response" ? 502 : 503;
}
