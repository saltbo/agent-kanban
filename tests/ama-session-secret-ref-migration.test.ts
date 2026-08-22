// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(__dirname, "../apps/web/migrations");

let db: D1Database;
let mf: Miniflare;

async function applyMigrationFile(db: D1Database, file: string) {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
  for (const stmt of sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    await db.prepare(stmt).run();
  }
}

async function applyMigrationsThrough(db: D1Database, lastFile: string) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql") && file <= lastFile)
    .sort();
  for (const file of files) {
    await applyMigrationFile(db, file);
  }
}

describe("AMA session secret_ref migration", () => {
  beforeEach(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "test-db" },
    });
    db = await mf.getD1Database("DB");
    await applyMigrationsThrough(db, "0035_board_maintainer_vault.sql");
  });

  afterEach(async () => {
    await mf?.dispose();
  });

  it("freezes legacy session credential IDs to their owner session vault refs", async () => {
    const ownerId = "owner-secret-ref-backfill";
    const now = new Date().toISOString();
    await db
      .prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Test User', ?, 1, ?, ?)")
      .bind(ownerId, `${ownerId}@test.local`, now, now)
      .run();
    const agentId = "secret-ref-agent";
    await db
      .prepare(
        `INSERT INTO agents
          (id, owner_id, name, runtime, public_key, private_key, fingerprint, kind, username, created_at, updated_at)
         VALUES (?, ?, 'Secret ref agent', 'claude', 'public', 'private', 'fingerprint', 'worker', 'secret-ref-agent', ?, ?)`,
      )
      .bind(agentId, ownerId, now, now)
      .run();

    await db
      .prepare(
        `INSERT INTO ama_owner_integrations (owner_id, ama_project_id, external_tenant_id, session_secret_vault_id, metadata)
         VALUES (?, ?, ?, ?, '{}')`,
      )
      .bind(ownerId, "project_backfill", ownerId, "vault_old")
      .run();
    await db
      .prepare(
        `INSERT INTO ama_agent_sessions (
          id, owner_id, agent_id, ama_session_id, status, public_key, delegation_proof,
          secret_credential_id, secret_ref, created_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      )
      .bind("session-legacy", ownerId, agentId, "ama-session-legacy", "pub", "proof", "cred_legacy", null, now)
      .run();
    await db
      .prepare(
        `INSERT INTO ama_agent_sessions (
          id, owner_id, agent_id, ama_session_id, status, public_key, delegation_proof,
          secret_credential_id, secret_ref, created_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      )
      .bind(
        "session-current",
        ownerId,
        agentId,
        "ama-session-current",
        "pub",
        "proof",
        "cred_current",
        "ama://vaults/vault_new/credentials/cred_current",
        now,
      )
      .run();

    await applyMigrationFile(db, "0036_backfill_ama_session_secret_refs.sql");

    const legacy = await db.prepare("SELECT secret_ref FROM ama_agent_sessions WHERE id = ?").bind("session-legacy").first<{ secret_ref: string }>();
    const current = await db
      .prepare("SELECT secret_ref FROM ama_agent_sessions WHERE id = ?")
      .bind("session-current")
      .first<{ secret_ref: string }>();
    const columns = await db.prepare("PRAGMA table_info(ama_agent_sessions)").all<{ name: string }>();
    expect(legacy?.secret_ref).toBe("ama://vaults/vault_old/credentials/cred_legacy");
    expect(current?.secret_ref).toBe("ama://vaults/vault_new/credentials/cred_current");
    expect(columns.results.map((column) => column.name)).not.toContain("secret_credential_id");
  });
});
