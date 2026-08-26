// @vitest-environment node

import { randomUUID } from "node:crypto";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestAgent, createTestEnv, createTestWebSession, seedUser, setupMiniflare } from "./helpers/db";

const env = createTestEnv();
let mf: Miniflare;

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

describe("getBoardActions", () => {
  const userId = "board-sse-unit-user";
  let boardId: string;
  let agentId: string;
  let taskId: string;

  beforeAll(async () => {
    await seedUser(env.DB, userId, `board-sse-unit-${randomUUID()}@test.com`);

    const { createBoard } = await import("../apps/web/server/boardRepo");
    const board = await createBoard(env.DB, userId, "board-sse-unit-board", "ops");
    boardId = board.id;

    const agent = await createTestAgent(env.DB, userId, { name: "SSE Unit Agent", username: "sse-unit-agent", runtime: "claude" });
    agentId = agent.id;

    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, userId, { title: "SSE Unit Task", board_id: boardId, actorType: "agent:worker", actorId: agentId });
    taskId = task.id;
  });

  it("returns notes for a board with actor_public_key populated", async () => {
    const since = new Date(Date.now() - 60 * 1000).toISOString();
    const { getBoardActions } = await import("../apps/web/server/taskRepo");
    const notes = await getBoardActions(env.DB, boardId, userId, since);

    expect(notes.length).toBeGreaterThan(0);
    const note = notes[0];
    expect(note.task_id).toBe(taskId);
    expect(note.actor_public_key).toBeTruthy();
  });

  it("returns notes with agent_kind populated", async () => {
    const since = new Date(Date.now() - 60 * 1000).toISOString();
    const { getBoardActions } = await import("../apps/web/server/taskRepo");
    const notes = await getBoardActions(env.DB, boardId, userId, since);

    const note = notes.find((n) => n.actor_id === agentId);
    expect(note).toBeDefined();
    expect(note!.agent_kind).toBe("worker");
  });

  it("returns empty array when no notes exist after since timestamp", async () => {
    const future = new Date(Date.now() + 60 * 1000).toISOString();
    const { getBoardActions } = await import("../apps/web/server/taskRepo");
    const notes = await getBoardActions(env.DB, boardId, userId, future);

    expect(notes).toEqual([]);
  });

  it("does not return notes from a different board", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const otherBoard = await createBoard(env.DB, userId, "board-sse-other-board", "ops");

    const { createTask } = await import("../apps/web/server/taskRepo");
    await createTask(env.DB, userId, { title: "Other Board Task", board_id: otherBoard.id });

    const since = new Date(Date.now() - 60 * 1000).toISOString();
    const { getBoardActions } = await import("../apps/web/server/taskRepo");
    const notes = await getBoardActions(env.DB, boardId, userId, since);

    const ids = notes.map((n) => n.task_id);
    const otherTasks = await env.DB.prepare("SELECT id FROM tasks WHERE board_id = ?").bind(otherBoard.id).all<{ id: string }>();
    for (const row of otherTasks.results) {
      expect(ids).not.toContain(row.id);
    }
  });

  it("returns null actor_public_key for notes without an agent actor", async () => {
    const { createTask, getBoardActions } = await import("../apps/web/server/taskRepo");
    const since = new Date(Date.now() - 1).toISOString();
    // Create a task with no agentId — the created action has actor_type 'machine'
    await createTask(env.DB, userId, { title: "No Agent Task", board_id: boardId });

    const notes = await getBoardActions(env.DB, boardId, userId, since);
    const machineNote = notes.find((n) => n.actor_type === "machine");
    if (machineNote) {
      expect(machineNote.actor_public_key).toBeNull();
      expect(machineNote.agent_kind).toBeNull();
    }
  });
});

describe("GET /api/boards/:id/stream", () => {
  const userId = "board-sse-route-user";
  let boardId: string;
  let apiKey: string;

  beforeAll(async () => {
    await seedUser(env.DB, userId, `board-sse-route-${randomUUID()}@test.com`);
    apiKey = (await createTestWebSession(env.DB, userId)).token;

    const { createBoard } = await import("../apps/web/server/boardRepo");
    const board = await createBoard(env.DB, userId, "board-sse-route-board", "ops");
    boardId = board.id;
  });

  it("returns 200 with text/event-stream content type", async () => {
    const res = await apiRequest("GET", `/api/boards/${boardId}/stream`, undefined, apiKey);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });

  it("returns Cache-Control: no-cache header", async () => {
    const res = await apiRequest("GET", `/api/boards/${boardId}/stream`, undefined, apiKey);
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("emits board_note events for existing notes in the stream body", async () => {
    const agent = await createTestAgent(env.DB, userId, { name: "SSE Route Agent", username: "sse-route-agent", runtime: "claude" });

    const { createTask } = await import("../apps/web/server/taskRepo");
    await createTask(env.DB, userId, { title: "SSE Stream Task", board_id: boardId, actorType: "agent:worker", actorId: agent.id });

    const res = await apiRequest("GET", `/api/boards/${boardId}/stream`, undefined, apiKey);
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    let foundBoardNoteEvent = false;

    // Read chunks until we find a board_note event or exhaust a reasonable amount of data
    for (let i = 0; i < 20 && !foundBoardNoteEvent; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value, { stream: true });
      if (accumulated.includes("event: board_note")) {
        foundBoardNoteEvent = true;
      }
    }

    reader.cancel().catch(() => {});
    expect(foundBoardNoteEvent).toBe(true);
  });

  it("requires authentication", async () => {
    const res = await apiRequest("GET", `/api/boards/${boardId}/stream`);
    expect(res.status).toBe(401);
  });
});
