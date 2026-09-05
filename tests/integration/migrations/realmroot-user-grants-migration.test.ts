import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { storeWebSessionGrant } from "@server/adapters/realmroot/delegatedAgencyToken";
import type { Env } from "@server/env";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { applyMigrationSql, createTestEnv, createTestWebSession, seedUser } from "../../helpers/db";

it("preserves existing encrypted grants while replacing the browser-bound table", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "user-grant-migration" },
  });
  try {
    const db = await mf.getD1Database("DB");
    const directory = join(process.cwd(), "migrations");
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith(".sql") && name < "0057_realmroot_user_grants.sql")
      .sort()) {
      await applyMigrationSql(db, readFileSync(join(directory, file), "utf8"));
    }
    await seedUser(db, "tenant", "user@example.test");
    const session = await createTestWebSession(db, "tenant", { subjectId: "user" });
    await db
      .prepare(`INSERT INTO realmroot_web_session_grants
      (session_id, refresh_token_ciphertext, refresh_token_nonce, access_token_ciphertext, access_token_nonce, access_token_expires_at)
      VALUES (?, 'encrypted-refresh', 'refresh-nonce', 'encrypted-access', 'access-nonce', '2030-01-01T00:00:00Z')`)
      .bind(session.id)
      .run();
    await applyMigrationSql(db, readFileSync(join(directory, "0057_realmroot_user_grants.sql"), "utf8"));
    expect(await db.prepare("SELECT tenant_id, subject_id, refresh_token_ciphertext FROM realmroot_user_grants").first()).toEqual({
      tenant_id: "tenant",
      subject_id: "user",
      refresh_token_ciphertext: "encrypted-refresh",
    });
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'realmroot_web_session_grants'").first()).toBeNull();
    await db.prepare("DELETE FROM realmroot_web_sessions WHERE id = ?").bind(session.id).run();
    expect(await db.prepare("SELECT COUNT(*) AS count FROM realmroot_user_grants").first()).toEqual({ count: 1 });
    const login = await createTestWebSession(db, "tenant", { subjectId: "user" });
    await storeWebSessionGrant({ ...createTestEnv(), DB: db } as Env, login.id, {
      access_token: "new-token",
      refresh_token: "new-refresh",
      expires_in: 300,
    });
    const rows = await db.prepare("SELECT * FROM realmroot_user_grants").all();
    expect(rows.results).toHaveLength(1);
    expect(JSON.stringify(rows.results)).not.toContain("new-refresh");
    expect(JSON.stringify(rows.results)).not.toContain("new-token");
  } finally {
    await mf.dispose();
  }
});
