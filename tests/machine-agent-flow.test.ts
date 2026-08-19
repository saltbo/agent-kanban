// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT } from "jose";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestAgent } from "./helpers/db";

// Integration test: full flow — user creates agent → machine creates session → agent claims task
// Tests the actual Hono routes with auth middleware.

const MIGRATIONS_DIR = join(__dirname, "../apps/web/migrations");
const AUTH_SECRET = "test-secret-32-chars-minimum-ok!!";
const BETTER_AUTH_URL = "http://localhost:8788";

const env = {
  DB: null as any as D1Database,
  AE: { writeDataPoint: () => {} } as unknown as AnalyticsEngineDataset,
  AUTH_SECRET,
  ALLOWED_HOSTS: "localhost:8788",
  GITHUB_CLIENT_ID: "x",
  GITHUB_CLIENT_SECRET: "x",
};

let mf: Miniflare;

async function applyMigrations(db: D1Database) {
  const files = [
    "0001_initial.sql",
    "0002_rename_task_logs_to_task_notes.sql",
    "0003_agent_kind.sql",
    "0004_rename_task_notes_to_task_actions.sql",
    "0005_agent_runtime_required.sql",
    "0006_add_device_id.sql",
    "0007_task_seq.sql",
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
    "0021_subagents.sql",
    "0022_ama_runtime_integration.sql",
    "0025_machine_hosting.sql",
    "0026_agent_ama_agent_id.sql",
    "0028_board_maintainer_triggers_memory.sql",
    "0030_agent_taints.sql",
    "0031_drop_board_maintainer_name.sql",
    "0032_board_maintainer_api_key.sql",
    "0039_repository_source_type.sql",
    "0040_owner_settings.sql",
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

async function seedUser(db: D1Database): Promise<string> {
  const userId = "test-user-flow";
  const now = new Date().toISOString();
  await db
    .prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)")
    .bind(userId, "Flow Test User", "flow@example.com", now, now)
    .run();
  return userId;
}

async function createApiKeyForUser(db: D1Database, userId: string): Promise<string> {
  const { createAuth } = await import("../apps/web/server/betterAuth");
  const auth = createAuth({ ...env, DB: db });
  const result = await auth.api.createApiKey({ body: { userId } });
  return result.key;
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "test-db" },
  });
  const db = await mf.getD1Database("DB");
  env.DB = db;
  await applyMigrations(db);
});

afterAll(async () => {
  await mf.dispose();
});

describe("machine → agent session flow", () => {
  let userId: string;
  let apiKey: string;
  let machineId: string;
  let agentId: string;
  let sessionId: string;
  let sessionPrivateKey: CryptoKey;
  let leaderAgentId: string;
  let leaderSessionId: string;
  let leaderSessionPrivateKey: CryptoKey;
  let boardId: string;
  let taskId: string;

  async function apiRequest(method: string, path: string, body?: any, token?: string) {
    const { api } = await import("../apps/web/server/routes");
    const headers: Record<string, string> = { "Content-Type": "application/json", Host: "localhost:8788", "x-forwarded-proto": "http" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const init: RequestInit = { method, headers };
    if (body) init.body = JSON.stringify(body);
    return api.request(path, init, env);
  }

  async function signSessionJWT(): Promise<string> {
    return new SignJWT({ sub: sessionId, aid: agentId, jti: randomUUID(), aud: BETTER_AUTH_URL })
      .setProtectedHeader({ alg: "EdDSA", typ: "agent+jwt" })
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(sessionPrivateKey);
  }

  async function signLeaderSessionJWT(): Promise<string> {
    return new SignJWT({ sub: leaderSessionId, aid: leaderAgentId, jti: randomUUID(), aud: BETTER_AUTH_URL })
      .setProtectedHeader({ alg: "EdDSA", typ: "agent+jwt" })
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(leaderSessionPrivateKey);
  }

  it("creates user and API key", async () => {
    userId = await seedUser(env.DB);
    apiKey = await createApiKeyForUser(env.DB, userId);
    expect(apiKey.startsWith("ak_")).toBe(true);
  });

  it("creates a machine via API", async () => {
    const res = await apiRequest(
      "POST",
      "/api/machines",
      {
        name: "test-machine-01",
        os: "darwin arm64",
        version: "1.0.0",
        runtimes: [{ name: "claude", status: "ready", checked_at: "2026-03-21T10:00:00Z" }],
        device_id: "test-device-agent-flow",
      },
      apiKey,
    );
    expect(res.status).toBe(201);
    const machine = (await res.json()) as any;
    machineId = machine.id;
  });

  it("machine heartbeat updates status to online", async () => {
    const res = await apiRequest("POST", `/api/machines/${machineId}/heartbeat`, {}, apiKey);
    expect(res.status).toBe(200);
  });

  it("user creates a persistent agent", async () => {
    // Create agent directly via repo (user-only route, no API key auth in test)
    const agent = await createTestAgent(env.DB, userId, {
      name: "Test Agent",
      username: "test-agent",
      runtime: "claude",
      model: "claude-sonnet-4-20250514",
    });
    agentId = agent.id;
    expect(agent.fingerprint).toBeTruthy();
    expect(agent.public_key).toBeTruthy();
  });

  it("machine creates a session for the agent (CSR)", async () => {
    sessionId = randomUUID();
    const keypair = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"]);
    sessionPrivateKey = (keypair as any).privateKey;
    const pubJwk = await crypto.subtle.exportKey("jwk", (keypair as any).publicKey);

    const res = await apiRequest(
      "POST",
      `/api/agents/${agentId}/sessions`,
      {
        session_id: sessionId,
        session_public_key: pubJwk.x!,
      },
      apiKey,
    );
    expect(res.status).toBe(201);
    const result = (await res.json()) as any;
    expect(result.delegation_proof).toBeTruthy();

    // Verify BA agent was created for this session
    const baAgent = await env.DB.prepare("SELECT * FROM agent WHERE id = ?").bind(sessionId).first();
    expect(baAgent).toBeTruthy();
  });

  it("session JWT authenticates through HTTP handler", async () => {
    const jwt = await signSessionJWT();
    const res = await apiRequest("GET", "/api/agents", undefined, jwt);
    expect(res.status).toBe(200);
  });

  it("machine creates a leader agent and session", async () => {
    const leaderAgent = await createTestAgent(env.DB, userId, {
      name: "Flow Leader Agent",
      username: "flow-leader-agent",
      runtime: "claude",
      kind: "leader",
    });
    leaderAgentId = leaderAgent.id;

    leaderSessionId = randomUUID();
    const keypair = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"]);
    leaderSessionPrivateKey = (keypair as any).privateKey;
    const pubJwk = await crypto.subtle.exportKey("jwk", (keypair as any).publicKey);

    const res = await apiRequest(
      "POST",
      `/api/agents/${leaderAgentId}/sessions`,
      { session_id: leaderSessionId, session_public_key: pubJwk.x! },
      apiKey,
    );
    expect(res.status).toBe(201);
  });

  it("creates a board and task", async () => {
    const board = await (await import("../apps/web/server/boardRepo")).createBoard(env.DB, userId, "test-board", "ops");
    boardId = board.id;
    const task = await (await import("../apps/web/server/taskRepo")).createTask(env.DB, userId, {
      title: "Test task for agent",
      board_id: boardId,
    });
    taskId = task.id;
  });

  it("leader agent self-assign is rejected (400)", async () => {
    const leaderJwt = await signLeaderSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${taskId}/assign`, {}, leaderJwt);
    expect(res.status).toBe(400);
  });

  it("agent claims the worker-assigned task via session JWT", async () => {
    // Re-assign the task to the worker agent directly via repo so the worker can claim it
    const { assignTask } = await import("../apps/web/server/taskRepo");
    await env.DB.prepare("UPDATE tasks SET status = 'todo', assigned_to = NULL WHERE id = ?").bind(taskId).run();
    await assignTask(env.DB, taskId, agentId, "machine", "system", null, {
      metadata: { annotations: { "runtime.source": "legacy" } },
    });

    const jwt = await signSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${taskId}/claim`, { agent_id: agentId }, jwt);
    expect(res.status).toBe(200);
    const task = (await res.json()) as any;
    expect(task.status).toBe("in_progress");
  });

  it("agent adds a task note", async () => {
    const jwt = await signSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${taskId}/notes`, { detail: "Working on it" }, jwt);
    expect(res.status).toBe(201);
  });

  it("agent submits task for review", async () => {
    const jwt = await signSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${taskId}/review`, { pr_url: "https://github.com/test/repo/pull/1" }, jwt);
    expect(res.status).toBe(200);
    const task = (await res.json()) as any;
    expect(task.status).toBe("in_review");
  });

  it("agent reports session usage", async () => {
    const jwt = await signSessionJWT();
    const res = await apiRequest(
      "PATCH",
      `/api/agents/${agentId}/sessions/${sessionId}/usage`,
      {
        input_tokens: 1500,
        output_tokens: 800,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_micro_usd: 0,
      },
      jwt,
    );
    expect(res.status).toBe(200);

    const session = await env.DB.prepare("SELECT input_tokens, output_tokens FROM agent_sessions WHERE id = ?").bind(sessionId).first();
    expect(session!.input_tokens).toBe(1500);
    expect(session!.output_tokens).toBe(800);
  });

  it("GET /api/machines/:id returns agents with correct fields", async () => {
    const res = await apiRequest("GET", `/api/machines/${machineId}`, undefined, apiKey);
    expect(res.status).toBe(200);
    const machine = (await res.json()) as any;
    // Both worker and leader agents have sessions on this machine
    expect(machine.agents.length).toBeGreaterThanOrEqual(1);
    const workerAgent = machine.agents.find((a: any) => a.id === agentId);
    expect(workerAgent).toBeDefined();
    expect(workerAgent.name).toBe("Test Agent");
    expect(workerAgent.active_session_count).toBeGreaterThan(0);
    expect(workerAgent.last_session_at).toBeTruthy();
  });

  it("final state is consistent", async () => {
    const machine = await env.DB.prepare("SELECT status FROM machines WHERE id = ?").bind(machineId).first();
    expect(machine!.status).toBe("online");

    const agent = (await env.DB.prepare("SELECT * FROM agents WHERE id = ?").bind(agentId).first()) as any;
    expect(agent.owner_id).toBe(userId);

    const session = (await env.DB.prepare("SELECT * FROM agent_sessions WHERE id = ?").bind(sessionId).first()) as any;
    expect(session.agent_id).toBe(agentId);
    expect(session.machine_id).toBe(machineId);

    const task = (await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first()) as any;
    expect(task.status).toBe("in_review");
    expect(task.assigned_to).toBe(agentId);

    const logs = await env.DB.prepare("SELECT action FROM task_actions WHERE task_id = ? ORDER BY created_at").bind(taskId).all();
    const actions = logs.results.map((r: any) => r.action);
    expect(actions).toContain("created");
    expect(actions).toContain("assigned");
    expect(actions).toContain("claimed");
    expect(actions).toContain("commented");
    expect(actions).toContain("review_requested");
  });
});
