import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CreateAgentInput, CreateSubagentInput } from "@agent-kanban/shared";
import { Miniflare } from "miniflare";

const MIGRATIONS_DIR = join(__dirname, "../../apps/web/migrations");

export function createTestEnv() {
  return {
    DB: null as any as D1Database,
    AE: { writeDataPoint: () => {} } as unknown as AnalyticsEngineDataset,
    EMAIL: { send: async () => ({ messageId: "test-message" }) } as SendEmail,
    AUTH_SECRET: "test-secret-32-chars-minimum-ok!!",
    ALLOWED_HOSTS: "localhost:8788",
    GITHUB_CLIENT_ID: "x",
    GITHUB_CLIENT_SECRET: "x",
    MAILS_ADMIN_TOKEN: "",
    REALMROOT_ISSUER: "https://id.realmroot.dev/api/auth",
    REALMROOT_WEB_CLIENT_ID: "ak-web-test",
    REALMROOT_WEB_CLIENT_SECRET: "ak-web-secret",
    REALMROOT_CLI_CLIENT_ID: "ak-cli-test",
    AK_RESOURCE: "http://localhost:8788/api",
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
  ];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    for (const stmt of sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await db.prepare(stmt).run();
    }
  }
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
  options: { role?: "member" | "admin"; subjectId?: string; email?: string } = {},
) {
  const token = randomUUID();
  const csrfToken = randomUUID();
  await db
    .prepare(
      `INSERT INTO realmroot_web_sessions
        (id, token_hash, tenant_id, subject_id, email, name, role, csrf_token, expires_at)
       VALUES (?, ?, ?, ?, ?, 'Test User', ?, ?, ?)`,
    )
    .bind(
      randomUUID(),
      createHash("sha256").update(token).digest("hex"),
      tenantId,
      options.subjectId ?? `subject:${tenantId}`,
      options.email ?? `${tenantId}@test.local`,
      options.role ?? "member",
      csrfToken,
      new Date(Date.now() + 3_600_000).toISOString(),
    )
    .run();
  return { token, csrfToken, cookie: `ak_session=${token}` };
}

// Sets the agent's ama_agent_id column (the AMA agent is now created eagerly at
// agent creation; dispatch reads this id). Mirrors what POST /api/agents stores.
export async function setAgentAmaId(db: D1Database, agentId: string, amaAgentId: string) {
  await db.prepare("UPDATE agents SET ama_agent_id = ? WHERE id = ?").bind(amaAgentId, agentId).run();
}

// Inserts a cloud-sandbox machine (no device/daemon) whose environment is a
// dispatch candidate for the given runtimes.
export async function addCloudSandboxMachine(db: D1Database, ownerId: string, runtimes: string[], amaEnvironmentId: string) {
  const now = new Date().toISOString();
  const id = `cloud-machine-${ownerId}-${amaEnvironmentId}`;
  await db
    .prepare(
      `INSERT INTO machines (id, owner_id, device_id, name, os, version, runtimes, status, hosting, ama_environment_id, last_heartbeat_at, created_at)
       VALUES (?, ?, ?, 'Cloud sandbox', 'cloud', 'cloud', ?, 'online', 'cloud', ?, ?, ?)
       ON CONFLICT(owner_id, device_id) DO UPDATE SET ama_environment_id = excluded.ama_environment_id, runtimes = excluded.runtimes`,
    )
    .bind(
      id,
      ownerId,
      `cloud-${id}`,
      JSON.stringify(runtimes.map((name) => ({ name, status: "ready", checked_at: now }))),
      amaEnvironmentId,
      now,
      now,
    )
    .run();
  return id;
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

/** Ensure the tenant exists and create an Agent with its native Ed25519 identity. */
export async function createTestAgent(db: D1Database, ownerId: string, input: CreateAgentInput, builtin = false) {
  // Ensure user row exists (idempotent)
  const existing = await db.prepare("SELECT 1 FROM user WHERE id = ?").bind(ownerId).first();
  if (!existing) await seedUser(db, ownerId, `${ownerId}@test.local`);

  const { createAgent, createAgentIdentity } = await import("../../apps/web/server/agentRepo");
  const identity = await createAgentIdentity();
  const realmrootInput = {
    ...input,
    realmroot_agent_id: input.realmroot_agent_id ?? `rr:${ownerId}:${input.username}`,
    realmroot_credential_ref: input.realmroot_credential_ref ?? `ama://vaults/test-${ownerId}/credentials/realmroot-${input.username}`,
  };
  const agent = await createAgent(db, ownerId, realmrootInput, identity, builtin);
  // Real agents are created eagerly with a backing AMA agent (POST /api/agents
  // stores agents.ama_agent_id); dispatch reads it. Mirror that for test agents
  // so they are dispatchable. Builtin/seed agents may exist without AMA.
  if (!builtin) await setAgentAmaId(db, agent.id, `ama-agent-${agent.id}`);
  return agent;
}

export async function createTestSubagent(db: D1Database, ownerId: string, input: CreateSubagentInput) {
  const existing = await db.prepare("SELECT 1 FROM user WHERE id = ?").bind(ownerId).first();
  if (!existing) await seedUser(db, ownerId, `${ownerId}@test.local`);

  const { createSubagent } = await import("../../apps/web/server/subagentRepo");
  return createSubagent(db, ownerId, input);
}
