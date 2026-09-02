// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import { seedUser, setupMiniflare } from "../../helpers/db";

const migrationsDirectory = join(process.cwd(), "migrations");

describe("0045 Task creation compensation migration", () => {
  it("adds an empty nullable creation token column to a full-history database", async () => {
    const { mf, db } = await setupMiniflare();
    try {
      const columns = await db.prepare("PRAGMA table_info(tasks)").all<{ name: string; notnull: number }>();
      expect(columns.results).toEqual(expect.arrayContaining([expect.objectContaining({ name: "creation_token", notnull: 0 })]));
      await expect(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE creation_token IS NOT NULL").first()).resolves.toEqual({ count: 0 });
    } finally {
      await mf.dispose();
    }
  });

  it("preserves every legacy metadata shape when upgrading a populated 0044 database", async () => {
    const mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "task-creation-compensation-migration" },
    });
    try {
      const db = await mf.getD1Database("DB");
      for (const file of readdirSync(migrationsDirectory)
        .filter((name) => name.endsWith(".sql") && name < "0045_task_creation_compensation.sql")
        .sort()) {
        await executeSqlFile(db, file);
      }

      await seedUser(db, "creation-migration-owner", "creation-migration@example.test");
      const { createBoard } = await import("../../../server/adapters/d1/boardRepo");
      const board = await createBoard(db, "creation-migration-owner", "Creation migration board", "ops");
      const fixtures = [
        ["metadata-object", { annotations: { "runtime.creationToken": "user-owned-value", keep: true }, other: { exact: true } }],
        ["metadata-string", { annotations: "legacy-string", other: "preserved" }],
        ["metadata-array", { annotations: ["legacy-array"], other: [1, 2] }],
        ["metadata-null", { annotations: null, other: null }],
      ] as const;
      const now = "2026-08-29T12:00:00.000Z";
      await db.batch(
        fixtures.map(([id, metadata], index) =>
          db
            .prepare(
              `INSERT INTO tasks (id, board_id, seq, status, title, metadata, created_at, updated_at)
               VALUES (?, ?, ?, 'todo', ?, ?, ?, ?)`,
            )
            .bind(id, board.id, index + 1, id, JSON.stringify(metadata), now, now),
        ),
      );

      await executeSqlFile(db, "0045_task_creation_compensation.sql");

      const migrated = await db.prepare("SELECT id, metadata, creation_token FROM tasks ORDER BY id").all<{
        id: string;
        metadata: string;
        creation_token: string | null;
      }>();
      expect(migrated.results).toEqual(
        [...fixtures]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([id, metadata]) => ({ id, metadata: JSON.stringify(metadata), creation_token: null })),
      );
    } finally {
      await mf.dispose();
    }
  });
});

async function executeSqlFile(db: D1Database, file: string): Promise<void> {
  const sql = readFileSync(join(migrationsDirectory, file), "utf8").replace(/^--.*$/gm, "");
  for (const statement of sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)) {
    await db.prepare(statement).run();
  }
}
