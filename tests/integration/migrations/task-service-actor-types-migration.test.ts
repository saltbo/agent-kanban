// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import { applyMigrationSql, seedUser } from "../../helpers/db";

const migrationsDirectory = join(process.cwd(), "migrations");
const migrationFile = "0055_task_service_actor_types.sql";
const rebuiltTables = [
  "tasks",
  "task_actions",
  "task_dependencies",
  "messages",
  "task_review_submission_order",
  "task_review_decisions",
  "task_claim_deletions",
  "task_event_offsets",
  "task_session_bindings",
] as const;

describe("0055 Task service actor types migration", () => {
  it("preserves Task rows, constraints, indexes, triggers, foreign keys, and AUTOINCREMENT high-water marks", async () => {
    const mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "task-service-actor-types-migration" },
    });
    try {
      const db = await mf.getD1Database("DB");
      for (const file of readdirSync(migrationsDirectory)
        .filter((name) => name.endsWith(".sql") && name < migrationFile)
        .sort()) {
        await applyMigrationSql(db, readFileSync(join(migrationsDirectory, file), "utf8"));
      }
      await seedUser(db, "actor-migration-owner", "actor-migration@example.test");
      await seedFixture(db);
      const before = await rowCounts(db);
      await db.prepare("UPDATE sqlite_sequence SET seq = 500 WHERE name = 'task_review_submission_order'").run();
      await db.prepare("UPDATE sqlite_sequence SET seq = 700 WHERE name = 'task_event_offsets'").run();

      await applyMigrationSql(db, readFileSync(join(migrationsDirectory, migrationFile), "utf8"));

      await expect(rowCounts(db)).resolves.toEqual(before);
      await expect(db.prepare("PRAGMA foreign_key_check").all()).resolves.toMatchObject({ results: [] });

      const schema = await schemaSql(db, ["task_actions", "task_review_decisions"]);
      expect(schema.task_actions).toContain("'user', 'machine', 'service', 'realmroot:agent', 'agent:worker', 'agent:leader', 'system'");
      expect(schema.task_review_decisions).toContain("'user', 'machine', 'service', 'realmroot:agent', 'system'");

      await expect(objectNames(db, "index", "idx_task_actions_%")).resolves.toEqual([
        "idx_task_actions_actor",
        "idx_task_actions_id_task",
        "idx_task_actions_session",
        "idx_task_actions_task",
      ]);
      await expect(objectNames(db, "trigger", "%")).resolves.toEqual([
        "task_actions_event_offset_after_delete",
        "task_actions_event_offset_after_insert",
        "task_actions_snapshot_assigned_realmroot_actor_name",
        "tasks_event_offsets_after_delete",
      ]);

      await db
        .prepare(
          `INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at)
           VALUES ('post-service-action', 'task-child', 'service', 'service-1', 'commented', '2026-09-04T01:00:00.000Z')`,
        )
        .run();
      await db
        .prepare(
          `INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at)
           VALUES ('post-submission', 'task-child', 'realmroot:agent', 'agent-1', 'review_requested', '2026-09-04T01:01:00.000Z')`,
        )
        .run();
      await db.prepare("INSERT INTO task_review_submission_order (submission_id) VALUES ('post-submission')").run();

      await expect(db.prepare("SELECT ordinal FROM task_review_submission_order WHERE submission_id = 'post-submission'").first()).resolves.toEqual({
        ordinal: 501,
      });
      const eventOffset = await db
        .prepare("SELECT sequence FROM task_event_offsets WHERE action_id = 'post-service-action'")
        .first<{ sequence: number }>();
      expect(eventOffset!.sequence).toBeGreaterThan(700);
    } finally {
      await mf.dispose();
    }
  });
});

async function seedFixture(db: D1Database): Promise<void> {
  const now = "2026-09-04T00:00:00.000Z";
  await db
    .prepare("INSERT INTO boards (id, owner_id, name, type, created_at, updated_at) VALUES ('board-1', ?, 'Actor migration', 'ops', ?, ?)")
    .bind("actor-migration-owner", now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO tasks (id, board_id, seq, status, title, created_at, updated_at) VALUES ('task-parent', 'board-1', 1, 'done', 'Parent', ?, ?)",
    )
    .bind(now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO tasks
         (id, board_id, seq, status, title, assigned_to, assignee_identity_type, created_from, created_at, updated_at)
       VALUES ('task-child', 'board-1', 2, 'in_progress', 'Child', 'agent-1', 'realmroot_actor', 'task-parent', ?, ?)`,
    )
    .bind(now, now)
    .run();
  for (const [id, actorType, action] of [
    ["claim-action", "realmroot:agent", "claimed"],
    ["submission-action", "realmroot:agent", "review_requested"],
    ["decision-action", "user", "rejected"],
    ["release-action", "realmroot:agent", "released"],
  ] as const) {
    await db
      .prepare("INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at) VALUES (?, 'task-child', ?, 'agent-1', ?, ?)")
      .bind(id, actorType, action, now)
      .run();
  }
  await db.prepare("UPDATE tasks SET active_claim_id = 'claim-action' WHERE id = 'task-child'").run();
  await db.prepare("INSERT INTO task_dependencies (task_id, depends_on) VALUES ('task-child', 'task-parent')").run();
  await db
    .prepare(
      "INSERT INTO messages (id, task_id, sender_type, sender_id, content, created_at) VALUES ('message-1', 'task-child', 'user', 'user-1', 'keep', ?)",
    )
    .bind(now)
    .run();
  await db.prepare("INSERT INTO task_review_submission_order (submission_id) VALUES ('submission-action')").run();
  await db
    .prepare(
      `INSERT INTO task_review_decisions
         (review_submission_id, task_id, kind, reason, actor_type, actor_id, reservation_id, state, effect_state, action_id, created_at, decided_at)
       VALUES ('submission-action', 'task-child', 'rejection', 'keep', 'user', 'user-1', 'reservation-1', 'accepted', 'pending', 'decision-action', ?, ?)`,
    )
    .bind(now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO task_claim_deletions (claim_id, task_id, action_id, actor_type, actor_id, deleted_at)
       VALUES ('claim-action', 'task-child', 'release-action', 'realmroot:agent', 'agent-1', ?)`,
    )
    .bind(now)
    .run();
  await db
    .prepare(
      `INSERT INTO task_session_bindings (task_id, claim_action_id, agent_actor_id, runtime, runtime_session_id, bound_at)
       VALUES ('task-child', 'claim-action', 'agent-1', 'codex', 'session-1', ?)`,
    )
    .bind(now)
    .run();
}

async function rowCounts(db: D1Database): Promise<Record<string, number>> {
  return Object.fromEntries(
    await Promise.all(
      rebuiltTables.map(async (table) => {
        const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
        return [table, row!.count] as const;
      }),
    ),
  );
}

async function schemaSql(db: D1Database, names: string[]): Promise<Record<string, string>> {
  const rows = await db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (${names.map(() => "?").join(",")})`)
    .bind(...names)
    .all<{ name: string; sql: string }>();
  return Object.fromEntries(rows.results.map(({ name, sql }) => [name, sql.replace(/\s+/g, " ")]));
}

async function objectNames(db: D1Database, type: "index" | "trigger", pattern: string): Promise<string[]> {
  const rows = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name LIKE ? ORDER BY name")
    .bind(type, pattern)
    .all<{ name: string }>();
  return rows.results.map(({ name }) => name);
}
