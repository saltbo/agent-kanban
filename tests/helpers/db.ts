import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { type ResourceScope, WEB_SESSION_SCOPES } from "../../server/auth/realmroot";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../migrations");
export function createTestEnv() {
  return {
    DB: null as any as D1Database,
    EMAIL: { send: async () => ({ messageId: "test-message" }) } as SendEmail,
    AUTH_SECRET: "test-secret-32-chars-minimum-ok!!",
    ALLOWED_HOSTS: "localhost:8788",
    GITHUB_CLIENT_ID: "x",
    GITHUB_CLIENT_SECRET: "x",
    OIDC_ISSUER: "https://id.realmroot.dev/api/auth",
    OIDC_WEB_CLIENT_ID: "ak-web-test",
    OIDC_WEB_CLIENT_SECRET: "ak-web-secret",
    OIDC_SERVICE_CLIENT_ID: "ak-service-test",
    OIDC_SERVICE_CLIENT_SECRET: "ak-service-secret",
    AK_SESSION_ENCRYPTION_KEY: btoa("01234567890123456789012345678901"),
    AK_PUBLIC_ORIGIN: "http://localhost:8788",
    AK_SIGNING_KEY: btoa("01234567890123456789012345678901"),
    AGENCY_ORIGIN: "https://enbor.test",
  };
}

export async function applyMigrations(db: D1Database) {
  const files = [
    "0001_initial.sql",
    "0002_rename_task_logs_to_task_notes.sql",
    "0003_agent_kind.sql",
    "0004_rename_task_notes_to_task_actions.sql",
    "0005_agent_runtime_required.sql",
    "0006_add_device_id.sql",
    "0007_task_seq.sql",
    "0008_board_sharing.sql",
    "0009_admin_fields.sql",
    "0010_board_type.sql",
    "0011_task_scheduled_at.sql",
    "0012_gpg_keys.sql",
    "0013_agent_identity.sql",
    "0014_agent_mailbox_token.sql",
    "0015_username_global_unique.sql",
    "0016_task_actions_session_id.sql",
    "0017_unique_leader_per_runtime.sql",
    "0018_agent_subagents.sql",
    "0019_agent_versions.sql",
    "0020_board_labels.sql",
    "0021_subagents.sql",
    "0022_ama_runtime_integration.sql",
    "0023_ama_session_secret_credential.sql",
    "0024_task_actions_dispatch.sql",
    "0025_machine_hosting.sql",
    "0026_agent_ama_agent_id.sql",
    "0027_github_installations.sql",
    "0028_board_maintainer_triggers_memory.sql",
    "0029_board_repositories.sql",
    "0030_agent_taints.sql",
    "0031_drop_board_maintainer_name.sql",
    "0032_board_maintainer_api_key.sql",
    "0033_board_maintainer_heartbeat_enabled.sql",
    "0034_task_assignee_status_index.sql",
    "0035_board_maintainer_vault.sql",
    "0036_backfill_ama_session_secret_refs.sql",
    "0037_unique_latest_leader_per_runtime.sql",
    "0038_board_maintainer_http_trigger_serial.sql",
    "0039_realmroot_native.sql",
    "0040_ama_resource_initialization_claims.sql",
    "0041_drop_realmroot_identity_mappings.sql",
    "0042_realmroot_user_ama_grants.sql",
    "0043_task_assignee_realmroot_actor.sql",
    "0044_task_review_decisions.sql",
    "0045_task_creation_compensation.sql",
    "0046_task_claim_deletions.sql",
    "0047_task_event_offsets.sql",
    "0048_task_session_bindings.sql",
    "0049_task_actor_display_snapshots.sql",
    "0050_resource_idempotency.sql",
    "0051_idempotent_response_snapshots.sql",
    "0052_realmroot_web_session_grants.sql",
    "0053_enbor_contract.sql",
    "0054_realmroot_web_session_scopes.sql",
    "0055_task_service_actor_types.sql",
    "0056_task_version.sql",
    "0057_realmroot_user_grants.sql",
  ];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    await applyMigrationSql(db, sql);
  }
}

export async function applyMigrationSql(db: D1Database, sql: string) {
  const triggerStart = sql.indexOf("CREATE TRIGGER");
  const ordinarySql = triggerStart === -1 ? sql : sql.slice(0, triggerStart);
  const statements = splitSqlStatements(ordinarySql);
  if (statements.length > 0) await db.batch(statements.map((statement) => db.prepare(statement)));
  if (triggerStart !== -1) {
    for (const trigger of sql
      .slice(triggerStart)
      .trim()
      .split(/\n(?=CREATE TRIGGER )/)) {
      await db.prepare(trigger.trim().replace(/;\s*$/, "")).run();
    }
  }
}

function splitSqlStatements(sql: string): string[] {
  sql = stripSqlLineComments(sql);
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index];
    if (quote) {
      if (character === quote && sql[index + 1] === quote) index++;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === ";") {
      const statement = sql.slice(start, index).trim();
      if (statement && !/^--[^\n]*$/.test(statement)) statements.push(statement);
      start = index + 1;
    }
  }
  const trailing = sql.slice(start).trim();
  if (trailing && !/^--[^\n]*$/.test(trailing)) statements.push(trailing);
  return statements;
}

function stripSqlLineComments(sql: string): string {
  let result = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index];
    if (quote) {
      result += character;
      if (character === quote && sql[index + 1] === quote) result += sql[++index];
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      result += character;
      continue;
    }
    if (character === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index++;
      result += "\n";
      continue;
    }
    result += character;
  }
  return result;
}

export async function seedUser(db: D1Database, id: string, email: string) {
  const now = new Date().toISOString();
  await db
    .prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)")
    .bind(id, "Test User", email, now, now)
    .run();
  await db.prepare("INSERT OR IGNORE INTO realmroot_tenants (id) VALUES (?)").bind(id).run();
  await db
    .prepare(
      `INSERT INTO realmroot_tenant_members (tenant_id, subject_id, email, name, role)
       VALUES (?, ?, ?, 'Test User', 'member')
       ON CONFLICT(tenant_id, subject_id) DO UPDATE SET email = excluded.email`,
    )
    .bind(id, `legacy:${id}`, email)
    .run();
}

export async function createTestWebSession(
  db: D1Database,
  tenantId: string,
  options: { role?: "member" | "admin"; subjectId?: string; email?: string; scopes?: ResourceScope[] } = {},
) {
  const token = randomUUID();
  const csrfToken = randomUUID();
  const id = randomUUID();
  await db
    .prepare(
      `INSERT INTO realmroot_web_sessions
        (id, token_hash, tenant_id, subject_id, email, name, role, scopes_json, csrf_token, expires_at)
       VALUES (?, ?, ?, ?, ?, 'Test User', ?, ?, ?, ?)`,
    )
    .bind(
      id,
      createHash("sha256").update(token).digest("hex"),
      tenantId,
      options.subjectId ?? `subject:${tenantId}`,
      options.email ?? `${tenantId}@test.local`,
      options.role ?? "member",
      JSON.stringify(options.scopes ?? WEB_SESSION_SCOPES),
      csrfToken,
      new Date(Date.now() + 3_600_000).toISOString(),
    )
    .run();
  return { id, token, csrfToken, cookie: `ak_session=${token}` };
}

export async function setupMiniflare() {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "test-db" },
  });
  const db = await mf.getD1Database("DB");
  await applyMigrations(db);
  return { mf, db };
}
