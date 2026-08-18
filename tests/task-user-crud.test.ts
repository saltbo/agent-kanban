// @vitest-environment node

// User-driven task management from the WebUI: POST/PATCH/DELETE /api/tasks and
// POST /api/tasks/:id/assign now allow the "user" identity (previously
// agent-only). These tests pin the new policy: user session is accepted,
// machine API keys remain forbidden.

import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestAgent, createTestEnv, setupMiniflare, signUpVerifiedUser } from "./helpers/db";

const env = createTestEnv();
let mf: Miniflare;

async function apiRequest(method: string, path: string, body?: unknown, token?: string) {
  const { api } = await import("../apps/web/server/routes");
  const headers: Record<string, string> = { "Content-Type": "application/json", Host: "localhost:8788", "x-forwarded-proto": "http" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined && method !== "GET") init.body = JSON.stringify(body);
  return api.request(path, init, env);
}

beforeAll(async () => {
  ({ mf, db: env.DB } = await setupMiniflare());
});

afterAll(async () => {
  await mf.dispose();
});

describe("user-driven task CRUD from the WebUI", () => {
  let userToken: string;
  let userId: string;
  let machineApiKey: string;
  let boardId: string;
  let workerAgentId: string;

  beforeAll(async () => {
    const { createAuth } = await import("../apps/web/server/betterAuth");
    const auth = createAuth(env);
    const session = await signUpVerifiedUser(env.DB, auth, {
      name: "Task User",
      email: "task-user-crud@test.com",
      password: "test-password-123",
    });
    userToken = session.token;
    userId = session.user.id;

    // Machine identity (API key) for the negative policy test and for
    // registering a local machine so the "claude" runtime is dispatchable.
    const keyResult = await auth.api.createApiKey({ body: { userId } });
    machineApiKey = keyResult.key;

    const machineRes = await apiRequest(
      "POST",
      "/api/machines",
      {
        name: "task-user-crud-machine",
        os: "darwin",
        version: "1.0.0",
        runtimes: [{ name: "claude", status: "ready", checked_at: new Date().toISOString() }],
        device_id: "task-user-crud-device",
      },
      machineApiKey,
    );
    expect(machineRes.status).toBe(201);
    const machineId = ((await machineRes.json()) as { id: string }).id;
    const heartbeatRes = await apiRequest("POST", `/api/machines/${machineId}/heartbeat`, {}, machineApiKey);
    expect(heartbeatRes.status).toBe(200);

    const worker = await createTestAgent(env.DB, userId, {
      name: "User Crud Worker",
      username: "user-crud-worker",
      runtime: "claude",
    });
    workerAgentId = worker.id;

    const { createBoard } = await import("../apps/web/server/boardRepo");
    const board = await createBoard(env.DB, userId, "task-user-crud-board", "ops");
    boardId = board.id;
  });

  it("POST /api/tasks with a user session creates an unassigned todo task", async () => {
    const res = await apiRequest("POST", "/api/tasks", { title: "User Created Task", board_id: boardId }, userToken);
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.title).toBe("User Created Task");
    expect(body.status).toBe("todo");
    expect(body.assigned_to).toBeNull();
  });

  it("PATCH /api/tasks/:id with a user session updates the task", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Before Patch", board_id: boardId });
    const res = await apiRequest("PATCH", `/api/tasks/${task.id}`, { title: "After Patch", description: "from the WebUI" }, userToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.title).toBe("After Patch");
    expect(body.description).toBe("from the WebUI");
  });

  it("DELETE /api/tasks/:id with a user session deletes the task", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "Delete Me", board_id: boardId });
    const res = await apiRequest("DELETE", `/api/tasks/${task.id}`, undefined, userToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);

    const gone = await apiRequest("GET", `/api/tasks/${task.id}`, undefined, userToken);
    expect(gone.status).toBe(404);
  });

  it("POST /api/tasks/:id/assign with a user session assigns a todo task to a worker", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "User Assign Task", board_id: boardId });
    const res = await apiRequest("POST", `/api/tasks/${task.id}/assign`, { agent_id: workerAgentId }, userToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.assigned_to).toBe(workerAgentId);
  });

  it("POST /api/tasks with a machine API key is still forbidden", async () => {
    const res = await apiRequest("POST", "/api/tasks", { title: "Machine Task", board_id: boardId }, machineApiKey);
    expect(res.status).toBe(403);
  });
});
