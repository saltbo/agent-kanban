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

function session() {
  return {
    metadata: {
      uid: "session-canonical-1",
      projectId: authorization.projectId,
      name: "Observed Session",
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:01:00.000Z",
      archivedAt: null,
    },
    spec: { runtime: "codex" },
    status: { phase: "idle" },
  };
}

describe("Agency Session observation boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("[spec: session-observation/exact-session] reads a canonical Session with delegated project authorization", async () => {
    const fetchMock = vi.fn(async () => Response.json(session()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(agencySessionObservationClient(env(), authorization).getSession("session-canonical-1")).resolves.toEqual(session());

    const [input, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.href).toBe("https://agency.example.com/api/v1/sessions/session-canonical-1");
    expect([...url.searchParams]).toEqual([]);
    const headers = new Headers(init?.headers);
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

  it("rejects malformed and invalid successful Session responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{", { status: 200 }))
      .mockResolvedValueOnce(Response.json({ metadata: { uid: "session-canonical-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = agencySessionObservationClient(env(), authorization);

    await expect(client.getSession("session-canonical-1")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "Agency returned malformed Session JSON",
      cause: expect.any(SyntaxError),
    });
    await expect(client.getSession("session-canonical-1")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "Agency returned an invalid Session response",
    });
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
  ])("does not consume a credential-bearing upstream body when the $operation fails", async ({ invoke, message }) => {
    const response = new Response("provider-secret-SENTINEL", { status: 503 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await expect(invoke(agencySessionObservationClient(env(), authorization))).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message,
    });
    expect(response.bodyUsed).toBe(false);
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
      cause,
    });
    await expect(client.connectSessionSocket("session-canonical-1")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Agency request failed",
      cause,
    });
  });

  it("opens the standard canonical Session socket without binding query parameters", async () => {
    const upstream = {} as WebSocket;
    const fetchMock = vi.fn(async () => ({ status: 101, webSocket: upstream }) as Response & { webSocket: WebSocket });
    vi.stubGlobal("fetch", fetchMock);

    await expect(agencySessionObservationClient(env(), authorization).connectSessionSocket("session-canonical-1")).resolves.toBe(upstream);

    const [input, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.href).toBe("https://agency.example.com/api/v1/sessions/session-canonical-1/socket");
    expect([...url.searchParams]).toEqual([]);
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${authorization.token}`);
    expect(headers.get("X-AMA-Project-ID")).toBe(authorization.projectId);
    expect(headers.get("Upgrade")).toBe("websocket");
  });
});
