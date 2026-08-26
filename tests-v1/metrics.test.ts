// @vitest-environment node

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestEnv, createTestWebSession, seedUser, setupMiniflare } from "./helpers/db";

// ─── metricsMiddleware unit tests ───

describe("metricsMiddleware", () => {
  it("calls writeDataPoint when machineId is set in context", async () => {
    const { metricsMiddleware } = await import("../apps/web/server/metrics");

    const writeDataPoint = vi.fn();
    const c = {
      env: { AE: { writeDataPoint } },
      get: (key: string) => {
        if (key === "machineId") return "machine-abc";
        if (key === "identityType") return "machine";
        return undefined;
      },
      req: { method: "GET", path: "/api/machines" },
      res: { status: 200 },
    } as any;

    await metricsMiddleware(c, async () => {});

    expect(writeDataPoint).toHaveBeenCalledOnce();
  });

  it("passes machineId as the index when writing data point", async () => {
    const { metricsMiddleware } = await import("../apps/web/server/metrics");

    const writeDataPoint = vi.fn();
    const c = {
      env: { AE: { writeDataPoint } },
      get: (key: string) => {
        if (key === "machineId") return "machine-xyz";
        if (key === "identityType") return "machine";
        return undefined;
      },
      req: { method: "POST", path: "/api/tasks" },
      res: { status: 201 },
    } as any;

    await metricsMiddleware(c, async () => {});

    const call = writeDataPoint.mock.calls[0][0];
    expect(call.indexes).toEqual(["machine-xyz"]);
  });

  it("writes method and path as blobs", async () => {
    const { metricsMiddleware } = await import("../apps/web/server/metrics");

    const writeDataPoint = vi.fn();
    const c = {
      env: { AE: { writeDataPoint } },
      get: (key: string) => {
        if (key === "machineId") return "machine-123";
        if (key === "identityType") return "machine";
        return undefined;
      },
      req: { method: "DELETE", path: "/api/tasks/99" },
      res: { status: 204 },
    } as any;

    await metricsMiddleware(c, async () => {});

    const call = writeDataPoint.mock.calls[0][0];
    expect(call.blobs[0]).toBe("DELETE");
    expect(call.blobs[1]).toBe("/api/tasks/99");
  });

  it("writes identityType as third blob", async () => {
    const { metricsMiddleware } = await import("../apps/web/server/metrics");

    const writeDataPoint = vi.fn();
    const c = {
      env: { AE: { writeDataPoint } },
      get: (key: string) => {
        if (key === "machineId") return "machine-123";
        if (key === "identityType") return "agent:worker";
        return undefined;
      },
      req: { method: "GET", path: "/api/boards" },
      res: { status: 200 },
    } as any;

    await metricsMiddleware(c, async () => {});

    const call = writeDataPoint.mock.calls[0][0];
    expect(call.blobs[2]).toBe("agent:worker");
  });

  it("falls back to unknown when identityType is not set", async () => {
    const { metricsMiddleware } = await import("../apps/web/server/metrics");

    const writeDataPoint = vi.fn();
    const c = {
      env: { AE: { writeDataPoint } },
      get: (key: string) => {
        if (key === "machineId") return "machine-no-type";
        return undefined;
      },
      req: { method: "GET", path: "/api/agents" },
      res: { status: 200 },
    } as any;

    await metricsMiddleware(c, async () => {});

    const call = writeDataPoint.mock.calls[0][0];
    expect(call.blobs[2]).toBe("unknown");
  });

  it("writes status code as first double", async () => {
    const { metricsMiddleware } = await import("../apps/web/server/metrics");

    const writeDataPoint = vi.fn();
    const c = {
      env: { AE: { writeDataPoint } },
      get: (key: string) => {
        if (key === "machineId") return "machine-status";
        if (key === "identityType") return "machine";
        return undefined;
      },
      req: { method: "GET", path: "/api/boards" },
      res: { status: 404 },
    } as any;

    await metricsMiddleware(c, async () => {});

    const call = writeDataPoint.mock.calls[0][0];
    expect(call.doubles[0]).toBe(404);
  });

  it("writes a numeric latency as second double", async () => {
    const { metricsMiddleware } = await import("../apps/web/server/metrics");

    const writeDataPoint = vi.fn();
    const c = {
      env: { AE: { writeDataPoint } },
      get: (key: string) => {
        if (key === "machineId") return "machine-latency";
        if (key === "identityType") return "machine";
        return undefined;
      },
      req: { method: "GET", path: "/api/boards" },
      res: { status: 200 },
    } as any;

    await metricsMiddleware(c, async () => {});

    const call = writeDataPoint.mock.calls[0][0];
    expect(typeof call.doubles[1]).toBe("number");
    expect(call.doubles[1]).toBeGreaterThanOrEqual(0);
  });

  it("does NOT call writeDataPoint when machineId is absent", async () => {
    const { metricsMiddleware } = await import("../apps/web/server/metrics");

    const writeDataPoint = vi.fn();
    const c = {
      env: { AE: { writeDataPoint } },
      get: () => undefined,
      req: { method: "GET", path: "/api/boards" },
      res: { status: 200 },
    } as any;

    await metricsMiddleware(c, async () => {});

    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it("calls next() before writing the data point", async () => {
    const { metricsMiddleware } = await import("../apps/web/server/metrics");

    const order: string[] = [];
    const writeDataPoint = vi.fn(() => order.push("writeDataPoint"));
    const c = {
      env: { AE: { writeDataPoint } },
      get: (key: string) => {
        if (key === "machineId") return "machine-order";
        if (key === "identityType") return "machine";
        return undefined;
      },
      req: { method: "GET", path: "/api/boards" },
      res: { status: 200 },
    } as any;

    const next = async () => {
      order.push("next");
    };

    await metricsMiddleware(c, next);

    expect(order[0]).toBe("next");
    expect(order[1]).toBe("writeDataPoint");
  });
});

// ─── getMachineMetrics unit tests ───

describe("getMachineMetrics", () => {
  it("throws when the AE API call fails", async () => {
    const { getMachineMetrics } = await import("../apps/web/server/metricsRepo");

    const env = {
      CF_ACCOUNT_ID: "acc-123",
      CF_API_TOKEN: "token-abc",
    } as any;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Internal Server Error", { status: 500 })),
    );

    await expect(getMachineMetrics(env)).rejects.toThrow("Analytics Engine query failed: 500");

    vi.unstubAllGlobals();
  });

  it("returns an empty map when AE response has no data rows", async () => {
    const { getMachineMetrics } = await import("../apps/web/server/metricsRepo");

    const env = {
      CF_ACCOUNT_ID: "acc-123",
      CF_API_TOKEN: "token-abc",
    } as any;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [], rows: 0 })),
    );

    const result = await getMachineMetrics(env);
    expect(result.size).toBe(0);

    vi.unstubAllGlobals();
  });

  it("returns a map entry per AE row", async () => {
    const { getMachineMetrics } = await import("../apps/web/server/metricsRepo");

    const env = {
      CF_ACCOUNT_ID: "acc-123",
      CF_API_TOKEN: "token-abc",
    } as any;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            { machine_id: "m1", total_requests: 300, error_requests: 30, avg_latency: 120.5 },
            { machine_id: "m2", total_requests: 600, error_requests: 0, avg_latency: 45.2 },
          ],
          rows: 2,
        }),
      ),
    );

    const result = await getMachineMetrics(env);
    expect(result.size).toBe(2);
    expect(result.has("m1")).toBe(true);
    expect(result.has("m2")).toBe(true);

    vi.unstubAllGlobals();
  });

  it("computes qps as total_requests divided by 300 seconds", async () => {
    const { getMachineMetrics } = await import("../apps/web/server/metricsRepo");

    const env = {
      CF_ACCOUNT_ID: "acc-123",
      CF_API_TOKEN: "token-abc",
    } as any;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [{ machine_id: "m1", total_requests: 300, error_requests: 0, avg_latency: 50 }],
          rows: 1,
        }),
      ),
    );

    const result = await getMachineMetrics(env);
    expect(result.get("m1")!.qps).toBe(1);

    vi.unstubAllGlobals();
  });

  it("computes error_rate as a percentage of error requests", async () => {
    const { getMachineMetrics } = await import("../apps/web/server/metricsRepo");

    const env = {
      CF_ACCOUNT_ID: "acc-123",
      CF_API_TOKEN: "token-abc",
    } as any;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [{ machine_id: "m1", total_requests: 100, error_requests: 25, avg_latency: 50 }],
          rows: 1,
        }),
      ),
    );

    const result = await getMachineMetrics(env);
    expect(result.get("m1")!.error_rate).toBe(25);

    vi.unstubAllGlobals();
  });

  it("returns error_rate of 0 when total_requests is 0", async () => {
    const { getMachineMetrics } = await import("../apps/web/server/metricsRepo");

    const env = {
      CF_ACCOUNT_ID: "acc-123",
      CF_API_TOKEN: "token-abc",
    } as any;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [{ machine_id: "m1", total_requests: 0, error_requests: 0, avg_latency: 0 }],
          rows: 1,
        }),
      ),
    );

    const result = await getMachineMetrics(env);
    expect(result.get("m1")!.error_rate).toBe(0);

    vi.unstubAllGlobals();
  });

  it("rounds avg_latency_ms to nearest integer", async () => {
    const { getMachineMetrics } = await import("../apps/web/server/metricsRepo");

    const env = {
      CF_ACCOUNT_ID: "acc-123",
      CF_API_TOKEN: "token-abc",
    } as any;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [{ machine_id: "m1", total_requests: 10, error_requests: 0, avg_latency: 123.7 }],
          rows: 1,
        }),
      ),
    );

    const result = await getMachineMetrics(env);
    expect(result.get("m1")!.avg_latency_ms).toBe(124);

    vi.unstubAllGlobals();
  });

  it("preserves total_requests on each returned entry", async () => {
    const { getMachineMetrics } = await import("../apps/web/server/metricsRepo");

    const env = {
      CF_ACCOUNT_ID: "acc-123",
      CF_API_TOKEN: "token-abc",
    } as any;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [{ machine_id: "m1", total_requests: 42, error_requests: 1, avg_latency: 10 }],
          rows: 1,
        }),
      ),
    );

    const result = await getMachineMetrics(env);
    expect(result.get("m1")!.total_requests).toBe(42);

    vi.unstubAllGlobals();
  });

  it("sends the Bearer token in the Authorization header", async () => {
    const { getMachineMetrics } = await import("../apps/web/server/metricsRepo");

    const env = {
      CF_ACCOUNT_ID: "acc-test",
      CF_API_TOKEN: "my-secret-token",
    } as any;

    let capturedHeaders: Headers | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedHeaders = new Headers(init.headers as any);
        return Response.json({ data: [], rows: 0 });
      }),
    );

    await getMachineMetrics(env);
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer my-secret-token");

    vi.unstubAllGlobals();
  });

  it("queries the correct CF account endpoint", async () => {
    const { getMachineMetrics } = await import("../apps/web/server/metricsRepo");

    const env = {
      CF_ACCOUNT_ID: "myaccount",
      CF_API_TOKEN: "tok",
    } as any;

    let capturedUrl: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        capturedUrl = url;
        return Response.json({ data: [], rows: 0 });
      }),
    );

    await getMachineMetrics(env);
    expect(capturedUrl).toContain("myaccount");
    expect(capturedUrl).toContain("analytics_engine/sql");

    vi.unstubAllGlobals();
  });
});

// ─── GET /api/admin/machines route tests ───

const routeEnv = createTestEnv();
let mf: Miniflare;

async function apiRequest(method: string, path: string, body?: Record<string, unknown>, token?: string) {
  const { api } = await import("../apps/web/server/routes");
  const headers: Record<string, string> = { "Content-Type": "application/json", Host: "localhost:8788", "x-forwarded-proto": "http" };
  if (token) headers.cookie = `ak_session=${token}`;
  const init: RequestInit = { method, headers };
  if (body && method !== "GET") init.body = JSON.stringify(body);
  return api.request(path, init, routeEnv);
}

beforeAll(async () => {
  ({ mf, db: routeEnv.DB } = await setupMiniflare());
});

afterAll(async () => {
  await mf.dispose();
});

describe("GET /api/admin/machines", () => {
  let adminToken: string;
  let regularToken: string;

  beforeAll(async () => {
    await seedUser(routeEnv.DB, "admin-machines-user", "admin-machines@test.com");
    await seedUser(routeEnv.DB, "regular-machines-user", "regular-machines@test.com");
    adminToken = (await createTestWebSession(routeEnv.DB, "admin-machines-user", { role: "admin" })).token;
    regularToken = (await createTestWebSession(routeEnv.DB, "regular-machines-user")).token;

    // stub fetch so getMachineMetrics does not make real network calls
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [], rows: 0 })),
    );
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("returns 401 when no token is provided", async () => {
    const res = await apiRequest("GET", "/api/admin/machines");
    expect(res.status).toBe(401);
  });

  it("returns 403 for a regular (non-admin) user", async () => {
    const res = await apiRequest("GET", "/api/admin/machines", undefined, regularToken);
    expect(res.status).toBe(403);
  });

  it("returns FORBIDDEN error code for a non-admin user", async () => {
    const res = await apiRequest("GET", "/api/admin/machines", undefined, regularToken);
    const body = (await res.json()) as any;
    expect(body.error?.code).toBe("FORBIDDEN");
  });

  it("returns 200 for an admin user", async () => {
    const res = await apiRequest("GET", "/api/admin/machines", undefined, adminToken);
    expect(res.status).toBe(200);
  });

  it("returns an array in the response body for admin", async () => {
    const res = await apiRequest("GET", "/api/admin/machines", undefined, adminToken);
    const body = (await res.json()) as any;
    expect(Array.isArray(body)).toBe(true);
  });

  it("returns an empty array when no machines are registered", async () => {
    const res = await apiRequest("GET", "/api/admin/machines", undefined, adminToken);
    const body = (await res.json()) as any;
    expect(body).toHaveLength(0);
  });

  it("includes owner_name and owner_email on each machine entry", async () => {
    const ownerId = "admin-machines-owner";
    await seedUser(routeEnv.DB, ownerId, "machines-owner@test.com");
    const { upsertMachine } = await import("../apps/web/server/machineRepo");
    await upsertMachine(routeEnv.DB, ownerId, {
      name: "Test Machine",
      os: "linux",
      version: "1.0.0",
      runtimes: [{ name: "claude", status: "ready", checked_at: "2026-03-21T10:00:00Z" }],
      device_id: "device-admin-machines-test",
    });

    const res = await apiRequest("GET", "/api/admin/machines", undefined, adminToken);
    const body = (await res.json()) as any[];
    const machine = body.find((m) => m.name === "Test Machine");
    expect(machine).toBeDefined();
    expect(machine.owner_name).toBe("Test User");
    expect(machine.owner_email).toBe("machines-owner@test.com");
  });

  it("includes metrics field on each machine entry (null when no AE data)", async () => {
    const res = await apiRequest("GET", "/api/admin/machines", undefined, adminToken);
    const body = (await res.json()) as any[];
    for (const machine of body) {
      expect("metrics" in machine).toBe(true);
    }
  });

  it("parses runtimes as an array on each machine entry", async () => {
    const res = await apiRequest("GET", "/api/admin/machines", undefined, adminToken);
    const body = (await res.json()) as any[];
    const machine = body.find((m) => m.name === "Test Machine");
    expect(machine).toBeDefined();
    expect(Array.isArray(machine.runtimes)).toBe(true);
  });
});
