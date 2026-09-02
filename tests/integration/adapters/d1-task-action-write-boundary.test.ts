// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createBoard } from "../../../server/adapters/d1/boardRepo";
import { addTaskAction, createTask, getTaskActions } from "../../../server/adapters/d1/taskRepo";
import { ApplicationError } from "../../../server/usecases/applicationError";
import { seedUser, setupMiniflare } from "../../helpers/db";

const resources: Array<Awaited<ReturnType<typeof setupMiniflare>>["mf"]> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.dispose()));
});

describe("D1 current Task action actor writes", { timeout: 15_000 }, () => {
  it("keeps same-Board concurrent Task allocation contiguous while retrying sequence races or returning 409", async () => {
    const { db, ownerId, boardId } = await fixture("concurrent-allocation");

    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) => createTask(db, ownerId, { title: `Concurrent Task ${index + 1}`, board_id: boardId })),
    );
    const rejected = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
    for (const attempt of rejected) {
      expect(attempt.reason).toBeInstanceOf(ApplicationError);
      expect(attempt.reason).toMatchObject({ name: "ApplicationError", kind: "conflict" });
    }

    const rows = await db
      .prepare("SELECT id, seq, position FROM tasks WHERE board_id = ? ORDER BY seq")
      .bind(boardId)
      .all<{ id: string; seq: number; position: number }>();
    const committed = rows.results;
    expect(committed.length).toBeGreaterThan(1);
    expect(committed.map(({ seq }) => seq)).toEqual(Array.from({ length: committed.length }, (_, index) => index + 1));
    expect(committed.map(({ position }) => position)).toEqual(Array.from({ length: committed.length }, (_, index) => index));
    expect(new Set(committed.map(({ seq }) => seq)).size).toBe(committed.length);
    expect(new Set(committed.map(({ position }) => position)).size).toBe(committed.length);
    await expect(db.prepare("SELECT task_seq FROM boards WHERE id = ?").bind(boardId).first()).resolves.toEqual({ task_seq: committed.length });
    await expect(
      db.prepare("SELECT COUNT(*) AS count FROM task_actions WHERE task_id IN (SELECT id FROM tasks WHERE board_id = ?)").bind(boardId).first(),
    ).resolves.toEqual({ count: committed.length });
  });

  it("writes a default Task creation as the system actor", async () => {
    const { db, ownerId, boardId } = await fixture("default-system");

    const task = await createTask(db, ownerId, { title: "System-created Task", board_id: boardId });

    await expect(db.prepare("SELECT actor_type, actor_id, action FROM task_actions WHERE task_id = ?").bind(task.id).first()).resolves.toEqual({
      actor_type: "system",
      actor_id: "system",
      action: "created",
    });
  });

  it.each(["machine", "agent:worker", "agent:leader", "arbitrary:actor"])(
    "rejects createTask actor type %s before writing a Task or action",
    async (actorType) => {
      const { db, ownerId, boardId } = await fixture(`create-${actorType}`);

      await expect(
        createTask(db, ownerId, {
          title: `Rejected ${actorType}`,
          board_id: boardId,
          actorType: actorType as never,
          actorId: "legacy-actor",
        }),
      ).rejects.toThrow(`Unsupported v2 Task action actor type: ${actorType}`);
      await expect(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE board_id = ?").bind(boardId).first()).resolves.toEqual({ count: 0 });
      await expect(
        db.prepare("SELECT COUNT(*) AS count FROM task_actions WHERE task_id IN (SELECT id FROM tasks WHERE board_id = ?)").bind(boardId).first(),
      ).resolves.toEqual({ count: 0 });
    },
  );

  it("allows Realmroot Agent actions, rejects legacy writes without side effects, and still reads historical actor types", async () => {
    const { db, ownerId, boardId } = await fixture("action-history");
    const task = await createTask(db, ownerId, { title: "Task action history", board_id: boardId });

    const current = await addTaskAction(db, task.id, "realmroot:agent", "realmroot-actor", "commented", "Current action");
    expect(current).toMatchObject({ actor_type: "realmroot:agent", actor_id: "realmroot-actor" });
    const countBeforeRejectedWrites = await actionCount(db, task.id);
    for (const actorType of ["machine", "agent:worker", "agent:leader", "arbitrary:actor"] as const) {
      await expect(addTaskAction(db, task.id, actorType as never, "legacy-actor", "commented", "Rejected action")).rejects.toThrow(
        `Unsupported v2 Task action actor type: ${actorType}`,
      );
      await expect(actionCount(db, task.id)).resolves.toBe(countBeforeRejectedWrites);
    }

    const now = new Date().toISOString();
    for (const actorType of ["machine", "agent:worker", "agent:leader"] as const) {
      await db
        .prepare(
          `INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at)
           VALUES (?, ?, ?, ?, 'commented', 'Historical action', NULL, ?)`,
        )
        .bind(randomUUID(), task.id, actorType, `historical-${actorType}`, now)
        .run();
    }

    const historical = (await getTaskActions(db, task.id)).filter((action) => action.detail === "Historical action");
    expect(historical.map((action) => action.actor_type).sort()).toEqual(["agent:leader", "agent:worker", "machine"]);
  });
});

async function fixture(suffix: string): Promise<{ db: D1Database; ownerId: string; boardId: string }> {
  const { mf, db } = await setupMiniflare();
  resources.push(mf);
  const ownerId = `task-action-write-${suffix}-${randomUUID()}`;
  await seedUser(db, ownerId, `${ownerId}@test.local`);
  const board = await createBoard(db, ownerId, `Task action ${suffix}`, "ops");
  return { db, ownerId, boardId: board.id };
}

async function actionCount(db: D1Database, taskId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM task_actions WHERE task_id = ?").bind(taskId).first<{ count: number }>();
  return row?.count ?? 0;
}
