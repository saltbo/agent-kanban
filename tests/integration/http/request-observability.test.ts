// @vitest-environment node

import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../server/env";
import { api } from "../../../server/http/app";
import { createAccessLogMiddleware } from "../../../server/http/middleware/accessLog";
import { applyRequestIdHeader, requestContextMiddleware } from "../../../server/http/middleware/requestContext";
import { createLogger } from "../../../server/observability/logger";
import { createTestEnv } from "../../helpers/db";

function createTestLogger() {
  return {
    info: vi.fn<(message: string, fields?: Record<string, unknown>) => void>(),
    warn: vi.fn<(message: string, fields?: Record<string, unknown>) => void>(),
    error: vi.fn<(message: string, fields?: Record<string, unknown>) => void>(),
  };
}

function createTestApp(logger: ReturnType<typeof createTestLogger>) {
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", requestContextMiddleware);
  app.use("*", createAccessLogMiddleware(logger));
  app.onError((error, c) => {
    c.set("requestError", { error_name: error.name, error_message: error.message, error_stack: error.stack });
    applyRequestIdHeader(c);
    return c.text("Internal server error", 500);
  });

  app.get("/ok", (c) => c.json({ requestId: c.get("requestId") }));
  app.get("/native", () => new Response("native response"));
  app.get("/invalid", (c) => c.json({ error: "invalid" }, 422));
  app.get("/failure", () => {
    throw new Error("unexpected failure");
  });

  return app;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HTTP request correlation", () => {
  it("does not reuse a valid caller-supplied Request-Id", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    const app = createTestApp(createTestLogger());

    const response = await app.request("/ok", { headers: { "Request-Id": "client.request_42:retry-1" } });

    expect(response.headers.get("Request-Id")).toBe("00000000-0000-4000-8000-000000000001");
    await expect(response.json()).resolves.toEqual({ requestId: "00000000-0000-4000-8000-000000000001" });
  });

  it("generates a UUID when Request-Id is absent", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    const app = createTestApp(createTestLogger());

    const response = await app.request("/ok");

    expect(response.headers.get("Request-Id")).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("generates a UUID independently of an invalid Request-Id", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000002");
    const app = createTestApp(createTestLogger());

    const response = await app.request("/ok", { headers: { "Request-Id": "contains spaces" } });

    expect(response.headers.get("Request-Id")).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("applies Request-Id to a native Response returned by a handler", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000003");
    const app = createTestApp(createTestLogger());

    const response = await app.request("/native", { headers: { "Request-Id": "request-native" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("Request-Id")).toBe("00000000-0000-4000-8000-000000000003");
    await expect(response.text()).resolves.toBe("native response");
  });

  it("returns the generated Request-Id on unexpected failure", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000004");
    const app = createTestApp(createTestLogger());

    const response = await app.request("/failure", { headers: { "Request-Id": "request-failure" } });

    expect(response.status).toBe(500);
    expect(response.headers.get("Request-Id")).toBe("00000000-0000-4000-8000-000000000004");
  });
});

describe("HTTP access completion events", () => {
  it("emits exactly one structured event at the status-appropriate level for each request", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000005")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000006")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000007");
    const logger = createTestLogger();
    const app = createTestApp(logger);

    await app.request("/ok", { headers: { "Request-Id": "request-ok" } });
    await app.request("/invalid", { headers: { "Request-Id": "request-invalid" } });
    await app.request("/failure", { headers: { "Request-Id": "request-error" } });

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "request completed",
      expect.objectContaining({ method: "GET", path: "/ok", status: 200, request_id: "00000000-0000-4000-8000-000000000005", result: "success" }),
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "request completed",
      expect.objectContaining({
        method: "GET",
        path: "/invalid",
        status: 422,
        request_id: "00000000-0000-4000-8000-000000000006",
        result: "client_error",
      }),
    );
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "request completed",
      expect.objectContaining({
        method: "GET",
        path: "/failure",
        status: 500,
        request_id: "00000000-0000-4000-8000-000000000007",
        result: "server_error",
        error_name: "Error",
        error_message: "unexpected failure",
        error_stack: expect.any(String),
      }),
    );
  });

  it("wires a server-generated Request-Id through a real API route", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000008");
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const incomingTraceparent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
    const response = await api.request(
      "/api/sitemap.xml",
      { headers: { "Request-Id": "request-sitemap", traceparent: incomingTraceparent } },
      createTestEnv(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Request-Id")).toBe("00000000-0000-4000-8000-000000000008");
    expect(response.headers.get("traceparent")).toMatch(/^00-0123456789abcdef0123456789abcdef-[0-9a-f]{16}-01$/);
    expect(response.headers.get("traceparent")).not.toBe(incomingTraceparent);
    const completionEvents = consoleLog.mock.calls
      .map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
      .filter((entry) => entry.name === "api" && entry.msg === "request completed");
    expect(completionEvents).toEqual([
      expect.objectContaining({
        level: 30,
        method: "GET",
        path: "/api/sitemap.xml",
        status: 200,
        request_id: "00000000-0000-4000-8000-000000000008",
        trace_id: "0123456789abcdef0123456789abcdef",
        result: "success",
      }),
    ]);
  });
});

describe("structured logger event identity", () => {
  it("does not allow extension fields to override reserved event fields", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00.000Z"));
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    createLogger("trusted-module").info("trusted message", {
      level: 999,
      time: "forged-time",
      name: "forged-module",
      msg: "forged message",
      request_id: "request-identity",
    });

    expect(consoleLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(consoleLog.mock.calls[0][0]))).toEqual({
      level: 30,
      time: "2026-08-29T12:00:00.000Z",
      name: "trusted-module",
      msg: "trusted message",
      request_id: "request-identity",
    });
  });
});
