// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import { applyMigrationSql, seedUser } from "../../helpers/db";

const migrationsDirectory = join(process.cwd(), "migrations");
const migrationFile = "0053_enbor_contract.sql";

describe("0053 Enbor contract migration", () => {
  it("[spec: agents/agency-binding-migration] renames active Agency bindings and targets only known Task metadata contracts", async () => {
    const fixture = await preCutoverFixture();
    try {
      await applyMigrationSql(fixture.db, readFileSync(join(migrationsDirectory, migrationFile), "utf8"));

      await expect(tableNames(fixture.db, ["agency_owner_integrations", "agency_resource_initializations"])).resolves.toEqual([
        "agency_owner_integrations",
        "agency_resource_initializations",
      ]);
      await expect(tableNames(fixture.db, ["ama_owner_integrations", "ama_resource_initializations"])).resolves.toEqual([]);
      await expect(fixture.db.prepare("SELECT agency_project_id FROM agency_owner_integrations").first()).resolves.toEqual({
        agency_project_id: "project_1",
      });
      await expect(fixture.db.prepare("SELECT claim_token, expires_at FROM agency_resource_initializations").first()).resolves.toEqual({
        claim_token: "claim_1",
        expires_at: "2026-09-03T12:05:00.000Z",
      });
      await expect(
        fixture.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
          .bind("idx_agency_resource_initializations_expiry")
          .first(),
      ).resolves.toEqual({ name: "idx_agency_resource_initializations_expiry" });

      const task = await fixture.db.prepare("SELECT metadata FROM tasks WHERE id = 'task_1'").first<{ metadata: string }>();
      expect(JSON.parse(task!.metadata)).toEqual({
        runtime: "enbor",
        env: "ENBOR_ORIGIN",
        ref: "enbor://sessions/session_1",
        credentialType: "enbor.dev/basic-auth",
        skill: "enbor@realmroot",
        origin: "https://enbor.realmroot.dev",
        workspace: "/workspace/.enbor/state",
        model: "llama-3.3",
        llamaOrigin: "https://llama.tftt.cc",
        note: "The retired host https://ama.tftt.cc appears in migration notes",
        annotations: {
          "enbor.sessionId": "session_1",
          "enbor.dispatch.result": { status: "accepted" },
        },
      });
    } finally {
      await fixture.mf.dispose();
    }
  });
});

async function preCutoverFixture() {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "enbor-contract-migration" },
  });
  const db = await mf.getD1Database("DB");
  for (const file of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql") && name < migrationFile)
    .sort()) {
    await applyMigrationSql(db, readFileSync(join(migrationsDirectory, file), "utf8"));
  }

  const tenantId = "tenant_1";
  const now = "2026-09-03T12:00:00.000Z";
  await seedUser(db, tenantId, "migration@example.test");
  await db
    .prepare("INSERT INTO boards (id, owner_id, name, type, created_at, updated_at) VALUES (?, ?, ?, 'ops', ?, ?)")
    .bind("board_1", tenantId, "Migration", now, now)
    .run();
  await db.prepare("INSERT INTO ama_owner_integrations (tenant_id, ama_project_id) VALUES (?, ?)").bind(tenantId, "project_1").run();
  await db
    .prepare("INSERT INTO ama_resource_initializations (tenant_id, claim_token, expires_at) VALUES (?, ?, ?)")
    .bind(tenantId, "claim_1", "2026-09-03T12:05:00.000Z")
    .run();
  await db
    .prepare("INSERT INTO tasks (id, board_id, status, title, metadata, created_at, updated_at) VALUES (?, ?, 'done', ?, ?, ?, ?)")
    .bind(
      "task_1",
      "board_1",
      "Contract migration",
      JSON.stringify({
        runtime: "ama",
        env: "AMA_ORIGIN",
        ref: "ama://sessions/session_1",
        credentialType: "ama.dev/basic-auth",
        skill: "ama@realmroot",
        origin: "https://ama.tftt.cc",
        workspace: "/workspace/.ama/state",
        model: "llama-3.3",
        llamaOrigin: "https://llama.tftt.cc",
        note: "The retired host https://ama.tftt.cc appears in migration notes",
        annotations: {
          "ama.sessionId": "session_1",
          "ama.dispatch.result": { status: "accepted" },
        },
      }),
      now,
      now,
    )
    .run();
  return { mf, db };
}

async function tableNames(db: D1Database, names: string[]) {
  const placeholders = names.map(() => "?").join(",");
  const result = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders}) ORDER BY name`)
    .bind(...names)
    .all<{ name: string }>();
  return result.results.map(({ name }) => name);
}
