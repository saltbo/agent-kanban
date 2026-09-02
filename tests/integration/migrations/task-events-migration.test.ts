// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrationSql, seedUser, setupMiniflare } from "../../helpers/db";

const migrationsDir = join(__dirname, "../../../migrations");
const resources: Miniflare[] = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.dispose()));
});

async function databaseBefore0047(): Promise<D1Database> {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: `task-events-pre-${randomUUID()}` },
  });
  resources.push(mf);
  const db = await mf.getD1Database("DB");
  const actualFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql") && file < "0047_")
    .sort();
  expect(actualFiles).toHaveLength(46);
  for (const file of actualFiles) {
    await applyMigrationSql(db, readFileSync(join(migrationsDir, file), "utf8"));
  }
  return db;
}

async function createTaskFixture(db: D1Database, ownerId: string) {
  if (!(await db.prepare("SELECT 1 FROM user WHERE id = ?").bind(ownerId).first())) {
    await seedUser(db, ownerId, `${ownerId}@test.local`);
  }
  const { createBoard } = await import("../../../server/adapters/d1/boardRepo");
  const board = await createBoard(db, ownerId, `Task events ${randomUUID()}`, "ops");
  const sessionBindings = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_session_bindings'").first();
  if (!sessionBindings) {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db
      .prepare("INSERT INTO tasks (id, board_id, status, title, created_at, updated_at) VALUES (?, ?, 'todo', ?, ?, ?)")
      .bind(id, board.id, `Task events ${id}`, now, now)
      .run();
    return { id };
  }
  const { createTask } = await import("../../../server/adapters/d1/taskRepo");
  return createTask(db, ownerId, { title: `Task events ${randomUUID()}`, board_id: board.id });
}

describe("0047 Task Event offsets", () => {
  it("uses the Task sequence index for snapshot offsets and Task cleanup", async () => {
    const setup = await setupMiniflare();
    resources.push(setup.mf);
    const indexName = "idx_task_event_offsets_task_sequence";

    const snapshotPlan = await setup.db
      .prepare(`
        EXPLAIN QUERY PLAN
        WITH requested(id) AS (
          SELECT CAST(value AS TEXT) FROM json_each(?)
        )
        SELECT MAX(event.sequence)
        FROM task_event_offsets event
        WHERE event.task_id IN (SELECT id FROM requested)
      `)
      .bind(JSON.stringify(["task-a", "task-b"]))
      .all<{ detail: string }>();
    expect(snapshotPlan.results.map(({ detail }) => detail).join("\n")).toContain(`USING COVERING INDEX ${indexName} (task_id=?)`);

    const cleanupPlan = await setup.db
      .prepare("EXPLAIN QUERY PLAN DELETE FROM task_event_offsets WHERE task_id = ?")
      .bind("task-a")
      .all<{ detail: string }>();
    expect(cleanupPlan.results.map(({ detail }) => detail).join("\n")).toContain(`USING COVERING INDEX ${indexName} (task_id=?)`);
  });

  it("backfills historical actions in stable timestamp and id order", async () => {
    const db = await databaseBefore0047();
    const task = await createTaskFixture(db, "task-events-history");
    await db.prepare("DELETE FROM task_actions WHERE task_id = ?").bind(task.id).run();
    for (const [id, createdAt] of [
      ["z-same-time", "2026-08-29T10:00:00.000Z"],
      ["a-same-time", "2026-08-29T10:00:00.000Z"],
      ["m-newer", "2026-08-29T10:01:00.000Z"],
    ]) {
      await db
        .prepare("INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at) VALUES (?, ?, 'system', 'history', 'created', ?)")
        .bind(id, task.id, createdAt)
        .run();
    }

    await applyMigrationSql(db, readFileSync(join(migrationsDir, "0047_task_event_offsets.sql"), "utf8"));

    await expect(
      db
        .prepare(
          "SELECT action.id, event.sequence FROM task_event_offsets event JOIN task_actions action ON action.id = event.action_id ORDER BY event.sequence",
        )
        .all(),
    ).resolves.toMatchObject({ results: [{ id: "a-same-time" }, { id: "z-same-time" }, { id: "m-newer" }] });
  });

  it("appends a tombstone offset when an action is deleted and never reuses that high-water mark", async () => {
    const setup = await setupMiniflare();
    resources.push(setup.mf);
    const task = await createTaskFixture(setup.db, "task-events-trigger");
    const insertAction = async (id: string) => {
      await setup.db
        .prepare("INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at) VALUES (?, ?, 'system', 'trigger', 'created', ?)")
        .bind(id, task.id, new Date().toISOString())
        .run();
      return (await setup.db.prepare("SELECT sequence FROM task_event_offsets WHERE action_id = ?").bind(id).first<{ sequence: number }>())!.sequence;
    };
    const first = await insertAction("trigger-first");
    const deletedHigh = await insertAction("trigger-high");
    expect(deletedHigh).toBeGreaterThan(first);
    await setup.db.prepare("DELETE FROM task_actions WHERE id = 'trigger-high'").run();
    await expect(
      setup.db
        .prepare("SELECT sequence, task_id, action_id FROM task_event_offsets WHERE task_id = ? ORDER BY sequence DESC LIMIT 1")
        .bind(task.id)
        .first(),
    ).resolves.toMatchObject({ sequence: expect.any(Number), task_id: task.id, action_id: null });
    const tombstone = (await setup.db
      .prepare("SELECT MAX(sequence) AS sequence FROM task_event_offsets WHERE task_id = ?")
      .bind(task.id)
      .first<{ sequence: number }>())!.sequence;
    expect(tombstone).toBeGreaterThan(deletedHigh);
    const afterDelete = await insertAction("trigger-after-delete");
    expect(afterDelete).toBeGreaterThan(tombstone);
  });

  it("deletes a Task normally and removes all of its event offsets", async () => {
    const setup = await setupMiniflare();
    resources.push(setup.mf);
    const task = await createTaskFixture(setup.db, "task-events-delete");
    await expect(setup.db.prepare("SELECT COUNT(*) AS count FROM task_event_offsets WHERE task_id = ?").bind(task.id).first()).resolves.toEqual({
      count: 1,
    });
    const { deleteTask } = await import("../../../server/adapters/d1/taskRepo");

    await expect(deleteTask(setup.db, task.id, "task-events-delete")).resolves.toBe(true);

    expect(await setup.db.prepare("SELECT id FROM tasks WHERE id = ?").bind(task.id).first()).toBeNull();
    await expect(setup.db.prepare("SELECT COUNT(*) AS count FROM task_event_offsets WHERE task_id = ?").bind(task.id).first()).resolves.toEqual({
      count: 0,
    });
  });

  it("returns a tenant-scoped current snapshot and conceals missing or foreign Tasks", async () => {
    const setup = await setupMiniflare();
    resources.push(setup.mf);
    const own = await createTaskFixture(setup.db, "task-events-owner");
    const second = await createTaskFixture(setup.db, "task-events-owner");
    const foreign = await createTaskFixture(setup.db, "task-events-foreign");
    const { d1TaskEventRepository } = await import("../../../server/adapters/d1/tasks/d1TaskEvents");
    const repository = d1TaskEventRepository(setup.db);

    await expect(repository.readSnapshot("task-events-owner", [second.id, own.id])).resolves.toMatchObject({
      tasks: [{ id: second.id }, { id: own.id }],
      offset: expect.any(Number),
    });
    await expect(repository.readSnapshot("task-events-owner", [own.id, foreign.id])).resolves.toBeNull();
    await expect(repository.readSnapshot("task-events-owner", [own.id, "missing-task"])).resolves.toBeNull();
  });

  it("reads exactly fifty Task IDs without exceeding the D1 bind limit", async () => {
    const setup = await setupMiniflare();
    resources.push(setup.mf);
    const ownerId = "task-events-fifty";
    await seedUser(setup.db, ownerId, `${ownerId}@test.local`);
    const { createBoard } = await import("../../../server/adapters/d1/boardRepo");
    const board = await createBoard(setup.db, ownerId, "Fifty Task Events", "ops");
    const now = new Date().toISOString();
    const tasks = Array.from({ length: 50 }, (_, index) => ({ id: randomUUID(), title: `Task Event ${index}` }));
    await setup.db.batch(
      tasks.map((task, index) =>
        setup.db
          .prepare("INSERT INTO tasks (id, board_id, seq, status, title, metadata, created_at, updated_at) VALUES (?, ?, ?, 'todo', ?, '{}', ?, ?)")
          .bind(task.id, board.id, index + 1, task.title, now, now),
      ),
    );
    const { d1TaskEventRepository } = await import("../../../server/adapters/d1/tasks/d1TaskEvents");

    const snapshot = await d1TaskEventRepository(setup.db).readSnapshot(
      ownerId,
      tasks.map(({ id }) => id),
    );

    expect(snapshot?.tasks.map(({ id }) => id)).toEqual(tasks.map(({ id }) => id));
  }, 15_000);
});
