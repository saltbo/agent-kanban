// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDirectory = join(process.cwd(), "apps/web/migrations");
const contractPath = join(process.cwd(), "scripts/realmroot-contract.sql");
const betterAuthTables = ["user", "account", "session", "verification", "apikey"] as const;
const realmrootRuntimeTables = [
  "realmroot_tenants",
  "realmroot_tenant_members",
  "realmroot_login_attempts",
  "realmroot_web_sessions",
  "realmroot_native_machine_bindings",
  "realmroot_dpop_replays",
  "ama_resource_initializations",
] as const;

let mf: Miniflare;
let migrationDb: D1Database;
let contractDb: D1Database;
let grantMigrationDb: D1Database;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: {
      MIGRATION_DB: "realmroot-0041-cutover",
      CONTRACT_DB: "realmroot-contract-cutover",
      GRANT_MIGRATION_DB: "realmroot-0042-user-grants",
    },
  });
  migrationDb = await mf.getD1Database("MIGRATION_DB");
  contractDb = await mf.getD1Database("CONTRACT_DB");
  grantMigrationDb = await mf.getD1Database("GRANT_MIGRATION_DB");
  await Promise.all([prepare0040Database(migrationDb), prepare0040Database(contractDb), prepare0040Database(grantMigrationDb)]);
});

afterAll(async () => mf.dispose());

describe("Realmroot Native hard cutover data retention", () => {
  it("upgrades 0040 to 0041 without changing Better Auth source data or Realmroot runtime state", async () => {
    const betterAuthBefore = await snapshotTables(migrationDb, betterAuthTables);
    const runtimeBefore = await snapshotTables(migrationDb, realmrootRuntimeTables);

    await executeSqlFile(migrationDb, join(migrationsDirectory, "0041_drop_realmroot_identity_mappings.sql"));

    await expectTableMissing(migrationDb, "realmroot_identity_mappings");
    expect(await snapshotTables(migrationDb, betterAuthTables)).toEqual(betterAuthBefore);
    expect(await snapshotTables(migrationDb, realmrootRuntimeTables)).toEqual(runtimeBefore);
    expect(await migrationDb.prepare("PRAGMA foreign_key_check").all()).toMatchObject({ results: [] });
  });

  it("applies the final contract without deleting Better Auth tables or representative data", async () => {
    const betterAuthBefore = await snapshotTables(contractDb, betterAuthTables);
    const runtimeBefore = await snapshotTables(contractDb, realmrootRuntimeTables);

    await executeSqlFile(contractDb, contractPath);

    await expectTableMissing(contractDb, "realmroot_identity_mappings");
    expect(await snapshotTables(contractDb, betterAuthTables)).toEqual(betterAuthBefore);
    expect(await snapshotTables(contractDb, realmrootRuntimeTables)).toEqual(runtimeBefore);
    await expectTableMissing(contractDb, "gpg_keys");
    const agentColumns = await contractDb.prepare("PRAGMA table_info(agents)").all<{ name: string }>();
    expect(agentColumns.results.map(({ name }) => name)).not.toContain("gpg_subkey_id");
    expect(await contractDb.prepare("PRAGMA foreign_key_check").all()).toMatchObject({ results: [] });
  });

  it("applies 0042 without changing Better Auth data and removes only the mistaken Agent Realmroot columns", async () => {
    await executeSqlFile(grantMigrationDb, join(migrationsDirectory, "0041_drop_realmroot_identity_mappings.sql"));
    const betterAuthBefore = await snapshotTables(grantMigrationDb, betterAuthTables);
    const retainedRuntimeTables = realmrootRuntimeTables.filter((table) => table !== "realmroot_web_sessions");
    const runtimeBefore = await snapshotTables(grantMigrationDb, retainedRuntimeTables);
    const columnsBefore = await grantMigrationDb.prepare("PRAGMA table_info(agents)").all<{ name: string }>();
    expect(columnsBefore.results.map(({ name }) => name)).toEqual(expect.arrayContaining(["realmroot_agent_id", "realmroot_credential_ref"]));

    await executeSqlFile(grantMigrationDb, join(migrationsDirectory, "0042_realmroot_user_ama_grants.sql"));

    expect(await snapshotTables(grantMigrationDb, betterAuthTables)).toEqual(betterAuthBefore);
    expect(await snapshotTables(grantMigrationDb, retainedRuntimeTables)).toEqual(runtimeBefore);
    expect(await grantMigrationDb.prepare("SELECT COUNT(*) AS count FROM realmroot_web_sessions").first()).toEqual({ count: 0 });
    const columnsAfter = await grantMigrationDb.prepare("PRAGMA table_info(agents)").all<{ name: string }>();
    expect(columnsAfter.results.map(({ name }) => name)).not.toEqual(expect.arrayContaining(["realmroot_agent_id", "realmroot_credential_ref"]));
    expect(await tableNames(grantMigrationDb)).toEqual(expect.arrayContaining(["realmroot_user_ama_grants", "ak_agent_jwt_replays"]));
    expect(await grantMigrationDb.prepare("PRAGMA foreign_key_check").all()).toMatchObject({ results: [] });
  });
});

async function prepare0040Database(database: D1Database): Promise<void> {
  for (const file of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql") && name < "0039_realmroot_native.sql")
    .sort()) {
    await executeSqlFile(database, join(migrationsDirectory, file));
  }

  const now = "2026-08-19T00:00:00.000Z";
  await database.batch([
    database
      .prepare(
        `INSERT INTO user
          (id, name, email, emailVerified, image, createdAt, updatedAt, role)
         VALUES ('legacy-owner', 'Legacy Owner', 'legacy@example.test', 1, 'https://example.test/avatar.png', ?, ?, 'admin')`,
      )
      .bind(now, now),
    database
      .prepare(
        `INSERT INTO session
          (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId)
         VALUES ('ba-session', ?, 'ba-token', ?, ?, '192.0.2.1', 'AK migration test', 'legacy-owner')`,
      )
      .bind("2027-08-19T00:00:00.000Z", now, now),
    database
      .prepare(
        `INSERT INTO account
          (id, accountId, providerId, userId, accessToken, refreshToken, idToken, accessTokenExpiresAt,
           refreshTokenExpiresAt, scope, password, createdAt, updatedAt)
         VALUES ('ba-account', 'github-1', 'github', 'legacy-owner', 'access-token', 'refresh-token', 'id-token',
                 '2027-01-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z', 'repo user:email', 'password-hash', ?, ?)`,
      )
      .bind(now, now),
    database
      .prepare(
        `INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt)
         VALUES ('ba-verification', 'legacy@example.test', 'verification-secret', '2027-08-19T00:00:00.000Z', ?, ?)`,
      )
      .bind(now, now),
    database
      .prepare(
        `INSERT INTO apikey
          (id, configId, name, start, referenceId, prefix, key, enabled, rateLimitEnabled,
           requestCount, remaining, expiresAt, createdAt, updatedAt, permissions, metadata)
         VALUES ('ba-api-key', 'default', 'Historical key', 'ak_', 'legacy-owner', 'ak_', 'hashed-key', 1, 1,
                 3, 97, '2027-08-19T00:00:00.000Z', ?, ?, '{"tasks":["read"]}', '{"source":"historical"}')`,
      )
      .bind(now, now),
    database
      .prepare("INSERT INTO boards (id, owner_id, name, type, created_at) VALUES ('board-1', 'legacy-owner', 'Historical board', 'ops', ?)")
      .bind(now),
    database
      .prepare(
        "INSERT INTO repositories (id, owner_id, name, url, created_at) VALUES ('repo-1', 'legacy-owner', 'Historical repo', 'https://github.com/example/repo', ?)",
      )
      .bind(now),
    database
      .prepare(
        `INSERT INTO machines (id, owner_id, name, status, os, version, runtimes, created_at, device_id)
         VALUES ('machine-1', 'legacy-owner', 'Historical machine', 'offline', 'darwin', '1', '[]', ?, 'device-1')`,
      )
      .bind(now),
    database
      .prepare(
        `INSERT INTO agents
          (id, owner_id, name, runtime, public_key, private_key, fingerprint, kind, username, version, created_at, updated_at)
         VALUES ('agent-1', 'legacy-owner', 'Historical agent', 'claude', 'public', 'private', 'fingerprint', 'worker',
                 'historical-agent', 'latest', ?, ?)`,
      )
      .bind(now, now),
    database
      .prepare(
        `INSERT INTO subagents (id, owner_id, name, username, created_at, updated_at)
         VALUES ('subagent-1', 'legacy-owner', 'Historical subagent', 'historical-subagent', ?, ?)`,
      )
      .bind(now, now),
    database
      .prepare(
        `INSERT INTO gpg_keys
          (id, owner_id, armored_private_key, armored_public_key, fingerprint, created_at, updated_at)
         VALUES ('gpg-1', 'legacy-owner', 'private', 'public', 'gpg-fingerprint', ?, ?)`,
      )
      .bind(now, now),
    database
      .prepare(
        `INSERT INTO ama_owner_integrations
          (owner_id, ama_project_id, external_tenant_id, session_secret_vault_id, metadata, created_at, updated_at)
         VALUES ('legacy-owner', 'project-1', 'legacy-owner', 'vault-1', '{}', ?, ?)`,
      )
      .bind(now, now),
    database
      .prepare(
        `INSERT INTO github_installations
          (installation_id, owner_id, account_login, account_id, account_type, repository_selection, created_at, updated_at)
         VALUES (1001, 'legacy-owner', 'example', 1001, 'Organization', 'all', ?, ?)`,
      )
      .bind(now, now),
  ]);

  await executeSqlFile(database, join(migrationsDirectory, "0039_realmroot_native.sql"));
  await executeSqlFile(database, join(migrationsDirectory, "0040_ama_resource_initialization_claims.sql"));
  await database.batch([
    database
      .prepare(
        `INSERT INTO realmroot_tenant_members (tenant_id, subject_id, email, name, role, created_at, updated_at)
         VALUES ('legacy-owner', 'realmroot-subject', 'realmroot@example.test', 'Realmroot User', 'admin', ?, ?)`,
      )
      .bind(now, now),
    database
      .prepare(
        `INSERT INTO realmroot_login_attempts
          (id_hash, state_hash, nonce, pkce_verifier, return_to, expires_at, created_at)
         VALUES ('login-id-hash', 'login-state-hash', 'login-nonce', 'pkce-verifier', '/boards/board-1',
                 '2027-08-19T00:00:00.000Z', ?)`,
      )
      .bind(now),
    database
      .prepare(
        `INSERT INTO realmroot_web_sessions
          (id, token_hash, tenant_id, subject_id, email, name, role, csrf_token, expires_at, created_at, updated_at)
         VALUES ('web-session', 'web-session-hash', 'legacy-owner', 'realmroot-subject', 'realmroot@example.test',
                 'Realmroot User', 'admin', 'csrf-token', '2027-08-19T00:00:00.000Z', ?, ?)`,
      )
      .bind(now, now),
    database
      .prepare(
        `INSERT INTO realmroot_native_machine_bindings (tenant_id, subject_id, machine_id, created_at)
         VALUES ('legacy-owner', 'realmroot-subject', 'machine-1', ?)`,
      )
      .bind(now),
    database
      .prepare(
        `INSERT INTO realmroot_identity_mappings (legacy_owner_id, tenant_id, migrated_at)
         VALUES ('legacy-owner', 'legacy-owner', ?)`,
      )
      .bind(now),
    database.prepare(
      `INSERT INTO realmroot_dpop_replays (thumbprint, jti, expires_at)
       VALUES ('dpop-thumbprint', 'dpop-jti', '2027-08-19T00:00:00.000Z')`,
    ),
    database
      .prepare(
        `INSERT INTO ama_resource_initializations (tenant_id, claim_token, expires_at, created_at)
         VALUES ('legacy-owner', 'initialization-claim', '2027-08-19T00:00:00.000Z', ?)`,
      )
      .bind(now),
  ]);
}

async function snapshotTables(database: D1Database, tableNames: readonly string[]) {
  const snapshots: Record<string, unknown> = {};
  for (const table of tableNames) {
    const schema = await database
      .prepare(
        `SELECT type, name, sql
         FROM sqlite_master
         WHERE (type = 'table' AND name = ?) OR (type = 'index' AND tbl_name = ?)
         ORDER BY type DESC, name`,
      )
      .bind(table, table)
      .all();
    const columns = await database.prepare(`PRAGMA table_info("${table}")`).all();
    const foreignKeys = await database.prepare(`PRAGMA foreign_key_list("${table}")`).all();
    const rows = await database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
    snapshots[table] = {
      schema: schema.results,
      columns: columns.results,
      foreignKeys: foreignKeys.results,
      rows: rows.results,
    };
  }
  return snapshots;
}

async function expectTableMissing(database: D1Database, table: string): Promise<void> {
  expect(await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first()).toBeNull();
}

async function tableNames(database: D1Database): Promise<string[]> {
  const result = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
  return result.results.map(({ name }) => name);
}

async function executeSqlFile(database: D1Database, path: string): Promise<void> {
  const sql = readFileSync(path, "utf8").replace(/^--.*$/gm, "");
  for (const statement of sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)) {
    await database.prepare(statement).run();
  }
}
