// @vitest-environment node

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getSystemStats } from "../apps/web/server/statsRepo";
import { createTestAgent, createTestEnv, createTestWebSession, seedUser, setupMiniflare } from "./helpers/db";

const env = createTestEnv();
let mf: Miniflare;

// hey-api's fetch client calls fetch(request) with a single Request object,
// not fetch(url, init). These helpers normalise both call signatures so mocks
// can read url, method, and body regardless of which form is used.
function reqUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}
// hey-api defaults to parseAs:'auto' which infers JSON only when Content-Type
// is application/json. Always include it so the SDK parses the body correctly.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function apiRequest(method: string, path: string, body?: Record<string, unknown>, token?: string) {
  const { api } = await import("../apps/web/server/routes");
  const headers: Record<string, string> = { "Content-Type": "application/json", Host: "localhost:8788", "x-forwarded-proto": "http" };
  if (token) headers.cookie = `ak_session=${token}`;
  const init: RequestInit = { method, headers };
  if (body && method !== "GET") init.body = JSON.stringify(body);
  return api.request(path, init, env);
}

beforeAll(async () => {
  ({ mf, db: env.DB } = await setupMiniflare());
});

afterAll(async () => {
  await mf.dispose();
});

// ─── getSystemStats unit tests ───

describe("getSystemStats", () => {
  it("returns the correct shape with all expected top-level fields", async () => {
    const stats = await getSystemStats(env.DB);
    expect(stats).toHaveProperty("agents");
    expect(stats).toHaveProperty("tasks");
    expect(stats).toHaveProperty("boards");
    expect(stats).toHaveProperty("runtime_sessions");
  });

  it("returns agents.total as a number", async () => {
    const stats = await getSystemStats(env.DB);
    expect(typeof stats.agents.total).toBe("number");
  });

  it("returns agents.online as a number", async () => {
    const stats = await getSystemStats(env.DB);
    expect(typeof stats.agents.online).toBe("number");
  });

  it("returns tasks with all five status fields", async () => {
    const stats = await getSystemStats(env.DB);
    expect(typeof stats.tasks.todo).toBe("number");
    expect(typeof stats.tasks.in_progress).toBe("number");
    expect(typeof stats.tasks.in_review).toBe("number");
    expect(typeof stats.tasks.done).toBe("number");
    expect(typeof stats.tasks.cancelled).toBe("number");
  });

  it("returns boards.total as a number", async () => {
    const stats = await getSystemStats(env.DB);
    expect(typeof stats.boards.total).toBe("number");
  });

  it("returns runtime_sessions.total as a number", async () => {
    const stats = await getSystemStats(env.DB);
    expect(typeof stats.runtime_sessions.total).toBe("number");
  });

  it("returns runtime_sessions.active as a number", async () => {
    const stats = await getSystemStats(env.DB);
    expect(typeof stats.runtime_sessions.active).toBe("number");
  });

  it("returns zero task counts on an empty database", async () => {
    const stats = await getSystemStats(env.DB);
    expect(stats.tasks.todo).toBe(0);
    expect(stats.tasks.in_progress).toBe(0);
    expect(stats.tasks.in_review).toBe(0);
    expect(stats.tasks.done).toBe(0);
    expect(stats.tasks.cancelled).toBe(0);
  });

  it("returns zero board count on an empty database", async () => {
    const stats = await getSystemStats(env.DB);
    expect(stats.boards.total).toBe(0);
  });

  it("returns zero runtime session counts on an empty database", async () => {
    const stats = await getSystemStats(env.DB);
    expect(stats.runtime_sessions.total).toBe(0);
    expect(stats.runtime_sessions.active).toBe(0);
  });

  it("returns zero agent counts on an empty database", async () => {
    const stats = await getSystemStats(env.DB);
    expect(stats.agents.total).toBe(0);
    expect(stats.agents.online).toBe(0);
  });

  it("reflects seeded boards in boards.total", async () => {
    const before = await getSystemStats(env.DB);
    const userId = "stats-board-owner";
    await seedUser(env.DB, userId, "stats-board-owner@test.com");
    const { createBoard } = await import("../apps/web/server/boardRepo");
    await createBoard(env.DB, userId, "Stats Test Board", "dev");
    const after = await getSystemStats(env.DB);
    expect(after.boards.total).toBeGreaterThan(before.boards.total);
  });

  it("reflects task status counts after seeding tasks", async () => {
    const userId = "stats-task-owner";
    await seedUser(env.DB, userId, "stats-task-owner@test.com");
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const board = await createBoard(env.DB, userId, "Stats Task Board", "ops");
    const { createTask } = await import("../apps/web/server/taskRepo");
    await createTask(env.DB, userId, { title: "Stats Todo Task", board_id: board.id });

    const stats = await getSystemStats(env.DB);
    expect(stats.tasks.todo).toBeGreaterThanOrEqual(1);
  });

  it("reflects done task count after updating task to done", async () => {
    const userId = "stats-done-owner";
    await seedUser(env.DB, userId, "stats-done-owner@test.com");
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const board = await createBoard(env.DB, userId, "Stats Done Board", "ops");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Stats Done Task", board_id: board.id });
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").bind(task.id).run();

    const stats = await getSystemStats(env.DB);
    expect(stats.tasks.done).toBeGreaterThanOrEqual(1);
  });

  it("reflects seeded agents in agents.total", async () => {
    const before = await getSystemStats(env.DB);
    const userId = "stats-agent-owner";
    await seedUser(env.DB, userId, "stats-agent-owner@test.com");
    await createTestAgent(env.DB, userId, { name: "Stats Agent", username: "stats-agent", runtime: "claude" });
    const after = await getSystemStats(env.DB);
    expect(after.agents.total).toBeGreaterThan(before.agents.total);
  });
});

// ─── GET /api/admin/stats route tests ───

describe("GET /api/admin/stats", () => {
  let adminToken: string;
  let regularToken: string;

  beforeAll(async () => {
    await seedUser(env.DB, "admin-stats-user", "admin-stats@test.com");
    await seedUser(env.DB, "regular-stats-user", "regular-stats@test.com");
    adminToken = (await createTestWebSession(env.DB, "admin-stats-user", { role: "admin" })).token;
    regularToken = (await createTestWebSession(env.DB, "regular-stats-user")).token;
  });

  it("returns 401 when no token is provided", async () => {
    const res = await apiRequest("GET", "/api/admin/stats");
    expect(res.status).toBe(401);
  });

  it("returns 403 for a regular (non-admin) user", async () => {
    const res = await apiRequest("GET", "/api/admin/stats", undefined, regularToken);
    expect(res.status).toBe(403);
  });

  it("returns FORBIDDEN error code for a non-admin user", async () => {
    const res = await apiRequest("GET", "/api/admin/stats", undefined, regularToken);
    const body = (await res.json()) as any;
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("returns 200 for an admin user", async () => {
    const res = await apiRequest("GET", "/api/admin/stats", undefined, adminToken);
    expect(res.status).toBe(200);
  });

  it("returns agents field in stats for an admin user", async () => {
    const res = await apiRequest("GET", "/api/admin/stats", undefined, adminToken);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty("agents");
  });

  it("returns tasks field in stats for an admin user", async () => {
    const res = await apiRequest("GET", "/api/admin/stats", undefined, adminToken);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty("tasks");
  });

  it("returns boards field in stats for an admin user", async () => {
    const res = await apiRequest("GET", "/api/admin/stats", undefined, adminToken);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty("boards");
  });

  it("returns runtime_sessions field in stats for an admin user", async () => {
    const res = await apiRequest("GET", "/api/admin/stats", undefined, adminToken);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty("runtime_sessions");
  });

  it("returns numeric agents.total for an admin user", async () => {
    const res = await apiRequest("GET", "/api/admin/stats", undefined, adminToken);
    const body = (await res.json()) as any;
    expect(typeof body.agents.total).toBe("number");
  });

  it("returns numeric agents.online for an admin user", async () => {
    const res = await apiRequest("GET", "/api/admin/stats", undefined, adminToken);
    const body = (await res.json()) as any;
    expect(typeof body.agents.online).toBe("number");
  });

  it("derives machine online stats from AMA runners when AMA dispatch is configured", async () => {
    const previousAma = {
      AMA_ORIGIN: env.AMA_ORIGIN,
      AMA_RESOURCE: env.AMA_RESOURCE,
    };
    Object.assign(env, {
      AMA_ORIGIN: "https://ama.test",
      AMA_RESOURCE: "https://ama.test/api",
    });
    const ownerId = "admin-ama-machine-owner";
    const machineId = "admin-ama-machine";
    const now = new Date().toISOString();
    // The owner connects AMA as their own account; seedUser links the "ama"
    // account so the admin stats route can resolve a per-user runner token.
    await seedUser(env.DB, ownerId, `${ownerId}@test.local`);
    await env.DB.prepare(
      `INSERT INTO ama_owner_integrations (tenant_id, ama_project_id, session_secret_vault_id, metadata)
       VALUES (?, 'project_admin_stats', 'vault_admin_stats', '{}')
       ON CONFLICT(tenant_id) DO UPDATE SET ama_project_id = excluded.ama_project_id`,
    )
      .bind(ownerId)
      .run();
    await env.DB.prepare(
      `INSERT INTO machines (id, owner_id, device_id, name, os, version, runtimes, status, last_heartbeat_at, created_at, ama_environment_id)
       VALUES (?, ?, 'admin-ama-device', 'admin AMA machine', 'test', '1.0.0', ?, 'offline', ?, ?, 'env_admin_stats')
       ON CONFLICT(owner_id, device_id) DO UPDATE SET status = 'offline', ama_environment_id = 'env_admin_stats'`,
    )
      .bind(machineId, ownerId, JSON.stringify([{ name: "codex", status: "ready", checked_at: now }]), now, now)
      .run();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = reqUrl(input);
        if (url === "https://auth.test/.well-known/openid-configuration") {
          return jsonResponse({ access_token: "oauth-token" });
        }
        if (url === "https://ama.test/api/v1/runners?environmentId=env_admin_stats&limit=100") {
          return jsonResponse({
            data: [
              {
                id: "runner_admin_stats",
                environmentId: "env_admin_stats",
                state: "active",
                runtimes: [{ runtime: "codex", models: ["gpt-5.3-codex"], state: "ready" }],
                currentLoad: 0,
                maxConcurrent: 5,
                lastHeartbeatAt: new Date().toISOString(),
              },
            ],
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    try {
      const res = await apiRequest("GET", "/api/admin/stats", undefined, adminToken);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.machines.online).toBe(1);
    } finally {
      Object.assign(env, previousAma);
      vi.unstubAllGlobals();
    }
  });

  it("returns numeric tasks.todo for an admin user", async () => {
    const res = await apiRequest("GET", "/api/admin/stats", undefined, adminToken);
    const body = (await res.json()) as any;
    expect(typeof body.tasks.todo).toBe("number");
  });

  it("returns numeric boards.total for an admin user", async () => {
    const res = await apiRequest("GET", "/api/admin/stats", undefined, adminToken);
    const body = (await res.json()) as any;
    expect(typeof body.boards.total).toBe("number");
  });

  it("returns numeric runtime_sessions.total for an admin user", async () => {
    const res = await apiRequest("GET", "/api/admin/stats", undefined, adminToken);
    const body = (await res.json()) as any;
    expect(typeof body.runtime_sessions.total).toBe("number");
  });

  it("returns numeric runtime_sessions.active for an admin user", async () => {
    const res = await apiRequest("GET", "/api/admin/stats", undefined, adminToken);
    const body = (await res.json()) as any;
    expect(typeof body.runtime_sessions.active).toBe("number");
  });
});
