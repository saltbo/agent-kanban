// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(__dirname, "../apps/web/migrations");

const env = {
  DB: null as any as D1Database,
  AE: { writeDataPoint: () => {} } as unknown as AnalyticsEngineDataset,
  AUTH_SECRET: "test-secret-32-chars-minimum-ok!!",
  ALLOWED_HOSTS: "localhost:8788",
  GITHUB_CLIENT_ID: "x",
  GITHUB_CLIENT_SECRET: "x",
};

let mf: Miniflare;

async function applyMigrations(db: D1Database) {
  const files = [
    "0001_initial.sql",
    "0002_rename_task_logs_to_task_notes.sql",
    "0003_agent_kind.sql",
    "0004_rename_task_notes_to_task_actions.sql",
    "0005_agent_runtime_required.sql",
    "0006_add_device_id.sql",
    "0007_task_seq.sql",
    "0010_board_type.sql",
    "0011_task_scheduled_at.sql",
    "0012_gpg_keys.sql",
    "0013_agent_identity.sql",
    "0014_agent_mailbox_token.sql",
    "0015_username_global_unique.sql",
    "0016_task_actions_session_id.sql",
    "0017_unique_leader_per_runtime.sql",
    "0018_agent_subagents.sql",
    "0019_agent_versions.sql",
    "0021_subagents.sql",
    "0022_ama_runtime_integration.sql",
    "0025_machine_hosting.sql",
    "0026_agent_ama_agent_id.sql",
    "0028_board_maintainer_triggers_memory.sql",
    "0030_agent_taints.sql",
    "0031_drop_board_maintainer_name.sql",
    "0032_board_maintainer_api_key.sql",
  ];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    for (const stmt of sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await db.prepare(stmt).run();
    }
  }
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "test-db" },
  });
  env.DB = await mf.getD1Database("DB");
  await applyMigrations(env.DB);

  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)")
    .bind("test-user-deps", "Deps User", "deps@example.com", now, now)
    .run();
});

afterAll(async () => {
  await mf.dispose();
});

describe("task dependencies", () => {
  const userId = "test-user-deps";
  let boardId: string;

  beforeAll(async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const board = await createBoard(env.DB, userId, "deps-board", "ops");
    boardId = board.id;
  });

  async function createTask(opts: { title?: string; depends_on?: string[] } = {}) {
    const { createTask } = await import("../apps/web/server/taskRepo");
    return createTask(env.DB, userId, {
      title: opts.title || `Task ${randomUUID().slice(0, 8)}`,
      board_id: boardId,
      depends_on: opts.depends_on,
    });
  }

  it("listTasks returns depends_on for each task", async () => {
    const { listTasks } = await import("../apps/web/server/taskRepo");
    const t1 = await createTask({ title: "dep-parent" });
    const t2 = await createTask({ title: "dep-child", depends_on: [t1.id] });

    const tasks = await listTasks(env.DB, userId, { board_id: boardId });
    const child = tasks.find((t: any) => t.id === t2.id) as any;
    expect(child.depends_on).toEqual([t1.id]);
  });

  it("listTasks returns empty depends_on for tasks with no deps", async () => {
    const { listTasks } = await import("../apps/web/server/taskRepo");
    const t = await createTask({ title: "no-deps" });

    const tasks = await listTasks(env.DB, userId, { board_id: boardId });
    const found = tasks.find((task: any) => task.id === t.id) as any;
    expect(found.depends_on).toEqual([]);
  });

  it("listTasks returns multiple depends_on", async () => {
    const { listTasks } = await import("../apps/web/server/taskRepo");
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
    const { listTasks } = await import("../apps/web/server/taskRepo");
    const t1 = await createTask({ title: "blocker" });
    const t2 = await createTask({ title: "blocked-task", depends_on: [t1.id] });

    const tasks = await listTasks(env.DB, userId, { board_id: boardId });
    const child = tasks.find((t: any) => t.id === t2.id);
    expect(child!.blocked).toBe(true);
  });

  it("blocked is false when dependency is done", async () => {
    const { listTasks } = await import("../apps/web/server/taskRepo");
    const t1 = await createTask({ title: "done-blocker" });
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").bind(t1.id).run();
    const t2 = await createTask({ title: "unblocked-task", depends_on: [t1.id] });

    const tasks = await listTasks(env.DB, userId, { board_id: boardId });
    const child = tasks.find((t: any) => t.id === t2.id);
    expect(child!.blocked).toBe(false);
  });

  it("setDependencies preserves existing deps when appending", async () => {
    const { listTasks, updateTask } = await import("../apps/web/server/taskRepo");
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

  it("createTask rejects a dependency id that does not exist", async () => {
    await expect(createTask({ title: "bad-dep", depends_on: ["no-such-task"] })).rejects.toThrow(/Dependency task not found/);
  });

  it("updateTask rejects a dependency id that does not exist", async () => {
    const { updateTask } = await import("../apps/web/server/taskRepo");
    const t = await createTask({ title: "update-bad-dep" });
    await expect(updateTask(env.DB, t.id, { depends_on: ["no-such-task"] })).rejects.toThrow(/Dependency task not found/);
  });

  it("createTask rejects a dependency owned by a different owner", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask: createTaskRepo } = await import("../apps/web/server/taskRepo");
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)")
      .bind("test-user-deps-other", "Other User", "other-deps@example.com", now, now)
      .run();
    const otherBoard = await createBoard(env.DB, "test-user-deps-other", "other-board", "ops");
    const foreign = await createTaskRepo(env.DB, "test-user-deps-other", { title: "foreign-task", board_id: otherBoard.id });

    await expect(createTask({ title: "cross-owner-dep", depends_on: [foreign.id] })).rejects.toThrow(/Dependency task not found/);
  });
});
