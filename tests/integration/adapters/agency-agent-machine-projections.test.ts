// @vitest-environment node

import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AmaProjectCatalogAdapter } from "../../../server/adapters/agency/projectCatalog";
import { AmaProjectionError, AmaResourceProjectionAdapter } from "../../../server/adapters/agency/resourceProjections";
import type { Env } from "../../../server/env";
import { apiErrorHandler } from "../../../server/http/middleware/errorHandler";

const env = { AMA_ORIGIN: "https://ama.test" } as Env;
afterEach(() => vi.unstubAllGlobals());

const metadata = (uid: string, name: string) => ({
  uid,
  projectId: "project-1",
  name,
  description: null,
  labels: {},
  annotations: {},
  createdBy: null,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:01.000Z",
});

const project = (id = "project-1", name = "Agent Kanban") => ({
  id,
  name,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:01.000Z",
});

const agent = (uid = "agent-1", name = "Backend") => ({
  metadata: metadata(uid, name),
  spec: {
    systemPrompt: "Build APIs",
    provider: "openai",
    model: "gpt-5.6",
    skills: ["agent-kanban"],
    subagents: [],
    allowedTools: ["bash"],
    mcpConnectors: [],
    identity: {
      identityId: "identity-1",
      agentId: "realmroot-agent-1",
      issuer: "https://realmroot.test",
      subject: "realmroot-agent-subject",
      username: "backend",
      runtime: "codex",
    },
  },
  status: { phase: "active", currentVersionId: "agent-version-1", version: 1, schedulable: true },
});

const environment = (uid = "environment-1", name = "Build host") => ({
  metadata: metadata(uid, name),
  spec: {
    scope: "project",
    type: "self_hosted",
    networking: { type: "closed", allowMcpServers: false, allowPackageManagers: false },
    packages: { type: "packages", apt: [], cargo: [], gem: [], go: [], npm: [], pip: [], webi: [] },
    variables: {},
  },
  status: { phase: "active", currentVersionId: "environment-version-1", version: 1 },
});

const runner = (id = "runner-1", name = "build.local") => ({
  id,
  projectId: "project-1",
  name,
  environmentId: "environment-1",
  secretRef: null,
  authMode: "realmroot",
  state: "active",
  currentLoad: 0,
  maxConcurrent: 1,
  runtimeUsage: [],
  runtimes: [],
  metadata: {},
  lastHeartbeatAt: null,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:01.000Z",
});

describe("Agency Agent and Machine projection adapter", () => {
  it("uses the SDK Project contract for pagination, authorization, tracing, and creation", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push(request);
        return request.method === "POST"
          ? Response.json(project("project-created", "Agent Kanban"), { status: 201 })
          : Response.json({ data: [project()], pagination: { limit: 100, nextCursor: null, hasMore: false } });
      }),
    );
    const adapter = new AmaProjectCatalogAdapter(env, "ama-token", "00-project-trace");

    await expect(adapter.listProjects(vi.fn())).resolves.toEqual([{ id: "project-1", name: "Agent Kanban" }]);
    await expect(adapter.createProject("Agent Kanban")).resolves.toEqual({ id: "project-created", name: "Agent Kanban" });

    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", "/api/v1/projects"],
      ["POST", "/api/v1/projects"],
    ]);
    expect([...new URL(requests[0]!.url).searchParams]).toEqual([["limit", "100"]]);
    expect(await requests[1]!.clone().json()).toEqual({ name: "Agent Kanban" });
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe("Bearer ama-token");
      expect(request.headers.get("traceparent")).toBe("00-project-trace");
      expect(request.headers.has("x-ama-project-id")).toBe(false);
    }
  });

  it("uses the SDK Agent and Identity contracts for filters, idempotent writes, and soft deletion", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push(request);
        const { pathname } = new URL(request.url);
        if (request.method === "GET" && pathname === "/api/v1/agents") {
          return Response.json({ data: [agent()], pagination: { limit: 20, nextCursor: null, hasMore: false } });
        }
        if (request.method === "GET") return Response.json(agent("agent/encoded", "Encoded"));
        if (request.method === "POST" && pathname === "/api/v1/identities") {
          return Response.json({ metadata: metadata("identity-1", "Backend identity"), spec: {}, status: {} }, { status: 201 });
        }
        if (request.method === "POST") return Response.json(agent("agent-created", "Backend"), { status: 201 });
        return new Response(null, { status: 204 });
      }),
    );
    const adapter = new AmaResourceProjectionAdapter(env, "ama-token", "00-resource-trace");

    await adapter.listAgentsPage({
      projectId: "project-1",
      limit: 20,
      cursor: "agent-cursor",
      filters: { runtime: "codex", schedulable: false, search: "backend" },
    });
    await adapter.getAgent("project-1", "agent/encoded");
    await expect(
      adapter.createIdentity("project-1", {
        name: "Backend identity",
        username: "backend",
        runtime: "codex",
        idempotencyKey: "identity-key",
      }),
    ).resolves.toBe("identity-1");
    await adapter.archiveIdentity("project-1", "identity/encoded");
    await adapter.createAgent("project-1", {
      name: "Backend",
      description: "Builds APIs",
      systemPrompt: "Build APIs",
      provider: "openai",
      model: "gpt-5.6",
      skills: ["agent-kanban"],
      identityRef: "identity-1",
      idempotencyKey: "agent-key",
    });

    expect(new URL(requests[0]!.url).pathname).toBe("/api/v1/agents");
    expect(Object.fromEntries(new URL(requests[0]!.url).searchParams)).toEqual({
      limit: "20",
      cursor: "agent-cursor",
      runtime: "codex",
      schedulable: "false",
      search: "backend",
    });
    expect(new URL(requests[1]!.url).pathname).toBe("/api/v1/agents/agent%2Fencoded");
    expect(await requests[2]!.clone().json()).toEqual({
      metadata: { name: "Backend identity" },
      spec: { username: "backend", runtime: "codex" },
    });
    expect(requests[2]!.headers.get("idempotency-key")).toBe("identity-key");
    expect([requests[3]!.method, new URL(requests[3]!.url).pathname]).toEqual(["DELETE", "/api/v1/identities/identity%2Fencoded"]);
    expect(await requests[4]!.clone().json()).toEqual({
      metadata: { name: "Backend", description: "Builds APIs" },
      spec: {
        systemPrompt: "Build APIs",
        provider: "openai",
        model: "gpt-5.6",
        skills: ["agent-kanban"],
        identityRef: "identity-1",
      },
    });
    expect(requests[4]!.headers.get("idempotency-key")).toBe("agent-key");
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe("Bearer ama-token");
      expect(request.headers.get("x-ama-project-id")).toBe("project-1");
      expect(request.headers.get("traceparent")).toBe("00-resource-trace");
    }
  });

  it("uses the SDK Environment and Runner contracts and accepts DELETE 204 soft deletion", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push(request);
        const { pathname } = new URL(request.url);
        if (request.method === "GET" && pathname === "/api/v1/environments") {
          return Response.json({ data: [environment()], pagination: { limit: 10, nextCursor: null, hasMore: false } });
        }
        if (request.method === "GET" && pathname === "/api/v1/runners") {
          return Response.json({ data: [], pagination: { limit: 100, nextCursor: null, hasMore: false } });
        }
        if (request.method === "POST") return Response.json(environment("environment-created", "New computer"), { status: 201 });
        return new Response(null, { status: 204 });
      }),
    );
    const adapter = new AmaResourceProjectionAdapter(env, "ama-token", "00-machine-trace");

    await adapter.listMachinesPage({ projectId: "project-1", limit: 10, cursor: "environment-cursor" });
    await adapter.createMachine("project-1", "New computer", "environment-key");
    await expect(adapter.archiveMachine("project-1", "environment/encoded")).resolves.toBe(true);

    expect([requests[0]!.method, new URL(requests[0]!.url).pathname, Object.fromEntries(new URL(requests[0]!.url).searchParams)]).toEqual([
      "GET",
      "/api/v1/environments",
      { limit: "10", cursor: "environment-cursor" },
    ]);
    expect([requests[1]!.method, new URL(requests[1]!.url).pathname]).toEqual(["GET", "/api/v1/runners"]);
    expect(Object.fromEntries(new URL(requests[1]!.url).searchParams)).toEqual({ limit: "100" });
    expect(await requests[2]!.clone().json()).toEqual({
      metadata: { name: "New computer" },
      spec: { scope: "project", type: "self_hosted" },
    });
    expect(requests[2]!.headers.get("idempotency-key")).toBe("environment-key");
    expect([requests[3]!.method, new URL(requests[3]!.url).pathname]).toEqual(["DELETE", "/api/v1/environments/environment%2Fencoded"]);
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe("Bearer ama-token");
      expect(request.headers.get("x-ama-project-id")).toBe("project-1");
      expect(request.headers.get("traceparent")).toBe("00-machine-trace");
    }
  });

  it("redacts AMA response and network error details from projection failures and API Problems", async () => {
    const credentialSentinel = "ama-upstream-credential-sentinel";
    const failures = [
      {
        invoke: () =>
          new AmaResourceProjectionAdapter(env, "ama-token").listAgentsPage({
            projectId: "project-1",
            limit: 20,
            cursor: null,
            filters: {},
          }),
        response: () => Response.json({ error: { message: credentialSentinel } }, { status: 400 }),
        expected: { kind: "rejected", message: "AMA request was rejected" },
      },
      {
        invoke: () => new AmaProjectCatalogAdapter(env, "ama-token").listProjects(vi.fn()),
        response: () => Response.json({ error: { message: credentialSentinel } }, { status: 500 }),
        expected: { kind: "unavailable", message: "AMA is unavailable" },
      },
    ];

    for (const failure of failures) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => failure.response()),
      );
      const error = await failure.invoke().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AmaProjectionError);
      expect(error).toMatchObject(failure.expected);
      expect(String(error)).not.toContain(credentialSentinel);
    }

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error(credentialSentinel))),
    );
    const networkError = await new AmaResourceProjectionAdapter(env, "ama-token")
      .listAgentsPage({ projectId: "project-1", limit: 20, cursor: null, filters: {} })
      .catch((caught: unknown) => caught);
    expect(networkError).toMatchObject({ kind: "unavailable", message: "AMA is unavailable" });
    expect(String(networkError)).not.toContain(credentialSentinel);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { message: credentialSentinel } }, { status: 400 })),
    );
    const app = new Hono<{ Bindings: Env }>();
    app.get("/api/agents", async (c) =>
      c.json(
        await new AmaResourceProjectionAdapter(c.env, "ama-token").listAgentsPage({
          projectId: "project-1",
          limit: 20,
          cursor: null,
          filters: {},
        }),
      ),
    );
    app.onError(apiErrorHandler);

    const response = await app.fetch(new Request("https://ak.test/api/agents"), env);
    expect(response.status).toBe(409);
    const problem = (await response.json()) as { detail: string };
    expect(problem.detail).toBe("AMA request was rejected");
    expect(JSON.stringify(problem)).not.toContain(credentialSentinel);
  });

  it("preserves SDK 404 and upstream failure mappings at the projection boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { type: "not_found", message: "missing" } }, { status: 404 })),
    );
    const adapter = new AmaResourceProjectionAdapter(env, "ama-token");

    await expect(adapter.getAgent("project-1", "missing-agent")).resolves.toBeNull();
    await expect(adapter.getMachine("project-1", "missing-environment")).resolves.toBeNull();
    await expect(adapter.archiveMachine("project-1", "missing-environment")).resolves.toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { type: "unavailable", message: "provider detail" } }, { status: 503 })),
    );
    await expect(adapter.archiveIdentity("project-1", "identity-1")).rejects.toMatchObject({
      kind: "unavailable",
      message: "AMA is unavailable",
    });
  });

  it("does not turn a Runner list 404 into a missing Environment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        return new URL(request.url).pathname === "/api/v1/environments/environment-1"
          ? Response.json(environment())
          : Response.json({ error: { type: "not_found", message: "Runner collection unavailable" } }, { status: 404 });
      }),
    );

    await expect(new AmaResourceProjectionAdapter(env, "ama-token").getMachine("project-1", "environment-1")).rejects.toMatchObject({
      kind: "not-found",
      message: "AMA request was rejected",
    });
  });

  it.each([
    {
      resource: "Project",
      response: () => Response.json({ data: [{ ...project(), name: undefined }], pagination: { nextCursor: null, hasMore: false } }),
      invoke: () => new AmaProjectCatalogAdapter(env, "ama-token").listProjects(vi.fn()),
    },
    {
      resource: "Identity",
      response: () => Response.json({ metadata: { ...metadata("identity-1", "Identity"), uid: undefined }, spec: {}, status: {} }, { status: 201 }),
      invoke: () =>
        new AmaResourceProjectionAdapter(env, "ama-token").createIdentity("project-1", {
          name: "Identity",
          username: "identity",
          runtime: "codex",
          idempotencyKey: "identity-key",
        }),
    },
    {
      resource: "Agent",
      response: () => Response.json({ ...agent(), spec: { ...agent().spec, systemPrompt: undefined } }),
      invoke: () => new AmaResourceProjectionAdapter(env, "ama-token").getAgent("project-1", "agent-1"),
    },
    {
      resource: "Environment",
      response: () => Response.json({ ...environment(), metadata: { ...environment().metadata, uid: undefined } }),
      invoke: () => new AmaResourceProjectionAdapter(env, "ama-token").getMachine("project-1", "environment-1"),
    },
  ])("maps a valid JSON $resource response missing a required field to invalid-response", async ({ response, invoke }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );

    await expect(invoke()).rejects.toMatchObject({
      kind: "invalid-response",
      message: expect.stringContaining("invalid"),
    });
  });

  it("maps a valid JSON Runner response missing a required field to invalid-response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        if (new URL(request.url).pathname === "/api/v1/environments") {
          return Response.json({ data: [environment()], pagination: { nextCursor: null, hasMore: false } });
        }
        return Response.json({ data: [{ ...runner(), name: undefined }], pagination: { nextCursor: null, hasMore: false } });
      }),
    );

    await expect(
      new AmaResourceProjectionAdapter(env, "ama-token").listMachinesPage({ projectId: "project-1", limit: 20, cursor: null }),
    ).rejects.toMatchObject({ kind: "invalid-response", message: "AMA returned an invalid resource representation" });
  });

  it.each([
    {
      resource: "Agent",
      response: { ...agent(), status: { ...agent().status, phase: "archived" } },
      invoke: () => new AmaResourceProjectionAdapter(env, "ama-token").getAgent("project-1", "agent-1"),
    },
    {
      resource: "Environment",
      response: { ...environment(), status: { ...environment().status, phase: "archived" } },
      invoke: () => new AmaResourceProjectionAdapter(env, "ama-token").getMachine("project-1", "environment-1"),
    },
  ])("maps a non-active $resource phase to invalid-response", async ({ response, invoke }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(response)),
    );

    await expect(invoke()).rejects.toMatchObject({
      kind: "invalid-response",
      message: "AMA returned an invalid resource representation",
    });
  });

  it("rejects a blank Runner name and trims a usable Runner name in the Machine projection", async () => {
    const adapter = new AmaResourceProjectionAdapter(env, "ama-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        if (new URL(request.url).pathname === "/api/v1/environments") {
          return Response.json({ data: [environment()], pagination: { nextCursor: null, hasMore: false } });
        }
        return Response.json({ data: [runner("runner-blank", "   ")], pagination: { nextCursor: null, hasMore: false } });
      }),
    );
    await expect(adapter.listMachinesPage({ projectId: "project-1", limit: 20, cursor: null })).rejects.toMatchObject({
      kind: "invalid-response",
      message: "AMA returned an invalid resource representation",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        if (new URL(request.url).pathname === "/api/v1/environments") {
          return Response.json({ data: [environment()], pagination: { nextCursor: null, hasMore: false } });
        }
        return Response.json({ data: [runner("runner-trimmed", "  build.local  ")], pagination: { nextCursor: null, hasMore: false } });
      }),
    );
    await expect(adapter.listMachinesPage({ projectId: "project-1", limit: 20, cursor: null })).resolves.toMatchObject({
      items: [
        {
          name: "build.local",
          runners: [expect.objectContaining({ id: "runner-trimmed", name: "build.local" })],
        },
      ],
    });
  });

  it.each([
    {
      name: "non-array data",
      value: { data: "not-an-array", pagination: {} },
      message: "AMA Project page exceeded the requested limit",
    },
    {
      name: "hasMore with null cursor",
      value: { data: [], pagination: { hasMore: true, nextCursor: null } },
      message: "AMA returned invalid Project pagination",
    },
    {
      name: "hasMore with empty cursor",
      value: { data: [], pagination: { hasMore: true, nextCursor: "" } },
      message: "AMA returned invalid Project pagination",
    },
    {
      name: "more than the requested limit",
      value: { data: Array.from({ length: 101 }, (_, index) => project(`project-${index}`)), pagination: { hasMore: false, nextCursor: null } },
      message: "AMA Project page exceeded the requested limit",
    },
  ])("[spec: agents/transparent-ama-project] rejects $name", async ({ value, message }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(value)),
    );

    await expect(new AmaProjectCatalogAdapter(env, "ama-token").listProjects(vi.fn())).rejects.toMatchObject({ kind: "invalid-response", message });
  });

  it("[spec: agents/transparent-ama-project] renews the claim at every AMA Project page boundary", async () => {
    const events: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const cursor = new URL(input instanceof Request ? input.url : String(input)).searchParams.get("cursor");
        events.push(`fetch:${cursor}`);
        return Response.json({
          data: [project(cursor ? "project-2" : "project-1")],
          pagination: cursor ? { hasMore: false, nextCursor: null } : { hasMore: true, nextCursor: "next" },
        });
      }),
    );

    await expect(
      new AmaProjectCatalogAdapter(env, "ama-token").listProjects(async () => {
        events.push("renew");
      }),
    ).resolves.toHaveLength(2);
    expect(events).toEqual(["renew", "fetch:null", "renew", "fetch:next"]);
  });

  it("[spec: agents/transparent-ama-project] rejects repeated AMA Project cursors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [project()], pagination: { hasMore: true, nextCursor: "repeated" } })),
    );

    await expect(new AmaProjectCatalogAdapter(env, "ama-token").listProjects(vi.fn())).rejects.toMatchObject({
      kind: "invalid-response",
      message: "AMA Project pagination did not advance",
    });
  });

  it("[spec: agents/authoritative-projection] preserves the AMA Agent page, nullable identity, and continuation cursor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        expect(request.headers.get("authorization")).toBe("Bearer ama-token");
        expect(request.headers.get("x-ama-project-id")).toBe("project-1");
        expect(request.headers.get("traceparent")).toBe("00-trace-span-01");
        return Response.json({
          data: [
            {
              metadata: { ...metadata("agent-1", "Backend"), description: "Builds APIs" },
              spec: {
                systemPrompt: "Build APIs",
                provider: "openai",
                model: "gpt-5.6",
                skills: ["agent-kanban"],
                subagents: [],
                allowedTools: ["bash"],
                mcpConnectors: [],
                identity: {
                  identityId: "identity-1",
                  agentId: "realmroot-agent-1",
                  issuer: "https://realmroot.test",
                  subject: "realmroot-agent-subject",
                  username: "backend",
                  runtime: "codex",
                },
              },
              status: { phase: "active", currentVersionId: "agent-version-1", version: 1, schedulable: true },
            },
            {
              metadata: metadata("agent-2", "Unbound"),
              spec: {
                systemPrompt: "Await identity binding",
                provider: null,
                model: null,
                skills: [],
                subagents: [],
                allowedTools: [],
                mcpConnectors: [],
                identity: null,
              },
              status: { phase: "active", currentVersionId: "agent-version-2", version: 1, schedulable: false },
            },
          ],
          pagination: { nextCursor: "agent-page-2", hasMore: true },
        });
      }),
    );

    await expect(
      new AmaResourceProjectionAdapter(env, "ama-token", "00-trace-span-01").listAgentsPage({
        projectId: "project-1",
        limit: 20,
        cursor: null,
        filters: {},
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: "agent-1",
          name: "Backend",
          description: "Builds APIs",
          username: "backend",
          runtime: "codex",
          subject: "realmroot-agent-subject",
          schedulable: true,
        }),
        expect.objectContaining({
          id: "agent-2",
          name: "Unbound",
          username: null,
          runtime: null,
          subject: null,
          phase: "active",
          schedulable: false,
        }),
      ],
      nextCursor: "agent-page-2",
    });
  });

  it("[spec: agents/create-bound-agent] rejects an AMA-created Agent without a bound identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        expect(request.method).toBe("POST");
        expect(new URL(request.url).pathname).toBe("/api/v1/agents");
        return Response.json({
          metadata: metadata("agent-unbound", "Unbound"),
          spec: {
            systemPrompt: "Await identity binding",
            provider: null,
            model: null,
            skills: [],
            subagents: [],
            allowedTools: [],
            mcpConnectors: [],
            identity: null,
          },
          status: { phase: "active", currentVersionId: "agent-version-unbound", version: 1, schedulable: false },
        });
      }),
    );

    await expect(
      new AmaResourceProjectionAdapter(env, "ama-token").createAgent("project-1", {
        name: "Unbound",
        description: null,
        systemPrompt: "Await identity binding",
        provider: null,
        model: null,
        skills: [],
        identityRef: "identity-1",
        idempotencyKey: "create-unbound-agent",
      }),
    ).rejects.toMatchObject({
      kind: "invalid-response",
      message: "AMA created an Agent without a bound identity",
    });
  });

  it("[spec: machines/environment-projection] filters self-hosted Environments and preserves runtime usage per Runner", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/api/v1/environments") {
          return Response.json({
            data: [
              { metadata: metadata("environment-self", "Build host"), spec: { type: "self_hosted" }, status: { phase: "active" } },
              { metadata: metadata("environment-cloud", "Cloud"), spec: { type: "cloud" }, status: { phase: "active" } },
            ],
            pagination: { nextCursor: null, hasMore: false },
          });
        }
        return Response.json({
          data: [
            {
              id: "runner-1",
              name: "Runner east",
              environmentId: "environment-self",
              state: "active",
              currentLoad: 2,
              maxConcurrent: 4,
              runtimeUsage: [
                {
                  runtime: "codex",
                  windows: [{ label: "5 hours", utilization: 28, resetsAt: "2026-09-01T17:00:00.000Z" }],
                },
              ],
              runtimes: [{ runtime: "codex", models: ["gpt-5.6"], version: "1", state: "ready" }],
              lastHeartbeatAt: "2026-09-01T12:01:00.000Z",
            },
            {
              id: "runner-2",
              name: "Runner west",
              environmentId: "environment-self",
              state: "active",
              currentLoad: 1,
              maxConcurrent: 3,
              runtimeUsage: [
                {
                  runtime: "codex",
                  windows: [{ label: "5 hours", utilization: 72, resetsAt: "2026-09-01T18:00:00.000Z" }],
                },
              ],
              runtimes: [{ runtime: "codex", models: ["gpt-5.6"], version: "1", state: "ready" }],
              lastHeartbeatAt: "2026-09-01T12:02:00.000Z",
            },
          ],
          pagination: { nextCursor: null, hasMore: false },
        });
      }),
    );

    await expect(
      new AmaResourceProjectionAdapter(env, "ama-token").listMachinesPage({ projectId: "project-1", limit: 20, cursor: null }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: "environment-self",
          name: "Runner east + 1 runner",
          state: "online",
          current_load: 3,
          max_concurrent: 7,
          runtimes: [{ runtime: "codex", models: ["gpt-5.6"], version: "1", state: "ready" }],
          runner_count: 2,
          runners: [
            expect.objectContaining({
              id: "runner-1",
              name: "Runner east",
              runtime_usage: [
                {
                  runtime: "codex",
                  windows: [{ label: "5 hours", utilization: 28, resets_at: "2026-09-01T17:00:00.000Z" }],
                },
              ],
            }),
            expect.objectContaining({
              id: "runner-2",
              name: "Runner west",
              runtime_usage: [
                {
                  runtime: "codex",
                  windows: [{ label: "5 hours", utilization: 72, resets_at: "2026-09-01T18:00:00.000Z" }],
                },
              ],
            }),
          ],
        }),
      ],
      nextCursor: null,
    });
  });

  it("[spec: machines/runner-aggregation] derives the Machine display name from deterministic usable Runner names", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/api/v1/environments") {
          return Response.json({
            data: [
              { metadata: metadata("environment-empty", "computer-empty"), spec: { type: "self_hosted" }, status: { phase: "active" } },
              { metadata: metadata("environment-one", "computer-one"), spec: { type: "self_hosted" }, status: { phase: "active" } },
              { metadata: metadata("environment-many", "computer-many"), spec: { type: "self_hosted" }, status: { phase: "active" } },
            ],
            pagination: { nextCursor: null, hasMore: false },
          });
        }
        return Response.json({
          data: [
            {
              id: "runner-one",
              name: "solo.local",
              environmentId: "environment-one",
              state: "active",
              currentLoad: 0,
              maxConcurrent: 1,
              runtimeUsage: [],
              runtimes: [],
              lastHeartbeatAt: null,
            },
            {
              id: "runner-zulu",
              name: "zulu.local",
              environmentId: "environment-many",
              state: "active",
              currentLoad: 0,
              maxConcurrent: 1,
              runtimeUsage: [],
              runtimes: [],
              lastHeartbeatAt: null,
            },
            {
              id: "runner-alpha",
              name: "alpha.local",
              environmentId: "environment-many",
              state: "active",
              currentLoad: 0,
              maxConcurrent: 1,
              runtimeUsage: [],
              runtimes: [],
              lastHeartbeatAt: null,
            },
          ],
          pagination: { nextCursor: null, hasMore: false },
        });
      }),
    );

    const result = await new AmaResourceProjectionAdapter(env, "ama-token").listMachinesPage({ projectId: "project-1", limit: 20, cursor: null });

    expect(result.items.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "environment-empty", name: "Waiting for computer" },
      { id: "environment-one", name: "solo.local" },
      { id: "environment-many", name: "alpha.local + 1 runner" },
    ]);
  });

  it("[spec: machines/runner-aggregation] uses one bounded paginated Runner traversal for a Machine collection", async () => {
    const requests: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        requests.push(url);
        if (url.pathname === "/api/v1/environments") {
          return Response.json({
            data: [
              { metadata: metadata("environment-1", "One"), spec: { type: "self_hosted" }, status: { phase: "active" } },
              { metadata: metadata("environment-2", "Two"), spec: { type: "self_hosted" }, status: { phase: "active" } },
            ],
            pagination: { nextCursor: null, hasMore: false },
          });
        }
        const cursor = url.searchParams.get("cursor");
        return Response.json({
          data: [
            {
              id: `runner-${cursor ?? "first"}`,
              name: `Runner ${cursor ?? "first"}`,
              environmentId: cursor ? "environment-2" : "environment-1",
              state: "active",
              currentLoad: 1,
              maxConcurrent: 2,
              runtimeUsage: [],
              runtimes: [],
              lastHeartbeatAt: null,
            },
          ],
          pagination: cursor ? { nextCursor: null, hasMore: false } : { nextCursor: "runner-page-2", hasMore: true },
        });
      }),
    );

    const result = await new AmaResourceProjectionAdapter(env, "ama-token").listMachinesPage({ projectId: "project-1", limit: 20, cursor: null });

    expect(result.items).toHaveLength(2);
    const runnerRequests = requests.filter((url) => url.pathname === "/api/v1/runners");
    expect(runnerRequests).toHaveLength(2);
    expect(runnerRequests.every((url) => !url.searchParams.has("environmentId"))).toBe(true);
    expect(runnerRequests.map((url) => url.searchParams.get("limit"))).toEqual(["100", "100"]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/api/v1/environments") {
          return Response.json({
            data: [{ metadata: metadata("environment-1", "One"), spec: { type: "self_hosted" }, status: { phase: "active" } }],
            pagination: { nextCursor: null, hasMore: false },
          });
        }
        return Response.json({ data: [], pagination: { nextCursor: "repeated", hasMore: true } });
      }),
    );
    await expect(
      new AmaResourceProjectionAdapter(env, "ama-token").listMachinesPage({ projectId: "project-1", limit: 20, cursor: null }),
    ).rejects.toMatchObject({ kind: "invalid-response", message: "Enbor Runner pagination did not advance" });

    let resultBoundRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/api/v1/environments") {
          return Response.json({
            data: [{ metadata: metadata("environment-1", "One"), spec: { type: "self_hosted" }, status: { phase: "active" } }],
            pagination: { nextCursor: null, hasMore: false },
          });
        }
        resultBoundRequests += 1;
        return Response.json({
          data: Array.from({ length: 101 }, (_, index) => ({
            id: `runner-${resultBoundRequests}-${index}`,
            name: `Runner ${resultBoundRequests}-${index}`,
            environmentId: "environment-1",
            state: "offline",
            currentLoad: 0,
            maxConcurrent: 1,
            runtimeUsage: [],
            runtimes: [],
            lastHeartbeatAt: null,
          })),
          pagination: { nextCursor: `page-${resultBoundRequests + 1}`, hasMore: true },
        });
      }),
    );
    await expect(
      new AmaResourceProjectionAdapter(env, "ama-token").listMachinesPage({ projectId: "project-1", limit: 20, cursor: null }),
    ).rejects.toMatchObject({ kind: "invalid-response", message: "AMA returned more resources than requested" });
    expect(resultBoundRequests).toBe(1);

    let pageBoundRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/api/v1/environments") {
          return Response.json({
            data: [{ metadata: metadata("environment-1", "One"), spec: { type: "self_hosted" }, status: { phase: "active" } }],
            pagination: { nextCursor: null, hasMore: false },
          });
        }
        pageBoundRequests += 1;
        return Response.json({ data: [], pagination: { nextCursor: `page-${pageBoundRequests + 1}`, hasMore: true } });
      }),
    );
    await expect(
      new AmaResourceProjectionAdapter(env, "ama-token").listMachinesPage({ projectId: "project-1", limit: 20, cursor: null }),
    ).rejects.toMatchObject({ kind: "invalid-response", message: "Enbor Runner pagination exceeded the safety bound" });
    expect(pageBoundRequests).toBe(100);
  });

  it("[spec: agents/authoritative-projection] fails closed on invalid AMA success responses", async () => {
    const adapter = new AmaResourceProjectionAdapter(env, "ama-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 200 })),
    );
    await expect(adapter.getAgent("project-1", "agent-1")).rejects.toMatchObject({
      kind: "invalid-response",
      message: "AMA returned an invalid resource representation",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ metadata: null, spec: null, status: null })),
    );
    await expect(adapter.getAgent("project-1", "agent-1")).rejects.toMatchObject({
      kind: "invalid-response",
      message: "AMA returned an invalid resource representation",
    });
  });

  it("[spec: agents/authoritative-projection] rejects an AMA collection page larger than the requested limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: Array.from({ length: 3 }, (_, index) => ({
            metadata: metadata(`agent-${index}`, `Agent ${index}`),
            spec: {
              systemPrompt: "Projects work",
              provider: null,
              model: null,
              skills: [],
              allowedTools: [],
              identity: { subject: `subject-${index}`, username: `agent-${index}`, runtime: "codex" },
            },
            status: { phase: "active", schedulable: true },
          })),
          pagination: { nextCursor: null, hasMore: false },
        }),
      ),
    );

    await expect(
      new AmaResourceProjectionAdapter(env, "ama-token").listAgentsPage({
        projectId: "project-1",
        limit: 2,
        cursor: null,
        filters: {},
      }),
    ).rejects.toMatchObject({ kind: "invalid-response", message: "AMA returned more resources than requested" });
  });
});
