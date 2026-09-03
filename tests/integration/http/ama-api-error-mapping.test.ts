// @vitest-environment node

import { EnborApiError } from "@realmroot/enbor-sdk";
import type { Env } from "@server/env";
import { apiErrorHandler } from "@server/http/middleware/errorHandler";
import { requestContextMiddleware } from "@server/http/middleware/requestContext";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

function appFor(error: EnborApiError) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", requestContextMiddleware);
  app.onError(apiErrorHandler);
  app.get("/api/agents", () => {
    throw error;
  });
  return app;
}

describe("AMA SDK HTTP error mapping", () => {
  it.each([
    { upstream: 403, expected: 403, title: "AMA request failed" },
    { upstream: 404, expected: 404, title: "AMA request failed" },
    { upstream: 409, expected: 409, title: "AMA request failed" },
    { upstream: 200, expected: 502, title: "AMA request failed" },
    { upstream: 502, expected: 502, title: "AMA request failed" },
    { upstream: 408, expected: 503, title: "AMA unavailable" },
    { upstream: 429, expected: 503, title: "AMA unavailable" },
    { upstream: 503, expected: 503, title: "AMA unavailable" },
    { upstream: undefined, expected: 503, title: "AMA unavailable" },
  ])("maps SDK HTTP $upstream to stable $expected Problem Details", async ({ upstream, expected, title }) => {
    const response = await appFor(new EnborApiError(upstream, "provider-secret-SENTINEL", { secret: true })).request("/api/agents");

    expect(response.status).toBe(expected);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const body = await response.json();
    expect(body).toMatchObject({
      type: "http://localhost/api/problems/ama-request-failed",
      title,
      status: expected,
      detail: expected === 503 ? "AMA is unavailable" : "AMA rejected the request",
    });
    expect(JSON.stringify(body)).not.toContain("provider-secret-SENTINEL");
  });
});
