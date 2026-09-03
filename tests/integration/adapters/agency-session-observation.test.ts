import type { Session } from "@realmroot/enbor-sdk";
import { agencySessionObservationClient } from "@server/adapters/agency/sessionObservation";
import type { Env } from "@server/env";
import { afterEach, describe, expect, it, vi } from "vitest";

const authorization = {
  token: "delegated-session-token-SENTINEL",
  projectId: "ama-project-1",
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
};

function env(): Env {
  return { AMA_ORIGIN: "https://agency.example.com/configured-path" } as Env;
}

function session(): Session {
  return {
    metadata: {
      uid: "session-canonical-1",
      projectId: authorization.projectId,
      name: "Observed Session",
      description: null,
      labels: {},
      annotations: {},
      createdBy: null,
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:01:00.000Z",
    },
    spec: { agentId: "agent-1", environmentId: null, runtime: "codex", env: {}, envFrom: [], volumes: [], volumeMounts: [] },
    status: {
      phase: "idle",
      reason: null,
      conditions: [],
      bindings: {
        agent: { versionId: "agent-version-1", snapshot: {} as Session["status"]["bindings"]["agent"]["snapshot"] },
        environment: { id: null, versionId: null, snapshot: null },
        runtime: "codex",
      },
      placement: null,
      startedAt: "2026-09-02T00:00:00.000Z",
      closedAt: null,
    },
  };
}

describe("Agency Session observation SDK adapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("[spec: session-observation/exact-session] reads a canonical Session with delegated project authorization", async () => {
    const fetchMock = vi.fn(async () => Response.json(session()));
    vi.stubGlobal("fetch", fetchMock);

    const representation = session();
    await expect(agencySessionObservationClient(env(), authorization).getSession("session-canonical-1")).resolves.toEqual({
      id: "session-canonical-1",
      projectId: authorization.projectId,
      representation,
    });

    const [input, init] = fetchMock.mock.calls[0]!;
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    expect(url.href).toBe("https://agency.example.com/api/v1/sessions/session-canonical-1");
    expect([...url.searchParams]).toEqual([]);
    const headers = request.headers;
    expect(headers.get("Authorization")).toBe(`Bearer ${authorization.token}`);
    expect(headers.get("X-AMA-Project-ID")).toBe(authorization.projectId);
    expect(headers.get("traceparent")).toBe(authorization.traceparent);
  });

  it("[spec: session-observation/exact-session] maps a missing canonical Session to null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await expect(agencySessionObservationClient(env(), authorization).getSession("session-missing")).resolves.toBeNull();
  });

  it("maps malformed and structurally invalid successful Session responses to INVALID_RESPONSE", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{", { status: 200 }))
      .mockResolvedValueOnce(Response.json({ metadata: { projectId: authorization.projectId } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = agencySessionObservationClient(env(), authorization);

    await expect(client.getSession("session-canonical-1")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    await expect(client.getSession("session-canonical-1")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "Agency returned an invalid Session response",
    });
  });

  it.each([
    {
      missing: "spec",
      response: { metadata: { uid: "session-canonical-1", projectId: authorization.projectId }, status: {} },
    },
    {
      missing: "status",
      response: { metadata: { uid: "session-canonical-1", projectId: authorization.projectId }, spec: {} },
    },
  ])("maps a Session with correct identity but missing $missing to INVALID_RESPONSE", async ({ response }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(response)),
    );

    await expect(agencySessionObservationClient(env(), authorization).getSession("session-canonical-1")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "Agency returned an invalid Session response",
    });
  });

  it("applies the 10 second SDK timeout signal to REST and connectSessionSocket requests", async () => {
    const controllers: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      expect(milliseconds).toBe(10_000);
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    });
    const requests: Request[] = [];
    const upstream = {} as WebSocket;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push(request);
        return requests.length === 1 ? Response.json(session()) : ({ status: 101, webSocket: upstream } as Response & { webSocket: WebSocket });
      }),
    );
    const client = agencySessionObservationClient(env(), authorization);

    await client.getSession("session-canonical-1");
    await client.connectSessionSocket("session-canonical-1");

    expect(timeout).toHaveBeenCalledTimes(2);
    expect(requests.map((request) => request.signal.aborted)).toEqual([false, false]);
    controllers.forEach((controller) => {
      controller.abort();
    });
    expect(requests.map((request) => request.signal.aborted)).toEqual([true, true]);
  });

  it.each([
    {
      operation: "Session read",
      invoke: (client: ReturnType<typeof agencySessionObservationClient>) => client.getSession("session-canonical-1"),
      message: "Agency Session read failed with HTTP 503",
    },
    {
      operation: "Session socket",
      invoke: (client: ReturnType<typeof agencySessionObservationClient>) => client.connectSessionSocket("session-canonical-1"),
      message: "Agency Session socket failed with HTTP 503",
    },
  ])("keeps the $operation upstream failure stable and redacted", async ({ invoke, message }) => {
    const response = new Response("provider-secret-SENTINEL", { status: 503 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    const error = await invoke(agencySessionObservationClient(env(), authorization)).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "UNAVAILABLE",
      message,
    });
    expect(String(error)).not.toContain("provider-secret-SENTINEL");
  });

  it("preserves stable lookup and socket network failures with their causes", async () => {
    const cause = new Error("network failure credential-SENTINEL");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(cause)),
    );
    const client = agencySessionObservationClient(env(), authorization);

    await expect(client.getSession("session-canonical-1")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Agency request failed",
      cause: expect.any(Error),
    });
    await expect(client.connectSessionSocket("session-canonical-1")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Agency request failed",
    });
  });

  it("opens the standard canonical Session socket without binding query parameters", async () => {
    const upstream = {} as WebSocket;
    const fetchMock = vi.fn(async () => ({ status: 101, webSocket: upstream }) as Response & { webSocket: WebSocket });
    vi.stubGlobal("fetch", fetchMock);

    await expect(agencySessionObservationClient(env(), authorization).connectSessionSocket("session-canonical-1")).resolves.toBe(upstream);

    const [input, init] = fetchMock.mock.calls[0]!;
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    expect(url.href).toBe("https://agency.example.com/api/v1/sessions/session-canonical-1/socket");
    expect([...url.searchParams]).toEqual([]);
    const headers = request.headers;
    expect(headers.get("Authorization")).toBe(`Bearer ${authorization.token}`);
    expect(headers.get("X-AMA-Project-ID")).toBe(authorization.projectId);
    expect(headers.get("Upgrade")).toBe("websocket");
    expect(headers.get("traceparent")).toBe(authorization.traceparent);
  });
});
