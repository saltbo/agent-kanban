// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import { applyMigrationSql, seedUser } from "../../helpers/db";

const migrationsDirectory = join(process.cwd(), "migrations");
const migrationFile = "0043_task_assignee_realmroot_actor.sql";

describe("0043 Task assignee v2 guard migration", () => {
  it("rejects an old-schema active Task before rebuilding the tasks table", async () => {
    const fixture = await oldSchemaFixture("active", "in_progress");
    try {
      await expect(apply0043(fixture.db)).rejects.toThrow();
      const columns = await fixture.db.prepare("PRAGMA table_info(tasks)").all<{ name: string }>();
      expect(columns.results.map(({ name }) => name)).not.toContain("assignee_identity_type");
      await expect(fixture.db.prepare("SELECT id, status FROM tasks WHERE id = 'active'").first()).resolves.toEqual({
        id: "active",
        status: "in_progress",
      });
      await expect(fixture.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks_v2'").first()).resolves.toBeNull();
    } finally {
      await fixture.mf.dispose();
    }
  });

  it("upgrades terminal old-schema Tasks while preserving the legacy assignee without assigning a v2 identity type", async () => {
    const fixture = await oldSchemaFixture("terminal", "done", "legacy-agent");
    try {
      await apply0043(fixture.db);
      await expect(
        fixture.db.prepare("SELECT status, assigned_to, assignee_identity_type FROM tasks WHERE id = 'terminal'").first(),
      ).resolves.toEqual({ status: "done", assigned_to: "legacy-agent", assignee_identity_type: null });
    } finally {
      await fixture.mf.dispose();
    }
  });
});

async function oldSchemaFixture(id: string, status: string, assignedTo: string | null = null) {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: `task-assignee-v2-guard-${id}` },
  });
  const db = await mf.getD1Database("DB");
  for (const file of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql") && name < migrationFile)
    .sort()) {
    await applyMigrationSql(db, readFileSync(join(migrationsDirectory, file), "utf8"));
  }
  await seedUser(db, `owner-${id}`, `${id}@example.test`);
  const boardId = `board-${id}`;
  const now = "2026-09-02T00:00:00.000Z";
  await db
    .prepare("INSERT INTO boards (id, owner_id, name, type, created_at, updated_at) VALUES (?, ?, ?, 'ops', ?, ?)")
    .bind(boardId, `owner-${id}`, boardId, now, now)
    .run();
  if (assignedTo) {
    await db
      .prepare(
        "INSERT INTO agents (id, owner_id, name, runtime, public_key, private_key, fingerprint, builtin, created_at, updated_at) VALUES (?, ?, ?, 'codex', 'public', 'private', 'fingerprint', 0, ?, ?)",
      )
      .bind(assignedTo, `owner-${id}`, assignedTo, now, now)
      .run();
  }
  await db
    .prepare("INSERT INTO tasks (id, board_id, status, title, assigned_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, boardId, status, id, assignedTo, now, now)
    .run();
  return { mf, db };
}

function apply0043(db: D1Database): Promise<void> {
  return applyMigrationSql(db, readFileSync(join(migrationsDirectory, migrationFile), "utf8"));
}
