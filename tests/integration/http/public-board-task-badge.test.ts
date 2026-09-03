// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoard, updateBoard } from "../../../server/adapters/d1/boardRepo";
import { addTaskAction, createTask } from "../../../server/adapters/d1/taskRepo";
import type { Env } from "../../../server/env";
import { api } from "../../../server/http/app";
import { createTestEnv, seedUser, setupMiniflare } from "../../helpers/db";

let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let env: Env;
let badgePath: string;
let publicBoardPath: string;
let publicTaskId: string;
let privateBoardPath: string;

beforeAll(async () => {
  const setup = await setupMiniflare();
  mf = setup.mf;
  env = { ...createTestEnv(), DB: setup.db } as Env;
  const seeded = await seedPublicBadgeBoard(env.DB, "tenant-public-board-badge");
  badgePath = seeded.badgePath;
  publicBoardPath = seeded.boardPath;
  publicTaskId = seeded.taskId;
  const privateBoard = await createBoard(env.DB, "tenant-public-board-badge", "Private shared board", "ops");
  const brieflyPublished = await updateBoard(env.DB, privateBoard.id, "tenant-public-board-badge", { visibility: "public" });
  await updateBoard(env.DB, privateBoard.id, "tenant-public-board-badge", { visibility: "private" });
  privateBoardPath = `/api/share/${brieflyPublished!.share_slug}`;
});

afterAll(async () => mf.dispose());

describe("public Board task badge", () => {
  it.each(["", "?type=tasks"])("[spec: public-boards/task-badge] reports only completed Tasks for the canonical badge request %s", async (query) => {
    const response = await api.request(`${badgePath}${query}`, {}, env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toContain("2 tasks");
  });

  it("[spec: public-boards/task-badge] counts completed Tasks without depending on the removed local Agents table", async () => {
    const isolated = await setupMiniflare();
    try {
      const isolatedEnv = { ...createTestEnv(), DB: isolated.db } as Env;
      const isolatedBadgePath = (await seedPublicBadgeBoard(isolated.db, "tenant-public-board-badge-without-agents")).badgePath;
      await isolated.db.prepare("DROP TABLE agents").run();

      const response = await api.request(isolatedBadgePath, {}, isolatedEnv);

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("2 tasks");
    } finally {
      await isolated.mf.dispose();
    }
  }, 15_000);

  it.each(["agents", "tokens"])("[spec: public-boards/task-badge] rejects the removed %s badge type", async (type) => {
    const response = await api.request(`${badgePath}?type=${type}`, {}, env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { message: 'Only the "tasks" badge is supported' } });
  });
});

describe("public Board read model", () => {
  it("[spec: public-boards/shared-view] returns a published Board without authentication and conceals private or unknown Boards", async () => {
    const response = await api.request(publicBoardPath, {}, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      name: "Public badge board",
      visibility: "public",
      tasks: expect.arrayContaining([expect.objectContaining({ title: "Still active", status: "in_progress" })]),
    });
    expect((await api.request(privateBoardPath, {}, env)).status).toBe(404);
    expect((await api.request("/api/share/unknown-board", {}, env)).status).toBe(404);
  });

  it("[spec: public-boards/live-view] emits an unauthenticated safe Board Note update", async () => {
    await addTaskAction(env.DB, publicTaskId, "user", "public-viewer", "commented", "Public Board update");
    const response = await api.request(`${publicBoardPath}/stream`, {}, env);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let event = "";
    for (let index = 0; index < 20 && !event.includes("Public Board update"); index += 1) {
      const { done, value } = await reader.read();
      if (done) break;
      event += decoder.decode(value, { stream: true });
    }
    await reader.cancel();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(event).toContain("event: board_note");
    expect(event).toContain("Public Board update");
    expect(event).not.toMatch(/actor_public_key|private_key|token/);
  });
});

async function seedPublicBadgeBoard(db: D1Database, ownerId: string) {
  await seedUser(db, ownerId, `${ownerId}@example.test`);
  const board = await createBoard(db, ownerId, "Public badge board", "ops");
  const published = await updateBoard(db, board.id, ownerId, { visibility: "public" });
  const doneOne = await createTask(db, ownerId, { title: "Done one", board_id: board.id });
  const doneTwo = await createTask(db, ownerId, { title: "Done two", board_id: board.id });
  const active = await createTask(db, ownerId, { title: "Still active", board_id: board.id });
  await db.prepare("UPDATE tasks SET status = 'done' WHERE id IN (?, ?)").bind(doneOne.id, doneTwo.id).run();
  await db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").bind(active.id).run();
  const boardPath = `/api/share/${published!.share_slug}`;
  return { badgePath: `${boardPath}/badge.svg`, boardPath, taskId: active.id };
}
