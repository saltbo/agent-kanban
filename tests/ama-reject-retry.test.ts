// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "../apps/web/server/routes";
import { sendTaskRejectToAma } from "../apps/web/server/taskDispatch";
import { createTestAgent, createTestEnv, createTestWebSession, seedUser, setupMiniflare } from "./helpers/db";

const env = {
  ...createTestEnv(),
  AMA_ORIGIN: "https://ama.test",
  AK_API_URL: "http://localhost:8788",
};

let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function createAmaBoundReviewTask() {
  const ownerId = `ama-reject-${randomUUID()}`;
  await seedUser(env.DB, ownerId, `${ownerId}@test.local`);
  const { createBoard } = await import("../apps/web/server/boardRepo");
  const { createTask, getTask } = await import("../apps/web/server/taskRepo");
  const board = await createBoard(env.DB, ownerId, `AMA reject ${randomUUID()}`, "ops");
  const agent = await createTestAgent(env.DB, ownerId, {
    name: "AMA reject worker",
    username: `ama-reject-worker-${randomUUID()}`,
    runtime: "claude",
  });
  const sessionId = `session_${randomUUID()}`;
  const projectId = `project_${randomUUID()}`;
  const created = await createTask(env.DB, ownerId, {
    title: "Resume after review rejection",
    board_id: board.id,
    assigned_to: agent.id,
    skipRuntimeAvailability: true,
    metadata: {
      annotations: {
        "runtime.source": "ama",
        "ama.projectId": projectId,
        "ama.sessionId": sessionId,
        "ama.dispatch.result": "accepted",
      },
    },
  });
  await env.DB.prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").bind(created.id).run();
  const task = await getTask(env.DB, created.id, ownerId);
  if (!task) throw new Error("failed to create AMA-bound task fixture");
  return { ownerId, task, sessionId, projectId, agentId: agent.id };
}

function annotations(metadata: string | Record<string, unknown> | null): Record<string, unknown> {
  const parsed = typeof metadata === "string" ? (JSON.parse(metadata) as Record<string, unknown>) : (metadata ?? {});
  const value = parsed.annotations;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function storedTask(taskId: string) {
  const row = await env.DB.prepare("SELECT status, assigned_to, metadata FROM tasks WHERE id = ?")
    .bind(taskId)
    .first<{ status: string; assigned_to: string | null; metadata: string }>();
  if (!row) throw new Error("task fixture disappeared");
  return row;
}

beforeAll(async () => {
  ({ mf, db: env.DB } = await setupMiniflare());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await mf.dispose();
});

describe("AMA reject resume acknowledgement retries", () => {
  it("reuses one command id while retrying a transient 409", async () => {
    const { ownerId, task, sessionId, projectId } = await createAmaBoundReviewTask();
    let calls = 0;
    const commandIds: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        expect(request.url).toBe(`https://ama.test/api/v1/sessions/${sessionId}/messages`);
        expect(request.method).toBe("POST");
        expect(request.headers.get("x-ama-project-id")).toBe(projectId);
        const body = (await request.clone().json()) as { requestId?: string };
        expect(body.requestId).toMatch(/^reject_resume_/);
        commandIds.push(body.requestId ?? "");
        calls += 1;
        if (calls === 1) {
          const beforeAcceptance = await storedTask(task.id);
          expect(annotations(beforeAcceptance.metadata)["ama.lastCommand.result"]).toBeUndefined();
          return jsonResponse({ error: "runner not ready" }, 409);
        }
        return jsonResponse({ id: `message_${calls}` }, 201);
      }),
    );

    const updated = await sendTaskRejectToAma(env.DB, env, ownerId, task, "Address the review feedback");

    expect(calls).toBe(2);
    expect(new Set(commandIds)).toEqual(new Set([commandIds[0]]));
    expect(annotations(updated.metadata)).toMatchObject({
      "ama.lastCommand": "reject_resume",
      "ama.lastCommand.result": "accepted",
    });
    const stored = await storedTask(task.id);
    expect(annotations(stored.metadata)).toMatchObject({
      "ama.lastCommand": "reject_resume",
      "ama.lastCommand.result": "accepted",
    });
  });

  it("uses exponential backoff and succeeds after the runner remains unavailable for three real seconds", async () => {
    const { ownerId, task } = await createAmaBoundReviewTask();
    const startedAt = performance.now();
    const commandIds: string[] = [];
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      const body = (await request.clone().json()) as { requestId?: string };
      commandIds.push(body.requestId ?? "");
      if (performance.now() - startedAt < 3_000) return jsonResponse({ error: "runner reconnecting" }, 409);
      return jsonResponse({ id: "message_after_reconnect" }, 201);
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendTaskRejectToAma(env.DB, env, ownerId, task, "Resume after reconnect");

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(new Set(commandIds).size).toBe(1);
    const retryDelays = timeoutSpy.mock.calls.map((call) => call[1]).filter((delay) => typeof delay === "number");
    expect(retryDelays.slice(0, 4)).toEqual([250, 500, 1_000, 2_000]);
  }, 7_000);

  it("does not retry a non-409 AMA failure or record acceptance", async () => {
    const { ownerId, task } = await createAmaBoundReviewTask();
    const fetchMock = vi.fn(async () => jsonResponse({ error: "runner crashed" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendTaskRejectToAma(env.DB, env, ownerId, task, "Retry later")).rejects.toMatchObject({ status: 500 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = await storedTask(task.id);
    expect(annotations(stored.metadata)["ama.lastCommand.result"]).toBeUndefined();
  });

  it("stops after the bounded 409 retries and the reject route leaves the task unchanged", async () => {
    const { ownerId, task, agentId } = await createAmaBoundReviewTask();
    const session = await createTestWebSession(env.DB, ownerId);
    const fetchMock = vi.fn(async () => jsonResponse({ error: "runner is still unavailable" }, 409));
    vi.stubGlobal("fetch", fetchMock);
    const retryDelays: number[] = [];
    const immediateTimeout: typeof setTimeout = (callback, delay, ...args) => {
      retryDelays.push(typeof delay === "number" ? delay : 0);
      queueMicrotask(() => callback(...args));
      return 0 as unknown as ReturnType<typeof setTimeout>;
    };
    vi.spyOn(globalThis, "setTimeout").mockImplementation(immediateTimeout);

    const response = await api.request(
      `/api/tasks/${task.id}/reject`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          "x-csrf-token": session.csrfToken,
          host: "localhost:8788",
          "x-forwarded-proto": "http",
        },
        body: JSON.stringify({ reason: "Address the review feedback" }),
      },
      env,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { message: "AMA reject delivery was not accepted" } });
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(retryDelays).toEqual([250, 500, 1_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000]);
    const stored = await storedTask(task.id);
    expect(stored).toMatchObject({ status: "in_review", assigned_to: agentId });
    expect(annotations(stored.metadata)["ama.lastCommand.result"]).toBeUndefined();
    const rejected = await env.DB.prepare("SELECT COUNT(*) AS count FROM task_actions WHERE task_id = ? AND action = 'rejected'")
      .bind(task.id)
      .first<{ count: number }>();
    expect(rejected?.count).toBe(0);
  });
});
