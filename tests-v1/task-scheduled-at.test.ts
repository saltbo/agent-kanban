// @vitest-environment node

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, seedUser, setupMiniflare } from "./helpers/db";

const env = createTestEnv();
let mf: Miniflare;

beforeAll(async () => {
  ({ mf, db: env.DB } = await setupMiniflare());
  await seedUser(env.DB, "sched-test-user", "sched@test.com");
});

afterAll(async () => {
  await mf.dispose();
});

describe("scheduled_at field — taskRepo", () => {
  let boardId: string;

  beforeAll(async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const board = await createBoard(env.DB, "sched-test-user", "Scheduled Task Board", "ops");
    boardId = board.id;
  });

  it("createTask stores scheduled_at when provided", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const scheduledAt = "2099-01-01T00:00:00.000Z";
    const task = await createTask(env.DB, "sched-test-user", {
      title: "Future task",
      board_id: boardId,
      scheduled_at: scheduledAt,
    });

    expect(task.scheduled_at).toBe(scheduledAt);
  });

  it("createTask stores null scheduled_at when not provided", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, "sched-test-user", {
      title: "Immediate task",
      board_id: boardId,
    });

    expect(task.scheduled_at).toBeNull();
  });

  it("updateTask can set scheduled_at on an existing task", async () => {
    const { createTask, updateTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, "sched-test-user", {
      title: "Task to schedule later",
      board_id: boardId,
    });

    const scheduledAt = "2099-06-15T12:00:00.000Z";
    const updated = await updateTask(env.DB, task.id, { scheduled_at: scheduledAt });

    expect(updated).not.toBeNull();
    expect(updated!.scheduled_at).toBe(scheduledAt);
  });

  it("updateTask persists scheduled_at to DB readable via getTask", async () => {
    const { createTask, updateTask, getTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, "sched-test-user", {
      title: "Persist scheduled_at",
      board_id: boardId,
    });

    const scheduledAt = "2099-03-20T08:00:00.000Z";
    await updateTask(env.DB, task.id, { scheduled_at: scheduledAt });
    const fetched = await getTask(env.DB, task.id, "sched-test-user");

    expect(fetched).not.toBeNull();
    expect(fetched!.scheduled_at).toBe(scheduledAt);
  });

  it("updateTask preserves other fields when only scheduled_at is updated", async () => {
    const { createTask, updateTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, "sched-test-user", {
      title: "Preserve Fields",
      board_id: boardId,
    });

    const updated = await updateTask(env.DB, task.id, { scheduled_at: "2099-12-01T00:00:00.000Z" });

    expect(updated!.title).toBe("Preserve Fields");
    expect(updated!.status).toBe("todo");
  });

  it("listTasks returns scheduled_at in task results", async () => {
    const { createTask, listTasks } = await import("../apps/web/server/taskRepo");
    const scheduledAt = "2099-07-04T00:00:00.000Z";
    const task = await createTask(env.DB, "sched-test-user", {
      title: "Listing test task",
      board_id: boardId,
      scheduled_at: scheduledAt,
    });

    const tasks = await listTasks(env.DB, "sched-test-user", { board_id: boardId });
    const found = tasks.find((t) => t.id === task.id);

    expect(found).toBeDefined();
    expect(found!.scheduled_at).toBe(scheduledAt);
  });

  it("listTasks returns null scheduled_at for tasks created without it", async () => {
    const { createTask, listTasks } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, "sched-test-user", {
      title: "No schedule listing test",
      board_id: boardId,
    });

    const tasks = await listTasks(env.DB, "sched-test-user", { board_id: boardId });
    const found = tasks.find((t) => t.id === task.id);

    expect(found).toBeDefined();
    expect(found!.scheduled_at).toBeNull();
  });
});
