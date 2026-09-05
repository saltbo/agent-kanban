// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import { WEB_SESSION_SCOPES } from "../../../server/auth/realmroot";
import { applyMigrationSql, seedUser } from "../../helpers/db";

const migrationsDirectory = join(process.cwd(), "migrations");
const migrationFile = "0054_realmroot_web_session_scopes.sql";

describe("0054 Realmroot Web Session scopes migration", () => {
  it("backfills existing browser Sessions with the human OAuth scopes", async () => {
    const mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "realmroot-web-session-scopes-migration" },
    });
    try {
      const db = await mf.getD1Database("DB");
      for (const file of readdirSync(migrationsDirectory)
        .filter((name) => name.endsWith(".sql") && name < migrationFile)
        .sort()) {
        await applyMigrationSql(db, readFileSync(join(migrationsDirectory, file), "utf8"));
      }
      await seedUser(db, "session-scope-owner", "session-scope@example.test");
      await db
        .prepare(
          `INSERT INTO realmroot_web_sessions
             (id, token_hash, tenant_id, subject_id, email, name, role, csrf_token, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          "existing-session",
          "existing-token-hash",
          "session-scope-owner",
          "existing-subject",
          "session-scope@example.test",
          "Existing User",
          "member",
          "existing-csrf",
          "2099-01-01T00:00:00.000Z",
        )
        .run();

      await applyMigrationSql(db, readFileSync(join(migrationsDirectory, migrationFile), "utf8"));

      const stored = await db
        .prepare("SELECT id, scopes_json FROM realmroot_web_sessions WHERE id = ?")
        .bind("existing-session")
        .first<{ id: string; scopes_json: string }>();
      expect(stored?.id).toBe("existing-session");
      const scopes = JSON.parse(stored!.scopes_json) as string[];
      expect(scopes).toEqual(WEB_SESSION_SCOPES);
      expect(scopes).not.toEqual(expect.arrayContaining(["task:claim", "task:release"]));
    } finally {
      await mf.dispose();
    }
  });
});
