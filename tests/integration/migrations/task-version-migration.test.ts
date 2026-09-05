// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import { applyMigrationSql, seedUser } from "../../helpers/db";

const migrationsDirectory = join(process.cwd(), "migrations");
const migrationFile = "0056_task_version.sql";

describe("0056 Task version migration", () => {
  it("preserves existing Tasks at version one and requires a monotonic version on new rows", async () => {
    const mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "task-version-migration" },
    });
    try {
      const db = await mf.getD1Database("DB");
      for (const file of readdirSync(migrationsDirectory)
        .filter((name) => name.endsWith(".sql") && name < migrationFile)
        .sort()) {
        await applyMigrationSql(db, readFileSync(join(migrationsDirectory, file), "utf8"));
      }
      await seedUser(db, "task-version-owner", "task-version@example.test");
      await db
        .prepare(
          `INSERT INTO boards (id, owner_id, name, type, created_at, updated_at)
           VALUES ('task-version-board', 'task-version-owner', 'Versioned Tasks', 'ops', '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z')`,
        )
        .run();
      await db
        .prepare(
          `INSERT INTO tasks (id, board_id, seq, status, title, created_at, updated_at)
           VALUES ('existing-task', 'task-version-board', 1, 'in_progress', 'Preserved Task', '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z')`,
        )
        .run();

      await applyMigrationSql(db, readFileSync(join(migrationsDirectory, migrationFile), "utf8"));

      await expect(db.prepare("SELECT id, status, title, version FROM tasks WHERE id = 'existing-task'").first()).resolves.toEqual({
        id: "existing-task",
        status: "in_progress",
        title: "Preserved Task",
        version: 1,
      });
      const versionColumn = await db.prepare("PRAGMA table_info('tasks')").all<{ name: string; notnull: number; dflt_value: string | null }>();
      expect(versionColumn.results.find(({ name }) => name === "version")).toMatchObject({ notnull: 1, dflt_value: "1" });

      await db
        .prepare(
          `INSERT INTO tasks (id, board_id, seq, status, title, created_at, updated_at)
           VALUES ('new-task', 'task-version-board', 2, 'todo', 'New Task', '2026-09-04T00:01:00.000Z', '2026-09-04T00:01:00.000Z')`,
        )
        .run();
      await expect(db.prepare("SELECT version FROM tasks WHERE id = 'new-task'").first()).resolves.toEqual({ version: 1 });
      await expect(db.prepare("UPDATE tasks SET version = NULL WHERE id = 'new-task'").run()).rejects.toThrow(/NOT NULL constraint failed/);
    } finally {
      await mf.dispose();
    }
  });
});
