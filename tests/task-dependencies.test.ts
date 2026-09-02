// @vitest-environment node

import { randomUUID } from "node:crypto";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations as applyAllMigrations, seedUser } from "./helpers/db";

const env = {
  DB: null as any as D1Database,
  AUTH_SECRET: "test-secret-32-chars-minimum-ok!!",
  ALLOWED_HOSTS: "localhost:8788",
  GITHUB_CLIENT_ID: "x",
  GITHUB_CLIENT_SECRET: "x",
};

let mf: Miniflare;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "test-db" },
  });
  env.DB = await mf.getD1Database("DB");
  await applyAllMigrations(env.DB);

  await seedUser(env.DB, "test-user-deps", "deps@example.com");
});

afterAll(async () => {
  await mf.dispose();
});

describe("task dependencies", () => {
  const userId = "test-user-deps";
  let boardId: string;

  beforeAll(async () => {
    const { createBoard } = await import("../server/adapters/d1/boardRepo");
    const board = await createBoard(env.DB, userId, "deps-board", "ops");
    boardId = board.id;
  });

  async function createTask(opts: { title?: string; depends_on?: string[] } = {}) {
    const { createTask } = await import("../server/adapters/d1/taskRepo");
    return createTask(env.DB, userId, {
      title: opts.title || `Task ${randomUUID().slice(0, 8)}`,
      board_id: boardId,
      depends_on: opts.depends_on,
    });
  }

  it("listTasks returns depends_on for each task", async () => {
    const { listTasks } = await import("../server/adapters/d1/taskRepo");
    const t1 = await createTask({ title: "dep-parent" });
    const t2 = await createTask({ title: "dep-child", depends_on: [t1.id] });

    const tasks = await listTasks(env.DB, userId, { board_id: boardId });
    const child = tasks.find((t: any) => t.id === t2.id) as any;
    expect(child.depends_on).toEqual([t1.id]);
  });

  it("rejects cross-tenant parent and dependency task references on create and update", async () => {
    const otherOwner = "test-user-deps-other";
    await seedUser(env.DB, otherOwner, "deps-other@example.com");
    const { createBoard } = await import("../server/adapters/d1/boardRepo");
    const { createTask: createTaskRecord, updateTask } = await import("../server/adapters/d1/taskRepo");
    const otherBoard = await createBoard(env.DB, otherOwner, "other-deps-board", "ops");
    const foreignTask = await createTaskRecord(env.DB, otherOwner, { title: "Foreign task", board_id: otherBoard.id });

    await expect(createTaskRecord(env.DB, userId, { title: "Cross-tenant parent", board_id: boardId, created_from: foreignTask.id })).rejects.toThrow(
      "Parent task not found",
    );
    await expect(
      createTaskRecord(env.DB, userId, { title: "Cross-tenant dependency", board_id: boardId, depends_on: [foreignTask.id] }),
    ).rejects.toThrow("Dependency task not found");

    const localTask = await createTask({ title: "Local task" });
    await expect(updateTask(env.DB, localTask.id, { depends_on: [foreignTask.id] }, userId)).rejects.toThrow("Dependency task not found");
  });

  it("listTasks returns empty depends_on for tasks with no deps", async () => {
    const { listTasks } = await import("../server/adapters/d1/taskRepo");
    const t = await createTask({ title: "no-deps" });

    const tasks = await listTasks(env.DB, userId, { board_id: boardId });
    const found = tasks.find((task: any) => task.id === t.id) as any;
    expect(found.depends_on).toEqual([]);
  });

  it("listTasks returns multiple depends_on", async () => {
    const { listTasks } = await import("../server/adapters/d1/taskRepo");
    const t1 = await createTask({ title: "multi-dep-a" });
    const t2 = await createTask({ title: "multi-dep-b" });
    const t3 = await createTask({ title: "multi-dep-child", depends_on: [t1.id, t2.id] });

    const tasks = await listTasks(env.DB, userId, { board_id: boardId });
    const child = tasks.find((t: any) => t.id === t3.id) as any;
    expect(child.depends_on).toHaveLength(2);
    expect(child.depends_on).toContain(t1.id);
    expect(child.depends_on).toContain(t2.id);
  });

  it("blocked is true when dependency is not done", async () => {
    const { listTasks } = await import("../server/adapters/d1/taskRepo");
    const t1 = await createTask({ title: "blocker" });
    const t2 = await createTask({ title: "blocked-task", depends_on: [t1.id] });

    const tasks = await listTasks(env.DB, userId, { board_id: boardId });
    const child = tasks.find((t: any) => t.id === t2.id);
    expect(child!.blocked).toBe(true);
  });

  it("blocked is false when dependency is done", async () => {
    const { listTasks } = await import("../server/adapters/d1/taskRepo");
    const t1 = await createTask({ title: "done-blocker" });
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").bind(t1.id).run();
    const t2 = await createTask({ title: "unblocked-task", depends_on: [t1.id] });

    const tasks = await listTasks(env.DB, userId, { board_id: boardId });
    const child = tasks.find((t: any) => t.id === t2.id);
    expect(child!.blocked).toBe(false);
  });

  it("setDependencies preserves existing deps when appending", async () => {
    const { listTasks, updateTask } = await import("../server/adapters/d1/taskRepo");
    const t1 = await createTask({ title: "original-dep" });
    const t2 = await createTask({ title: "appended-dep" });
    const t3 = await createTask({ title: "child-with-append", depends_on: [t1.id] });

    // Simulate what daemon does: read depends_on from listTasks, append new dep
    const tasks = await listTasks(env.DB, userId, { board_id: boardId });
    const child = tasks.find((t: any) => t.id === t3.id) as any;
    await updateTask(env.DB, t3.id, { depends_on: [...child.depends_on, t2.id] });

    // Verify both deps exist
    const tasksAfter = await listTasks(env.DB, userId, { board_id: boardId });
    const childAfter = tasksAfter.find((t: any) => t.id === t3.id) as any;
    expect(childAfter.depends_on).toHaveLength(2);
    expect(childAfter.depends_on).toContain(t1.id);
    expect(childAfter.depends_on).toContain(t2.id);
  });
});
