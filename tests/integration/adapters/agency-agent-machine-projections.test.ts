// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AmaProjectCatalogAdapter } from "../../../server/adapters/agency/projectCatalog";
import { AmaResourceProjectionAdapter } from "../../../server/adapters/agency/resourceProjections";
import type { Env } from "../../../server/env";

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

const project = (id = "project-1", name = "Agent Kanban tenant-1") => ({
  id,
  name,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:01.000Z",
});

describe("Agency Agent and Machine projection adapter", () => {
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

    await expect(new AmaProjectCatalogAdapter(env, "ama-token").listProjects(vi.fn())).rejects.toMatchObject({ status: 502, message });
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
      status: 502,
      message: "AMA Project pagination did not advance",
    });
  });

  it("[spec: agents/authoritative-projection] maps AMA data pages and Agent identity to the safe AK projection", async () => {
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
          ],
          pagination: { nextCursor: null, hasMore: false },
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
      ],
      nextCursor: null,
    });
  });

  it("[spec: machines/environment-projection] filters self-hosted Environments and aggregates Runner runtime objects", async () => {
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
              environmentId: "environment-self",
              state: "active",
              currentLoad: 2,
              maxConcurrent: 4,
              runtimes: [{ runtime: "codex", models: ["gpt-5.6"], version: "1", state: "ready" }],
              lastHeartbeatAt: "2026-09-01T12:01:00.000Z",
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
          current_load: 2,
          max_concurrent: 4,
          runtimes: [{ runtime: "codex", models: ["gpt-5.6"], version: "1", state: "ready" }],
        }),
      ],
      nextCursor: null,
    });
  });

  it("[spec: agents/authoritative-projection] [spec: machines/environment-projection] hides archived collections but preserves direct reads", async () => {
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

    await expect(adapter.listAgentsPage({ projectId: "project-1", limit: 20, cursor: null, filters: {} })).resolves.toMatchObject({ items: [] });
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
              environmentId: cursor ? "environment-2" : "environment-1",
              state: "active",
              currentLoad: 1,
              maxConcurrent: 2,
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
            environmentId: "environment-1",
            state: "offline",
            currentLoad: 0,
            maxConcurrent: 1,
            runtimes: [],
            lastHeartbeatAt: null,
          })),
          pagination: { nextCursor: `page-${resultBoundRequests + 1}`, hasMore: true },
        });
      }),
    );
    await expect(
      new AmaResourceProjectionAdapter(env, "ama-token").listMachinesPage({ projectId: "project-1", limit: 20, cursor: null }),
    ).rejects.toMatchObject({ status: 502, message: "AMA returned more resources than requested" });
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
    ).rejects.toMatchObject({ status: 502, message: "AMA Runner pagination exceeded the safety bound" });
    expect(pageBoundRequests).toBe(100);
  });

  it("[spec: agents/authoritative-projection] [spec: machines/archive-environment] fails closed on invalid AMA success responses", async () => {
    const adapter = new AmaResourceProjectionAdapter(env, "ama-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 200 })),
    );
    await expect(adapter.getAgent("project-1", "agent-1")).rejects.toMatchObject({ status: 502, message: "AMA returned invalid JSON" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ metadata: metadata("environment-1", "Machine"), spec: { type: "self_hosted" }, status: { phase: "active" } }),
      ),
    );
    await expect(adapter.archiveMachine("project-1", "environment-1")).rejects.toMatchObject({
      status: 502,
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
    ).rejects.toMatchObject({ status: 502, message: "AMA returned more resources than requested" });
  });
});
