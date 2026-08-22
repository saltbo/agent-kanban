// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { installCloudflareWebSocketTestGlobals, TestWebSocket, TestWebSocketPair } from "../../../tests/helpers/cloudflareWebSocket";

const sdk = vi.hoisted(() => ({
  config: undefined as { fetch?: typeof fetch } | undefined,
  options: undefined as Record<string, unknown> | undefined,
  createProject: vi.fn(async () => ({ id: "project-1", name: "Project One" })),
  getAgent: vi.fn(async (_agentId: string) => ({
    metadata: { uid: "agent-1", projectId: "project-1", name: "Agent One" },
    spec: { provider: "anthropic", model: "claude" },
  })),
  bearerToken: vi.fn(async (_env: unknown, _tenantId: string, forceRefresh = false) => (forceRefresh ? "refreshed-user-token" : "user-access-token")),
}));

vi.mock("@any-managed-agents/sdk", () => ({
  createAmaClient: vi.fn((options: Record<string, unknown>) => {
    sdk.options = options;
    return {
      raw: { setConfig: (config: { fetch?: typeof fetch }) => (sdk.config = config) },
      projects: {
        create: async () => {
          const response = await sdk.config?.fetch?.("https://ama.example.test/api/v1/projects", { method: "POST" });
          if (response && !response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
          return sdk.createProject();
        },
      },
      agents: {
        get: async (agentId: string) => {
          const response = await sdk.config?.fetch?.(`https://ama.example.test/api/v1/agents/${agentId}`, { method: "GET" });
          if (response && !response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
          return sdk.getAgent(agentId);
        },
      },
    };
  }),
}));

vi.mock("./realmrootAuth", () => ({
  AmaUserGrantRequired: class AmaUserGrantRequired extends Error {},
  amaBearerToken: sdk.bearerToken,
}));

import {
  AmaUserAuthError,
  createAmaProject,
  getAmaSessionSocketUrl,
  isAmaRuntimeConfigured,
  proxyAmaSessionSocket,
  readAmaAgent,
} from "./amaRuntime";

afterEach(() => {
  vi.unstubAllGlobals();
  sdk.createProject.mockReset().mockResolvedValue({ id: "project-1", name: "Project One" });
  sdk.getAgent.mockReset();
  sdk.getAgent.mockResolvedValue({
    metadata: { uid: "agent-1", projectId: "project-1", name: "Agent One" },
    spec: { provider: "anthropic", model: "claude" },
  });
  sdk.bearerToken.mockClear();
});

describe("AMA Realmroot user-grant integration", () => {
  it("requires the confidential Web client, encryption key, and AMA Resource", () => {
    expect(isAmaRuntimeConfigured(userGrantEnv())).toBe(true);
    expect(isAmaRuntimeConfigured({ AMA_ORIGIN: "https://ama.example.test" } as never)).toBe(false);
  });

  it("represents upstream 401 failures as a missing user grant", () => {
    const error = new AmaUserAuthError();
    expect(error).toMatchObject({ name: "AmaUserAuthError", status: 401, code: "AMA_USER_AUTH_REQUIRED" });
    expect(error.message).toContain("Sign in again");
  });

  it("returns an AK socket URL without exposing an AMA access token", async () => {
    const url = await getAmaSessionSocketUrl(
      { AK_RESOURCE: "https://ak.example.test/api", AMA_ORIGIN: "https://ama.example.test" } as never,
      "tenant-a",
      "session/1",
      "project-a",
    );
    expect(url).toBe("wss://ak.example.test/api/ama/sessions/session%2F1/socket?projectId=project-a");
    expect(url).not.toContain("access_token");
  });

  it("injects a user Bearer grant without the removed AK tenant header", async () => {
    let upstream: Request | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        upstream = new Request(input, init);
        return Response.json({});
      }),
    );

    await expect(createAmaProject(userGrantEnv(), "tenant-a", { name: "Project One" })).resolves.toEqual({ id: "project-1", name: "Project One" });

    expect(sdk.options).toMatchObject({
      baseUrl: "https://ama.example.test",
    });
    expect(sdk.options?.headers).toEqual({ authorization: "Bearer user-access-token" });
    expect(sdk.options?.headers).not.toHaveProperty("x-ak-tenant-id");
    expect(sdk.config?.fetch).toEqual(expect.any(Function));
    expect(upstream?.headers.get("authorization")).toBe("Bearer user-access-token");
    expect(upstream?.headers.has("dpop")).toBe(false);
    expect(upstream?.headers.has("x-ak-tenant-id")).toBe(false);
  });

  it("retries an idempotent AMA read at most once after a 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(readAmaAgent(userGrantEnv(), "tenant-a", "project-1", "agent-1")).resolves.toMatchObject({ id: "agent-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sdk.bearerToken.mock.calls.filter((call) => call[1] === "tenant-a" && call[2] === true)).toHaveLength(1);

    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 401 }));
    sdk.bearerToken.mockClear();
    await expect(readAmaAgent(userGrantEnv(), "tenant-a", "project-1", "agent-1")).rejects.toMatchObject({ code: "AMA_USER_AUTH_REQUIRED" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-idempotent AMA write after a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({})),
    );
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(createAmaProject(userGrantEnv(), "tenant-a", { name: "Project One" })).rejects.toMatchObject({
      code: "AMA_USER_AUTH_REQUIRED",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(sdk.bearerToken).toHaveBeenLastCalledWith(expect.anything(), "tenant-a", true, undefined);
  });

  it("does not expose an AMA error response body in the public error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({})),
    );
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{"secret":"upstream-internal-token"}', { status: 500 }));

    const error = await createAmaProject(userGrantEnv(), "tenant-a", { name: "Project One" }).catch((value) => value);
    expect(error.message).toBe("AMA create project failed HTTP 500");
    expect(error.message).not.toContain("upstream-internal-token");
  });

  it("returns a new browser-facing 101 socket and forwards text and binary frames in both directions", async () => {
    const { browserClient, browserServer, response, upstream, upstreamResponse, fetchMock } = await connectAmaSocketRelay();

    expect(response).not.toBe(upstreamResponse);
    expect(response.status).toBe(101);
    expect(response.webSocket).toBe(browserClient);
    expect(response.webSocket).not.toBe(upstream);
    expect(browserServer.accepted).toBe(true);
    expect(upstream.accepted).toBe(true);

    const browserBinary = new Uint8Array([1, 2, 3]).buffer;
    browserClient.send("browser-text");
    browserClient.send(browserBinary);
    expect(upstream.sent).toEqual(["browser-text", browserBinary]);

    const upstreamBinary = new Uint8Array([4, 5, 6]).buffer;
    upstream.emitMessage("ama-text");
    upstream.emitMessage(upstreamBinary);
    expect(browserClient.received).toEqual(["ama-text", upstreamBinary]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        authorization: "Bearer user-access-token",
        upgrade: "websocket",
        "x-ama-project-id": "project-1",
      }),
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("dpop");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("x-ak-tenant-id");
  });

  it("propagates a browser close to AMA and an AMA close to the browser", async () => {
    const browserClosed = await connectAmaSocketRelay();
    browserClosed.browserClient.close(1000, "browser done");
    expect(browserClosed.upstream.closedWith).toEqual({ code: 1000, reason: "browser done" });

    const upstreamClosed = await connectAmaSocketRelay();
    upstreamClosed.upstream.emitClose(1001, "AMA going away");
    expect(upstreamClosed.browserServer.closedWith).toEqual({ code: 1001, reason: "AMA going away" });
    expect(upstreamClosed.browserClient.closedWith).toEqual({ code: 1001, reason: "AMA going away" });
  });

  it("closes both relay sides when either direction cannot send", async () => {
    const toAmaFailure = await connectAmaSocketRelay();
    toAmaFailure.upstream.sendError = new Error("AMA send failed");
    toAmaFailure.browserClient.send("cannot reach AMA");
    expect(toAmaFailure.browserServer.closedWith).toEqual({ code: 1011, reason: "WebSocket relay failed" });
    expect(toAmaFailure.upstream.closedWith).toEqual({ code: 1011, reason: "WebSocket relay failed" });

    const toBrowserFailure = await connectAmaSocketRelay();
    toBrowserFailure.browserServer.sendError = new Error("browser send failed");
    toBrowserFailure.upstream.emitMessage("cannot reach browser");
    expect(toBrowserFailure.browserServer.closedWith).toEqual({ code: 1011, reason: "WebSocket relay failed" });
    expect(toBrowserFailure.upstream.closedWith).toEqual({ code: 1011, reason: "WebSocket relay failed" });
  });

  it("closes both relay sides when either socket emits an error", async () => {
    const browserFailure = await connectAmaSocketRelay();
    browserFailure.browserServer.emitError();
    expect(browserFailure.browserServer.closedWith).toEqual({ code: 1011, reason: "WebSocket relay failed" });
    expect(browserFailure.upstream.closedWith).toEqual({ code: 1011, reason: "WebSocket relay failed" });

    const amaFailure = await connectAmaSocketRelay();
    amaFailure.upstream.emitError();
    expect(amaFailure.browserServer.closedWith).toEqual({ code: 1011, reason: "WebSocket relay failed" });
    expect(amaFailure.upstream.closedWith).toEqual({ code: 1011, reason: "WebSocket relay failed" });
  });

  it("rejects a first non-101 AMA socket response without exposing its body or headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Object.assign(new Response("raw-upstream-secret", { status: 403, headers: { "x-secret": "secret-header" } }), {
          webSocket: null,
        }),
      ),
    );

    const error = await proxyAmaSessionSocket(userGrantEnv(), "tenant-a", "session-1", "project-1").catch((value) => value);
    expect(error.message).toBe("AMA WebSocket handshake failed");
    expect(String(error)).not.toContain("raw-upstream-secret");
    expect(String(error)).not.toContain("secret-header");
  });

  it("retries an AMA socket 401 once, then returns the same sanitized handshake error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("first-secret", { status: 401, headers: { "x-secret": "first-header" } }))
      .mockResolvedValueOnce(new Response("second-secret", { status: 403, headers: { "x-secret": "second-header" } }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await proxyAmaSessionSocket(userGrantEnv(), "tenant-a", "session-1", "project-1").catch((value) => value);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sdk.bearerToken).toHaveBeenNthCalledWith(2, expect.anything(), "tenant-a", true, undefined);
    expect(error.message).toBe("AMA WebSocket handshake failed");
    expect(String(error)).not.toMatch(/first-secret|second-secret|first-header|second-header/);
  });
});

function userGrantEnv() {
  return {
    AMA_ORIGIN: "https://ama.example.test",
    REALMROOT_ISSUER: "https://id.realmroot.dev/api/auth",
    REALMROOT_WEB_CLIENT_ID: "ak-web",
    REALMROOT_WEB_CLIENT_SECRET: "secret",
    REALMROOT_SESSION_ENCRYPTION_KEY: "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
    AMA_RESOURCE: "https://ama.example.test/api",
  } as never;
}

async function connectAmaSocketRelay() {
  installCloudflareWebSocketTestGlobals(vi.stubGlobal);
  const upstream = new TestWebSocket();
  const upstreamResponse = { status: 101, webSocket: upstream } as unknown as Response;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => upstreamResponse);
  vi.stubGlobal("fetch", fetchMock);

  const response = await proxyAmaSessionSocket(userGrantEnv(), "tenant-a", "session-1", "project-1");
  const pair = TestWebSocketPair.latest as TestWebSocketPair | undefined;
  if (!pair) throw new Error("AMA relay did not create a WebSocketPair");
  return {
    browserClient: pair[0],
    browserServer: pair[1],
    fetchMock,
    response: response as Response & { webSocket: TestWebSocket },
    upstream,
    upstreamResponse,
  };
}
