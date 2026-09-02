import type { Env } from "@server/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientCredentialsToken, ClientCredentialsFailure } = vi.hoisted(() => {
  class ClientCredentialsFailure extends Error {
    constructor(message: string) {
      super(message);
      this.name = "RealmrootClientCredentialsFailure";
    }
  }
  return {
    clientCredentialsToken: vi.fn(),
    ClientCredentialsFailure,
  };
});

vi.mock("@server/adapters/realmroot/clientCredentials", () => ({
  RealmrootClientCredentialsFailure: ClientCredentialsFailure,
  realmrootClientCredentialsToken: clientCredentialsToken,
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

describe("Agency Session observation boundary failures", () => {
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

  it("redacts Inbox network error details from the lifecycle notification failure", async () => {
    const cause = new Error(`network failed: ${upstreamCredential}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(cause)),
    );

    const error = await inboxTaskLifecycleNotifier(env())
      .notify({
        taskId: "task_1",
        assigneeActorId: "agent_1",
        event: "assigned",
        version: "version_1",
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "TaskLifecycleNotificationFailure",
      message: "Inbox task notification is unavailable",
      cause,
    });
    expect(String(error)).not.toContain(upstreamCredential);
  });

  it("preserves the stable Agency token failure and its diagnostic cause", async () => {
    const cause = new ClientCredentialsFailure("token endpoint unavailable");
    clientCredentialsToken.mockRejectedValueOnce(cause);

    await expect(agencySessionObservationClient(env()).findByRuntimeBinding(binding)).rejects.toMatchObject({
      name: "AgencySessionObservationFailure",
      code: "UNAVAILABLE",
      message: "Agency authorization failed",
      cause,
    });
  });

  it("keeps an Agency lookup HTTP failure stable without consuming its response body", async () => {
    const response = new Response(upstreamCredential, { status: 503 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await expect(agencySessionObservationClient(env()).findByRuntimeBinding(binding)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Agency Session lookup failed with HTTP 503",
    });

    expect(response.bodyUsed).toBe(false);
  });

  it("keeps an Agency socket HTTP failure stable without consuming its response body", async () => {
    const response = new Response(upstreamCredential, { status: 502 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await expect(agencySessionObservationClient(env()).connectSessionSocket("session_1", binding)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Agency Session socket failed with HTTP 502",
    });

    expect(response.bodyUsed).toBe(false);
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
  ])("preserves the stable Agency $operation network failure and its cause", async ({ invoke }) => {
    const cause = new Error(`network failed: ${upstreamCredential}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(cause)),
    );

    await expect(invoke()).rejects.toMatchObject({
      name: "AgencySessionObservationFailure",
      code: "UNAVAILABLE",
      message: "Agency request failed",
      cause,
    });
  });

  it("preserves the stable malformed Agency lookup failure and its parse cause", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{", { status: 200 })),
    );

    const error = await agencySessionObservationClient(env())
      .findByRuntimeBinding(binding)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "AgencySessionObservationFailure",
      code: "INVALID_RESPONSE",
      message: "Agency returned malformed Session JSON",
      cause: expect.any(SyntaxError),
    });
  });

  it("returns a stable failure for an invalid Agency lookup payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: "invalid", pagination: { hasMore: false } })),
    );

    await expect(agencySessionObservationClient(env()).findByRuntimeBinding(binding)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "Agency returned an invalid Session response",
    });
  });
});
