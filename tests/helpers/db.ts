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
    "0039_repository_source_type.sql",
    "0040_owner_settings.sql",
    "0041_relay_endpoints.sql",
  ];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    // Strip `--` line comments first: comment text may contain semicolons,
    // which would split into comment-only chunks D1 rejects as empty statements.
    const stripped = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    for (const stmt of stripped
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
  // AK calls AMA as the logged-in user's own linked AMA account; seed that link
  // so dispatch paths can resolve a per-user JWT token without triggering an
  // OIDC refresh round-trip in tests.
  await linkAmaAccount(db, id);
}

// Links an AMA generic-OIDC account to the user with a long-lived JWT-shaped
// access token so AMA calls do not trigger a refresh round-trip in tests.
export async function linkAmaAccount(db: D1Database, userId: string, accessToken = "test.jwt.token") {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  await db
    .prepare(
      "INSERT INTO account (id, accountId, providerId, userId, accessToken, refreshToken, accessTokenExpiresAt, scope, createdAt, updatedAt) VALUES (?, ?, 'ama', ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(`acct-ama-${userId}`, `ama-sub-${userId}`, userId, accessToken, "user-refresh", expiresAt, "openid profile email offline_access", now, now)
    .run();
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

export async function signUpVerifiedUser(
  db: D1Database,
  auth: any,
  body: { name: string; email: string; password: string },
  role = "user",
): Promise<{ token: string; user: { id: string } }> {
  await auth.api.signUpEmail({ body });
  await db.prepare("UPDATE user SET emailVerified = 1, role = ? WHERE email = ?").bind(role, body.email.toLowerCase()).run();
  const result = await auth.api.signInEmail({ body: { email: body.email, password: body.password } });
  if (!result.token) throw new Error("verified signInEmail did not return a token");
  return result;
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

/** Ensure user row exists + create agent with GPG identity. Drop-in replacement for bare createAgent() in tests. */
export async function createTestAgent(db: D1Database, ownerId: string, input: CreateAgentInput, builtin = false) {
  // Ensure user row exists (idempotent)
  const existing = await db.prepare("SELECT 1 FROM user WHERE id = ?").bind(ownerId).first();
  if (!existing) await seedUser(db, ownerId, `${ownerId}@test.local`);

  const { createAgent, createAgentIdentity } = await import("../../apps/web/server/agentRepo");
  const identity = await createAgentIdentity(db, ownerId, `${input.username}@mails.agent-kanban.dev`);
  const agent = await createAgent(db, ownerId, input, identity, builtin);
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
