// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoard, updateBoard } from "../../../server/adapters/d1/boardRepo";
import { createTask } from "../../../server/adapters/d1/taskRepo";
import type { Env } from "../../../server/env";
import { api } from "../../../server/http/app";
import { createTestEnv, seedUser, setupMiniflare } from "../../helpers/db";

let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let env: Env;
let badgePath: string;

beforeAll(async () => {
  const setup = await setupMiniflare();
  mf = setup.mf;
  env = { ...createTestEnv(), DB: setup.db } as Env;
  badgePath = await seedPublicBadgeBoard(env.DB, "tenant-public-board-badge");
});

afterAll(async () => mf.dispose());

describe("public Board task badge", () => {
  it.each(["", "?type=tasks"])("reports only completed Tasks for the canonical badge request %s", async (query) => {
    const response = await api.request(`${badgePath}${query}`, {}, env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toContain("2 tasks");
  });

  it("counts completed Tasks without depending on the removed local Agents table", async () => {
    const isolated = await setupMiniflare();
    try {
      const isolatedEnv = { ...createTestEnv(), DB: isolated.db } as Env;
      const isolatedBadgePath = await seedPublicBadgeBoard(isolated.db, "tenant-public-board-badge-without-agents");
      await isolated.db.prepare("DROP TABLE agents").run();

      const response = await api.request(isolatedBadgePath, {}, isolatedEnv);

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("2 tasks");
    } finally {
      await isolated.mf.dispose();
    }
  }, 15_000);

  it.each(["agents", "tokens"])("rejects the removed %s badge type", async (type) => {
    const response = await api.request(`${badgePath}?type=${type}`, {}, env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { message: 'Only the "tasks" badge is supported' } });
  });
});

async function seedPublicBadgeBoard(db: D1Database, ownerId: string): Promise<string> {
  await seedUser(db, ownerId, `${ownerId}@example.test`);
  const board = await createBoard(db, ownerId, "Public badge board", "ops");
  const published = await updateBoard(db, board.id, ownerId, { visibility: "public" });
  const doneOne = await createTask(db, ownerId, { title: "Done one", board_id: board.id });
  const doneTwo = await createTask(db, ownerId, { title: "Done two", board_id: board.id });
  const active = await createTask(db, ownerId, { title: "Still active", board_id: board.id });
  await db.prepare("UPDATE tasks SET status = 'done' WHERE id IN (?, ?)").bind(doneOne.id, doneTwo.id).run();
  await db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").bind(active.id).run();
  return `/api/share/${published!.share_slug}/badge.svg`;
}
