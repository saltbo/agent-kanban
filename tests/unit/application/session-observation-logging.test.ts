import type { Env } from "@server/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientCredentialsToken, loggerError, ClientCredentialsFailure } = vi.hoisted(() => {
  class ClientCredentialsFailure extends Error {
    constructor(message: string) {
      super(message);
      this.name = "RealmrootClientCredentialsFailure";
    }
  }
  return {
    clientCredentialsToken: vi.fn(),
    loggerError: vi.fn(),
    ClientCredentialsFailure,
  };
});

vi.mock("@server/adapters/realmroot/clientCredentials", () => ({
  RealmrootClientCredentialsFailure: ClientCredentialsFailure,
  realmrootClientCredentialsToken: clientCredentialsToken,
}));

vi.mock("@server/observability/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerError,
    fatal: vi.fn(),
  }),
}));

import { agencySessionObservationClient } from "@server/adapters/agency/sessionObservation";
import { inboxTaskLifecycleNotifier } from "@server/adapters/realmroot/inboxTaskLifecycleNotifier";

const accessToken = "access-token-SENTINEL";
const clientSecret = "client-secret-SENTINEL";
const upstreamCredential = "upstream-credential-SENTINEL";
const binding = {
  agentActorId: "agent_1",
  runtime: "codex",
  runtimeSessionId: "runtime_session_1",
};

function env(): Env {
  return {
    AMA_ORIGIN: "https://agency.example.com/configured-path",
    AK_PUBLIC_ORIGIN: "https://agent-kanban.example.com",
    INBOX_RESOURCE: "https://inbox.example.com/api",
    INBOX_API_VERSION: "2026-08-31",
    OIDC_SERVICE_CLIENT_ID: "ak-service",
    OIDC_SERVICE_CLIENT_SECRET: clientSecret,
    OIDC_ISSUER: "https://id.example.com/api/auth",
  } as Env;
}

function expectNoCredentialLeak() {
  const logged = JSON.stringify(loggerError.mock.calls);
  expect(logged).not.toContain(accessToken);
  expect(logged).not.toContain(clientSecret);
  expect(logged).not.toContain(upstreamCredential);
  expect(logged).not.toContain("Authorization");
}

describe("Agency Session observation failure logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientCredentialsToken.mockResolvedValue(accessToken);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("[spec: tasks/assign] [spec: session-observation/exact-session] uses the shared OIDC Service credentials for Inbox notifications and Agency Session observation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://inbox.example.com/api/messages") return new Response(null, { status: 201 });
        return Response.json({ data: [], pagination: { hasMore: false, nextCursor: null } });
      }),
    );

    const configuration = env();
    await inboxTaskLifecycleNotifier(configuration).notify({
      taskId: "task_1",
      assigneeActorId: "agent_1",
      event: "assigned",
      version: "version_1",
    });
    await agencySessionObservationClient(configuration).findByRuntimeBinding(binding);

    expect(clientCredentialsToken).toHaveBeenNthCalledWith(1, {
      issuer: configuration.OIDC_ISSUER,
      clientId: "ak-service",
      clientSecret,
      resource: configuration.INBOX_RESOURCE,
      scope: "messages:create",
    });
    expect(clientCredentialsToken).toHaveBeenNthCalledWith(2, {
      issuer: configuration.OIDC_ISSUER,
      clientId: "ak-service",
      clientSecret,
      resource: "https://agency.example.com/api",
      origin: "https://agency.example.com",
      scope: "sessions:read",
    });
  });

  it("logs structured Agency token failure operation and scope without credentials", async () => {
    clientCredentialsToken.mockRejectedValueOnce(new ClientCredentialsFailure("token endpoint unavailable"));

    await expect(agencySessionObservationClient(env()).findByRuntimeBinding(binding)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });

    expect(loggerError).toHaveBeenCalledWith("Agency authorization failed", {
      operation: "clientCredentials",
      scope: "sessions:read",
      errorKind: "RealmrootClientCredentialsFailure",
    });
    expectNoCredentialLeak();
  });

  it("logs structured Agency lookup failure operation and status without credentials", async () => {
    const response = new Response(upstreamCredential, { status: 503 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await expect(agencySessionObservationClient(env()).findByRuntimeBinding(binding)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });

    expect(loggerError).toHaveBeenCalledWith("Agency Session lookup failed", {
      operation: "findByRuntimeBinding",
      status: 503,
      errorKind: "http",
    });
    expect(response.bodyUsed).toBe(false);
    expectNoCredentialLeak();
  });

  it("logs structured Agency socket failure operation and status without credentials", async () => {
    const response = new Response(upstreamCredential, { status: 502 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await expect(agencySessionObservationClient(env()).connectSessionSocket("session_1", binding)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });

    expect(loggerError).toHaveBeenCalledWith("Agency Session socket connection failed", {
      operation: "connectSessionSocket",
      status: 502,
      errorKind: "http",
    });
    expect(response.bodyUsed).toBe(false);
    expectNoCredentialLeak();
  });

  it.each([
    {
      operation: "findByRuntimeBinding" as const,
      invoke: () => agencySessionObservationClient(env()).findByRuntimeBinding(binding),
    },
    {
      operation: "connectSessionSocket" as const,
      invoke: () => agencySessionObservationClient(env()).connectSessionSocket("session_1", binding),
    },
  ])("logs structured Agency $operation network failure without credentials", async ({ operation, invoke }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error(`network failed: ${upstreamCredential}`))),
    );

    await expect(invoke()).rejects.toMatchObject({ code: "UNAVAILABLE" });

    expect(loggerError).toHaveBeenCalledWith("Agency request failed", {
      operation,
      errorKind: "network",
    });
    expectNoCredentialLeak();
  });

  it("logs structured Agency malformed lookup JSON without credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{", { status: 200 })),
    );

    await expect(agencySessionObservationClient(env()).findByRuntimeBinding(binding)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });

    expect(loggerError).toHaveBeenCalledWith("Agency Session lookup failed", {
      operation: "findByRuntimeBinding",
      status: 200,
      errorKind: "invalid-json",
    });
    expectNoCredentialLeak();
  });

  it("logs structured Agency invalid lookup payload without credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: "invalid", pagination: { hasMore: false } })),
    );

    await expect(agencySessionObservationClient(env()).findByRuntimeBinding(binding)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });

    expect(loggerError).toHaveBeenCalledWith("Agency Session lookup failed", {
      operation: "findByRuntimeBinding",
      status: 200,
      errorKind: "invalid-payload",
    });
    expectNoCredentialLeak();
  });
});
