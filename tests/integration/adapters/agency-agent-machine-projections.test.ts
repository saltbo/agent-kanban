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
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:01.000Z",
  archivedAt: null,
});

const project = (id = "project-1", name = "Agent Kanban") => ({
  id,
  name,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:01.000Z",
});

describe("Agency Agent and Machine projection adapter", () => {
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

  it.each([
    { name: "non-array data", value: { data: "not-an-array", pagination: {} }, message: "AMA returned an invalid Project page" },
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
      name: "terminal page with cursor",
      value: { data: [], pagination: { hasMore: false, nextCursor: "unexpected" } },
      message: "AMA returned invalid Project pagination",
    },
    {
      name: "more than the requested limit",
      value: { data: Array.from({ length: 101 }, (_, index) => project(`project-${index}`)), pagination: { hasMore: false, nextCursor: null } },
      message: "AMA Project page exceeded the requested limit",
    },
    {
      name: "missing createdAt",
      value: { data: [{ ...project(), createdAt: undefined }], pagination: { hasMore: false, nextCursor: null } },
      message: "AMA returned an invalid Project",
    },
    {
      name: "invalid createdAt",
      value: { data: [{ ...project(), createdAt: "not-a-date" }], pagination: { hasMore: false, nextCursor: null } },
      message: "AMA returned an invalid Project",
    },
    {
      name: "missing updatedAt",
      value: { data: [{ ...project(), updatedAt: undefined }], pagination: { hasMore: false, nextCursor: null } },
      message: "AMA returned an invalid Project",
    },
    {
      name: "invalid updatedAt",
      value: { data: [{ ...project(), updatedAt: "not-a-date" }], pagination: { hasMore: false, nextCursor: null } },
      message: "AMA returned an invalid Project",
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
                allowedTools: ["bash"],
                identity: { subject: "realmroot-agent-subject", username: "backend", runtime: "codex" },
              },
              status: { phase: "active", schedulable: true },
            },
            {
              metadata: metadata("agent-2", "Unbound"),
              spec: {
                systemPrompt: "Await identity binding",
                provider: null,
                model: null,
                skills: [],
                allowedTools: [],
                identity: null,
              },
              status: { phase: "archived", schedulable: false },
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
          phase: "archived",
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
            allowedTools: [],
            identity: null,
          },
          status: { phase: "active", schedulable: false },
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
          name: "Build host",
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

  it("[spec: machines/runner-aggregation] rejects a Runner usage window with an invalid reset timestamp", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/api/v1/environments") {
          return Response.json({
            data: [{ metadata: metadata("environment-self", "Build host"), spec: { type: "self_hosted" }, status: { phase: "active" } }],
            pagination: { nextCursor: null, hasMore: false },
          });
        }
        return Response.json({
          data: [
            {
              id: "runner-invalid-reset",
              name: "Runner invalid reset",
              environmentId: "environment-self",
              state: "active",
              currentLoad: 0,
              maxConcurrent: 1,
              runtimeUsage: [{ runtime: "codex", windows: [{ label: "5 hours", utilization: 25, resetsAt: "not-a-date" }] }],
              runtimes: [{ runtime: "codex", models: ["gpt-5.6"], state: "ready" }],
              lastHeartbeatAt: "2026-09-01T12:01:00.000Z",
            },
          ],
          pagination: { nextCursor: null, hasMore: false },
        });
      }),
    );

    await expect(
      new AmaResourceProjectionAdapter(env, "ama-token").listMachinesPage({ projectId: "project-1", limit: 20, cursor: null }),
    ).rejects.toMatchObject({ kind: "invalid-response", message: "AMA returned an invalid resource representation" });
  });

  it("[spec: agents/authoritative-projection] [spec: machines/environment-projection] preserves AMA Agent pages while hiding archived Machines", async () => {
    const archivedAgent = {
      metadata: { ...metadata("agent-archived", "Archived Agent"), archivedAt: "2026-09-01T13:00:00.000Z" },
      spec: {
        systemPrompt: "Archived",
        provider: null,
        model: null,
        skills: [],
        allowedTools: [],
        identity: { subject: "agent-subject", username: "archived", runtime: "codex" },
      },
      status: { phase: "archived", schedulable: false },
    };
    const archivedEnvironment = {
      metadata: { ...metadata("environment-archived", "Archived Machine"), archivedAt: "2026-09-01T13:00:00.000Z" },
      spec: { type: "self_hosted" },
      status: { phase: "archived" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/api/v1/agents") {
          return Response.json({ data: [archivedAgent], pagination: { nextCursor: null, hasMore: false } });
        }
        if (url.pathname === "/api/v1/environments") {
          return Response.json({ data: [archivedEnvironment], pagination: { nextCursor: null, hasMore: false } });
        }
        if (url.pathname === "/api/v1/runners") return Response.json({ data: [], pagination: { nextCursor: null, hasMore: false } });
        if (url.pathname.endsWith("/agent-archived")) return Response.json(archivedAgent);
        if (url.pathname.endsWith("/environment-archived")) return Response.json(archivedEnvironment);
        throw new Error(`Unexpected URL ${url}`);
      }),
    );
    const adapter = new AmaResourceProjectionAdapter(env, "ama-token");

    await expect(adapter.listAgentsPage({ projectId: "project-1", limit: 20, cursor: null, filters: {} })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: "agent-archived", phase: "archived" })],
    });
    await expect(adapter.listMachinesPage({ projectId: "project-1", limit: 20, cursor: null })).resolves.toMatchObject({ items: [] });
    await expect(adapter.getAgent("project-1", "agent-archived")).resolves.toMatchObject({ id: "agent-archived", phase: "archived" });
    await expect(adapter.getMachine("project-1", "environment-archived")).resolves.toMatchObject({
      id: "environment-archived",
      state: "disabled",
    });
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
    ).rejects.toMatchObject({ kind: "invalid-response", message: "AMA Runner pagination exceeded the safety bound" });
    expect(pageBoundRequests).toBe(100);
  });

  it("[spec: agents/authoritative-projection] [spec: machines/archive-environment] fails closed on invalid AMA success responses", async () => {
    const adapter = new AmaResourceProjectionAdapter(env, "ama-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 200 })),
    );
    await expect(adapter.getAgent("project-1", "agent-1")).rejects.toMatchObject({ kind: "invalid-response", message: "AMA returned invalid JSON" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ metadata: metadata("environment-1", "Machine"), spec: { type: "self_hosted" }, status: { phase: "active" } }),
      ),
    );
    await expect(adapter.archiveMachine("project-1", "environment-1")).rejects.toMatchObject({
      kind: "invalid-response",
      message: "AMA did not confirm Machine archival",
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
