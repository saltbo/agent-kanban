// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedUser } from "../../helpers/db";

const migrationsDirectory = join(process.cwd(), "migrations");
let mf: Miniflare;
let db: D1Database;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "task-claim-deletion-migration" },
  });
  db = await mf.getD1Database("DB");
  for (const file of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql") && name < "0046_task_claim_deletions.sql")
    .sort()) {
    await executeSqlFile(file);
  }

  await seedUser(db, "claim-migration-owner", "claim-migration@example.test");
  const { createBoard } = await import("../../../server/adapters/d1/boardRepo");
  const board = await createBoard(db, "claim-migration-owner", "Claim migration board", "ops");
  const now = "2026-08-29T12:00:00.000Z";
  const fixtures = [
    ["ambiguous-task", "in_progress", "realmroot_actor", { annotations: { "runtime.creationToken": "user-value", keep: true } }],
    ["single-task", "in_progress", "realmroot_actor", { annotations: ["single"], other: true }],
    ["review-task", "in_review", "realmroot_actor", { annotations: "legacy-string", other: [1, 2] }],
    ["inverse-clock-task", "in_progress", "realmroot_actor", { annotations: { clock: "inverse" } }],
    ["released-task", "in_progress", "realmroot_actor", { annotations: { released: true } }],
    ["timed-out-task", "in_progress", "realmroot_actor", { annotations: { timedOut: true } }],
    ["legacy-task", "in_progress", "ak_agent", { annotations: null, other: "legacy" }],
  ] as const;
  await db.batch(
    fixtures.map(([id, status, identity, metadata], index) =>
      db
        .prepare(
          `INSERT INTO tasks
            (id, board_id, seq, status, title, assigned_to, assignee_identity_type, metadata, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'realmroot-agent', ?, ?, ?, ?)`,
        )
        .bind(id, board.id, index + 1, status, id, identity, JSON.stringify(metadata), now, now),
    ),
  );
  await db.batch([
    db
      .prepare(
        `INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at)
         VALUES ('claim-ambiguous-a', 'ambiguous-task', 'realmroot:agent', 'realmroot-agent', 'claimed', ?)`,
      )
      .bind("2026-08-29T11:00:00.000Z"),
    db
      .prepare(
        `INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at)
         VALUES ('claim-ambiguous-b', 'ambiguous-task', 'realmroot:agent', 'realmroot-agent', 'claimed', ?)`,
      )
      .bind("2026-08-29T11:00:00.000Z"),
    db
      .prepare(
        `INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at)
         VALUES ('claim-single', 'single-task', 'realmroot:agent', 'realmroot-agent', 'claimed', ?)`,
      )
      .bind(now),
    db
      .prepare(
        `INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at)
         VALUES ('claim-review', 'review-task', 'realmroot:agent', 'realmroot-agent', 'claimed', ?)`,
      )
      .bind(now),
    db.prepare(
      `INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at) VALUES
          ('claim-inverse-newer-lifecycle', 'inverse-clock-task', 'realmroot:agent', 'realmroot-agent', 'claimed', '2026-08-29T10:00:00.000Z'),
          ('claim-inverse-older-lifecycle', 'inverse-clock-task', 'realmroot:agent', 'realmroot-agent', 'claimed', '2026-08-29T14:00:00.000Z')`,
    ),
    db.prepare(
      `INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at) VALUES
          ('claim-released', 'released-task', 'realmroot:agent', 'realmroot-agent', 'claimed', '2026-08-29T10:00:00.000Z'),
          ('release-history', 'released-task', 'realmroot:agent', 'realmroot-agent', 'released', '2026-08-29T11:00:00.000Z')`,
    ),
    db.prepare(
      `INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at) VALUES
          ('claim-timed-out', 'timed-out-task', 'realmroot:agent', 'realmroot-agent', 'claimed', '2026-08-29T10:00:00.000Z'),
          ('timeout-history', 'timed-out-task', 'system', 'system', 'timed_out', '2026-08-29T11:00:00.000Z')`,
    ),
    db
      .prepare(
        `INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at)
         VALUES ('claim-legacy', 'legacy-task', 'agent:worker', 'realmroot-agent', 'claimed', ?)`,
      )
      .bind(now),
  ]);
  await executeSqlFile("0046_task_claim_deletions.sql");
});

afterAll(async () => mf.dispose());

describe("0046 Task Claim deletion migration", () => {
  it("backfills current Realmroot Claim generations without changing metadata", async () => {
    const tasks = await db
      .prepare("SELECT id, active_claim_id, metadata FROM tasks ORDER BY id")
      .all<{ id: string; active_claim_id: string | null; metadata: string }>();
    expect(tasks.results).toEqual([
      {
        id: "ambiguous-task",
        active_claim_id: null,
        metadata: JSON.stringify({ annotations: { "runtime.creationToken": "user-value", keep: true } }),
      },
      {
        id: "inverse-clock-task",
        active_claim_id: null,
        metadata: JSON.stringify({ annotations: { clock: "inverse" } }),
      },
      {
        id: "legacy-task",
        active_claim_id: null,
        metadata: JSON.stringify({ annotations: null, other: "legacy" }),
      },
      {
        id: "released-task",
        active_claim_id: null,
        metadata: JSON.stringify({ annotations: { released: true } }),
      },
      {
        id: "review-task",
        active_claim_id: "claim-review",
        metadata: JSON.stringify({ annotations: "legacy-string", other: [1, 2] }),
      },
      {
        id: "single-task",
        active_claim_id: "claim-single",
        metadata: JSON.stringify({ annotations: ["single"], other: true }),
      },
      {
        id: "timed-out-task",
        active_claim_id: null,
        metadata: JSON.stringify({ annotations: { timedOut: true } }),
      },
    ]);
  });

  it("enforces Claim deletion identity, uniqueness, references, indexes, and cascades", async () => {
    await db
      .prepare(
        `INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at)
         VALUES ('release-single', 'single-task', 'realmroot:agent', 'releaser', 'released', ?)`,
      )
      .bind("2026-08-29T13:00:00.000Z")
      .run();
    await db
      .prepare(
        `INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at)
         VALUES ('release-review', 'review-task', 'realmroot:agent', 'releaser', 'released', ?)`,
      )
      .bind("2026-08-29T13:00:00.000Z")
      .run();
    await expect(
      db
        .prepare(
          `INSERT INTO task_claim_deletions (claim_id, task_id, action_id, actor_type, actor_id, deleted_at)
           VALUES ('claim-review', 'single-task', 'release-single', 'realmroot:agent', 'releaser', ?)`,
        )
        .bind("2026-08-29T13:00:00.000Z")
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(
      db
        .prepare(
          `INSERT INTO task_claim_deletions (claim_id, task_id, action_id, actor_type, actor_id, deleted_at)
           VALUES ('claim-single', 'single-task', 'release-review', 'realmroot:agent', 'releaser', ?)`,
        )
        .bind("2026-08-29T13:00:00.000Z")
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(
      db
        .prepare(
          `INSERT INTO task_claim_deletions (claim_id, task_id, action_id, actor_type, actor_id, deleted_at)
           VALUES ('claim-single', 'single-task', 'release-single', 'realmroot:agent', 'releaser', ?)`,
        )
        .bind("2026-08-29T13:00:00.000Z")
        .run(),
    ).resolves.toMatchObject({ success: true });
    await expect(
      db
        .prepare(
          `INSERT INTO task_claim_deletions (claim_id, task_id, action_id, actor_type, actor_id, deleted_at)
           VALUES ('claim-review', 'single-task', 'release-single', 'agent:worker', 'releaser', ?)`,
        )
        .bind("2026-08-29T13:00:00.000Z")
        .run(),
    ).rejects.toThrow();

    const indexes = await db.prepare("PRAGMA index_list('task_claim_deletions')").all<{ name: string }>();
    expect(indexes.results.map(({ name }) => name)).toEqual(expect.arrayContaining(["idx_task_claim_deletions_task"]));
    await expect(db.prepare("PRAGMA foreign_key_check").all()).resolves.toMatchObject({ results: [] });

    const taskActionIndexes = await db.prepare("PRAGMA index_list('task_actions')").all<{ name: string }>();
    expect(taskActionIndexes.results.map(({ name }) => name)).toContain("idx_task_actions_id_task");

    await db.prepare("DELETE FROM tasks WHERE id = 'single-task'").run();
    await expect(db.prepare("SELECT COUNT(*) AS count FROM task_claim_deletions WHERE task_id = 'single-task'").first()).resolves.toEqual({
      count: 0,
    });
  });
});

async function executeSqlFile(file: string): Promise<void> {
  const sql = readFileSync(join(migrationsDirectory, file), "utf8").replace(/^--.*$/gm, "");
  for (const statement of sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)) {
    await db.prepare(statement).run();
  }
}
