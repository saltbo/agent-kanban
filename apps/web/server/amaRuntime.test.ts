// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  config: undefined as { fetch?: typeof fetch } | undefined,
  options: undefined as Record<string, unknown> | undefined,
  createProject: vi.fn(async () => ({ id: "project-1", name: "Project One" })),
  getAgent: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("@any-managed-agents/sdk", () => ({
  createAmaClient: vi.fn((options: Record<string, unknown>) => {
    sdk.options = options;
    return {
      raw: { setConfig: (config: { fetch?: typeof fetch }) => (sdk.config = config) },
      projects: {
        create: async () => {
          await sdk.config?.fetch?.("https://ama.example.test/api/v1/projects", { method: "POST" });
          return sdk.createProject();
        },
      },
      agents: { get: sdk.getAgent },
    };
  }),
}));

vi.mock("./realmrootMachineAuth", () => ({
  createAmaMachineAuthorizer: () => async () => ({ accessToken: "machine-token", dpopProof: "signed-proof" }),
  invalidateAmaMachineToken: sdk.invalidate,
}));

import {
  AmaMachineAuthError,
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
  sdk.invalidate.mockReset();
});

describe("AMA Realmroot machine integration", () => {
  it("requires the machine client and DPoP key before enabling AMA", () => {
    expect(
      isAmaRuntimeConfigured({
        AMA_ORIGIN: "https://ama.example.test",
        REALMROOT_ISSUER: "https://id.realmroot.dev/api/auth",
        AMA_MACHINE_CLIENT_ID: "ak-machine",
        AMA_MACHINE_CLIENT_SECRET: "secret",
        AMA_DPOP_PRIVATE_JWK: "{}",
      } as never),
    ).toBe(true);
    expect(isAmaRuntimeConfigured({ AMA_ORIGIN: "https://ama.example.test" } as never)).toBe(false);
  });

  it("represents upstream 401 failures as machine-authority failures", () => {
    const error = new AmaMachineAuthError();
    expect(error).toMatchObject({ name: "AmaMachineAuthError", status: 401, code: "AMA_MACHINE_AUTH_FAILED" });
    expect(error.message).toContain("machine authority");
  });

  it("returns an AK socket URL without exposing an AMA access token", async () => {
    const url = await getAmaSessionSocketUrl(
      { AK_RESOURCE: "https://ak.example.test/api", AMA_ORIGIN: "https://ama.example.test" } as never,
      "tenant-a",
      "session/1",
      "project-a",
    );
    expect(url).toBe("wss://ak.example.test/api/ama/sessions/session%2F1/socket");
    expect(url).not.toContain("access_token");
  });

  it("injects an M2M DPoP fetch into the AMA SDK raw client", async () => {
    let upstream: Request | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        upstream = new Request(input, init);
        return Response.json({});
      }),
    );

    await expect(
      createAmaProject(
        {
          AMA_ORIGIN: "https://ama.example.test",
          REALMROOT_ISSUER: "https://id.realmroot.dev/api/auth",
          AMA_MACHINE_CLIENT_ID: "ak-machine",
          AMA_MACHINE_CLIENT_SECRET: "secret",
          AMA_MACHINE_SCOPES: "projects:write",
          AMA_DPOP_PRIVATE_JWK: "{}",
        } as never,
        "tenant-a",
        { name: "Project One" },
      ),
    ).resolves.toEqual({ id: "project-1", name: "Project One" });

    expect(sdk.options).toMatchObject({
      baseUrl: "https://ama.example.test",
      headers: { "x-ak-tenant-id": "tenant-a" },
    });
    expect(sdk.config?.fetch).toEqual(expect.any(Function));
    expect(upstream?.headers.get("authorization")).toBe("DPoP machine-token");
    expect(upstream?.headers.get("dpop")).toBe("signed-proof");
  });

  it("retries an idempotent AMA read at most once after a 401", async () => {
    sdk.getAgent.mockRejectedValueOnce(Object.assign(new Error("unauthorized"), { status: 401 })).mockResolvedValueOnce({
      metadata: { uid: "agent-1", projectId: "project-1", name: "Agent One" },
      spec: { provider: "anthropic", model: "claude" },
    });

    await expect(readAmaAgent(machineEnv(), "tenant-a", "project-1", "agent-1")).resolves.toMatchObject({ id: "agent-1" });
    expect(sdk.getAgent).toHaveBeenCalledTimes(2);
    expect(sdk.invalidate).toHaveBeenCalledOnce();

    sdk.getAgent.mockReset().mockRejectedValue(Object.assign(new Error("still unauthorized"), { status: 401 }));
    sdk.invalidate.mockReset();
    await expect(readAmaAgent(machineEnv(), "tenant-a", "project-1", "agent-1")).rejects.toMatchObject({ code: "AMA_MACHINE_AUTH_FAILED" });
    expect(sdk.getAgent).toHaveBeenCalledTimes(2);
    expect(sdk.invalidate).toHaveBeenCalledOnce();
  });

  it("does not retry a non-idempotent AMA write after a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({})),
    );
    sdk.createProject.mockRejectedValueOnce(Object.assign(new Error("unauthorized"), { status: 401 }));

    await expect(createAmaProject(machineEnv(), "tenant-a", { name: "Project One" })).rejects.toMatchObject({
      code: "AMA_MACHINE_AUTH_FAILED",
    });
    expect(sdk.createProject).toHaveBeenCalledOnce();
    expect(sdk.invalidate).toHaveBeenCalledOnce();
  });

  it("does not expose an AMA error response body in the public error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({})),
    );
    sdk.createProject.mockRejectedValueOnce(
      Object.assign(new Error('HTTP 500: {"secret":"upstream-internal-token"}'), {
        status: 500,
        body: { secret: "upstream-internal-token" },
      }),
    );

    const error = await createAmaProject(machineEnv(), "tenant-a", { name: "Project One" }).catch((value) => value);
    expect(error.message).toBe("AMA create project failed HTTP 500");
    expect(error.message).not.toContain("upstream-internal-token");
  });

  it("returns only a successful AMA 101 response that carries a WebSocket", async () => {
    const webSocket = { accept: vi.fn() };
    const upstream = { status: 101, webSocket } as unknown as Response;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => upstream);
    vi.stubGlobal("fetch", fetchMock);

    await expect(proxyAmaSessionSocket(machineEnv(), "tenant-a", "session-1", "project-1")).resolves.toBe(upstream);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        authorization: "DPoP machine-token",
        dpop: "signed-proof",
        upgrade: "websocket",
        "x-ak-tenant-id": "tenant-a",
        "x-ama-project-id": "project-1",
      }),
    });
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

    const error = await proxyAmaSessionSocket(machineEnv(), "tenant-a", "session-1", "project-1").catch((value) => value);
    expect(error.message).toBe("AMA WebSocket handshake failed");
    expect(String(error)).not.toContain("raw-upstream-secret");
    expect(String(error)).not.toContain("secret-header");
    expect(sdk.invalidate).not.toHaveBeenCalled();
  });

  it("retries an AMA socket 401 once, then returns the same sanitized handshake error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("first-secret", { status: 401, headers: { "x-secret": "first-header" } }))
      .mockResolvedValueOnce(new Response("second-secret", { status: 403, headers: { "x-secret": "second-header" } }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await proxyAmaSessionSocket(machineEnv(), "tenant-a", "session-1", "project-1").catch((value) => value);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sdk.invalidate).toHaveBeenCalledOnce();
    expect(error.message).toBe("AMA WebSocket handshake failed");
    expect(String(error)).not.toMatch(/first-secret|second-secret|first-header|second-header/);
  });
});

function machineEnv() {
  return {
    AMA_ORIGIN: "https://ama.example.test",
    REALMROOT_ISSUER: "https://id.realmroot.dev/api/auth",
    AMA_MACHINE_CLIENT_ID: "ak-machine",
    AMA_MACHINE_CLIENT_SECRET: "secret",
    AMA_MACHINE_SCOPES: "projects:read projects:write",
    AMA_DPOP_PRIVATE_JWK: "{}",
  } as never;
}
