// @vitest-environment node

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, seedUser, setupMiniflare } from "./helpers/db";

const env = createTestEnv();
let mf: Miniflare;

beforeAll(async () => {
  ({ mf, db: env.DB } = await setupMiniflare());
  await seedUser(env.DB, "sse-user", "sse@test.com");
});

afterAll(async () => {
  await mf.dispose();
});

async function readSSEUntil(body: ReadableStream, matchFn: (text: string) => boolean, timeoutMs = 3000, readTimeoutMs = 200): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), readTimeoutMs)),
    ]);
    if (result.value) {
      text += decoder.decode(result.value, { stream: true });
    }
    if (result.done || matchFn(text)) break;
  }
  reader.cancel();
  return text;
}

describe("createSSEResponse", () => {
  let boardId: string;
  let taskId: string;

  beforeAll(async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const board = await createBoard(env.DB, "sse-user", "SSE Board", "ops");
    boardId = board.id;

    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, "sse-user", { title: "SSE Task", board_id: boardId });
    taskId = task.id;
  });

  it("returns a Response with correct SSE headers", async () => {
    const { createSSEResponse } = await import("../apps/web/server/sse");
    const response = await createSSEResponse(env as any, taskId, null);
    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("Connection")).toBe("keep-alive");
  });

  it("streams initial logs as SSE events", async () => {
    const { addTaskAction } = await import("../apps/web/server/taskRepo");
    await addTaskAction(env.DB, taskId, "machine", "system", "commented", "Log entry 1");
    await addTaskAction(env.DB, taskId, "machine", "system", "commented", "Log entry 2");

    const { createSSEResponse } = await import("../apps/web/server/sse");
    const response = await createSSEResponse(env as any, taskId, null);
    const text = await readSSEUntil(response.body!, (t) => t.includes("Log entry 2"));

    expect(text).toContain("event: note");
    expect(text).toContain("Log entry 1");
    expect(text).toContain("Log entry 2");
    expect(text).toContain("id: ");
    expect(text).toContain("data: ");
  });

  it("streams messages as SSE events", async () => {
    const { createMessage } = await import("../apps/web/server/messageRepo");
    await createMessage(env.DB, taskId, "user", "sse-user", "Hello from user");

    const { createSSEResponse } = await import("../apps/web/server/sse");
    const response = await createSSEResponse(env as any, taskId, null);
    const text = await readSSEUntil(response.body!, (t) => t.includes("event: message"));

    expect(text).toContain("event: message");
    expect(text).toContain("Hello from user");
  });

  it("resumes from lastEventId", async () => {
    const { addTaskAction, getTaskActions } = await import("../apps/web/server/taskRepo");
    await addTaskAction(env.DB, taskId, "machine", "system", "commented", "Before resume");
    const logsBeforeResume = await getTaskActions(env.DB, taskId);
    const lastLogId = logsBeforeResume[logsBeforeResume.length - 1].id;

    // Small delay to ensure distinct timestamp in D1 (millisecond resolution)
    await new Promise((r) => setTimeout(r, 50));
    await addTaskAction(env.DB, taskId, "machine", "system", "commented", "After resume");

    const { createSSEResponse } = await import("../apps/web/server/sse");
    const response = await createSSEResponse(env as any, taskId, lastLogId);
    const text = await readSSEUntil(response.body!, (t) => t.includes("After resume"));

    expect(text).toContain("After resume");
  });

  it("returns stream for task with only creation log", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const freshTask = await createTask(env.DB, "sse-user", {
      title: "Fresh SSE Task",
      board_id: boardId,
    });

    const { createSSEResponse } = await import("../apps/web/server/sse");
    const response = await createSSEResponse(env as any, freshTask.id, null);
    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await readSSEUntil(response.body!, (t) => t.includes("event: note"));

    expect(text).toContain("event: note");
    expect(text).toContain('"action":"created"');
  });

  it("merges logs and messages by time order", async () => {
    const { createTask, addTaskAction } = await import("../apps/web/server/taskRepo");
    const { createMessage } = await import("../apps/web/server/messageRepo");
    const mergeTask = await createTask(env.DB, "sse-user", {
      title: "Merge SSE Task",
      board_id: boardId,
    });

    await createMessage(env.DB, mergeTask.id, "user", "sse-user", "Message first");
    // Small delay to ensure distinct timestamp in D1 (millisecond resolution)
    await new Promise((r) => setTimeout(r, 50));
    await addTaskAction(env.DB, mergeTask.id, "machine", "system", "commented", "Log second");

    const { createSSEResponse } = await import("../apps/web/server/sse");
    const response = await createSSEResponse(env as any, mergeTask.id, null);
    const text = await readSSEUntil(response.body!, (t) => t.includes("Message first") && t.includes("Log second"));

    expect(text).toContain("event: message");
    expect(text).toContain("event: note");
    expect(text).toContain("Message first");
    expect(text).toContain("Log second");

    const msgPos = text.indexOf("Message first");
    const logPos = text.indexOf("Log second");
    expect(msgPos).toBeLessThan(logPos);
  });

  it("poll loop picks up new events after initial batch", async () => {
    const { createTask, addTaskAction } = await import("../apps/web/server/taskRepo");
    const pollTask = await createTask(env.DB, "sse-user", {
      title: "Poll SSE Task",
      board_id: boardId,
    });

    setTimeout(async () => {
      await addTaskAction(env.DB, pollTask.id, "machine", "system", "commented", "Polled event from loop");
    }, 500);

    const { createSSEResponse } = await import("../apps/web/server/sse");
    const response = await createSSEResponse(env as any, pollTask.id, null);
    // Poll loop fires at 2s intervals — use a longer per-read timeout to avoid premature resolution
    const text = await readSSEUntil(response.body!, (t) => t.includes("Polled event from loop"), 8000, 3000);

    expect(text).toContain("Polled event from loop");
  }, 15000);

  it("returns 400 JSON error when lastEventId is not found in DB", async () => {
    const { createSSEResponse } = await import("../apps/web/server/sse");
    const response = await createSSEResponse(env as any, taskId, "nonexistent-event-id-xyz");
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = (await response.json()) as any;
    expect(body.error.code).toBe("INVALID_LAST_EVENT_ID");
    expect(body.error.message).toBe("Unknown event ID, reconnect without Last-Event-ID");
  });

  it("lastSeen defaults to current time when no batch and no since", async () => {
    const { createSSEResponse } = await import("../apps/web/server/sse");
    const response = await createSSEResponse(env as any, "nonexistent-task-id", null);
    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await readSSEUntil(response.body!, () => false, 500);
    expect(text).toBe("");
  });

  it("limits initial events to 50 per type", async () => {
    const { createTask, addTaskAction } = await import("../apps/web/server/taskRepo");
    const bigTask = await createTask(env.DB, "sse-user", {
      title: "Big SSE Task",
      board_id: boardId,
    });

    for (let i = 0; i < 55; i++) {
      await addTaskAction(env.DB, bigTask.id, "machine", "system", "commented", `Bulk log ${i}`);
    }

    const { createSSEResponse } = await import("../apps/web/server/sse");
    const response = await createSSEResponse(env as any, bigTask.id, null);
    const text = await readSSEUntil(response.body!, (t) => (t.match(/event: note/g) || []).length >= 50);

    const logEventCount = (text.match(/event: note/g) || []).length;
    expect(logEventCount).toBeLessThanOrEqual(50);
    expect(text).not.toContain("Bulk log 0");
    expect(text).toContain("Bulk log 54");
  });

  it("emits gap event with initial_truncated when catch-up window hits the 500-row cap", async () => {
    const { createTask, getTaskActions } = await import("../apps/web/server/taskRepo");
    const { MAX_TASK_PARTITION_ROWS } = await import("../apps/web/server/db");

    const gapTask = await createTask(env.DB, "sse-user", {
      title: "Gap SSE Task",
      board_id: boardId,
    });

    // Get the "created" action that serves as our Last-Event-ID cursor
    const initialActions = await getTaskActions(env.DB, gapTask.id);
    const cursorAction = initialActions[0];
    const cursorTime = new Date(cursorAction.created_at).getTime();

    // Insert MAX_TASK_PARTITION_ROWS rows directly with manufactured timestamps
    // so we hit the cap exactly when querying with `since = cursorAction.created_at`
    const { newLongId } = await import("../apps/web/server/db");
    const stmts = [];
    for (let i = 0; i < MAX_TASK_PARTITION_ROWS; i++) {
      const ts = new Date(cursorTime + (i + 1)).toISOString();
      stmts.push(
        env.DB.prepare(
          "INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
        ).bind(newLongId(), gapTask.id, "machine", "system", "commented", `gap-action-${i}`, ts),
      );
    }
    await env.DB.batch(stmts);

    const { createSSEResponse } = await import("../apps/web/server/sse");
    const response = await createSSEResponse(env as any, gapTask.id, cursorAction.id);

    const text = await readSSEUntil(response.body!, (t) => t.includes("event: gap"), 5000);

    expect(text).toContain("event: gap");
    expect(text).toContain('"reason":"initial_truncated"');
  }, 15000);
});
