// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT } from "jose";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations as applyAllMigrations, createTestAgent, seedUser as seedRealmrootUser } from "./helpers/db";

// Integration tests for Agent Entity Redesign:
// - Agent CRUD (update, delete)
// - Session lifecycle (close, multi-session)
// - Agent task status count computation
// - Message sender model (sender_type + sender_id)
// - User assigns task to agent
// - Delegation proof tamper detection

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
    "0023_ama_session_secret_credential.sql",
    "0025_machine_hosting.sql",
    "0026_agent_ama_agent_id.sql",
    "0028_board_maintainer_triggers_memory.sql",
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
    "0033_board_maintainer_heartbeat_enabled.sql",
    "0034_task_assignee_status_index.sql",
    "0035_board_maintainer_vault.sql",
    "0036_backfill_ama_session_secret_refs.sql",
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

async function seedUser(db: D1Database, id: string, email: string): Promise<string> {
  await seedRealmrootUser(db, id, email);
  return id;
}

async function createSessionKeypair() {
  const keypair = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"]);
  const pubJwk = await crypto.subtle.exportKey("jwk", (keypair as any).publicKey);
  return { publicKey: pubJwk.x!, privateKey: (keypair as any).privateKey };
}

async function _signJWT(sessionId: string, agentId: string, privateKey: CryptoKey): Promise<string> {
  return new SignJWT({ sub: sessionId, aid: agentId, jti: randomUUID(), aud: BETTER_AUTH_URL })
    .setProtectedHeader({ alg: "EdDSA", typ: "agent+jwt" })
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(privateKey);
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "test-db" },
  });
  env.DB = await mf.getD1Database("DB");
  await applyAllMigrations(env.DB);
});

afterAll(async () => {
  await mf.dispose();
});

describe("agent CRUD", () => {
  let userId: string;
  let agentId: string;

  it("setup user", async () => {
    userId = await seedUser(env.DB, "user-crud", "crud@test.com");
    const agent = await createTestAgent(env.DB, userId, {
      name: "CrudAgent",
      username: "crud-agent",
      bio: "test bio",
      soul: "be helpful",
      runtime: "claude",
      model: "opus",
    });
    agentId = agent.id;
    expect(agent.name).toBe("CrudAgent");
    expect(agent.bio).toBe("test bio");
    expect(agent.version).toBe("latest");
  });

  it("updates agent fields", async () => {
    const { updateAgent, getAgent } = await import("../apps/web/server/agentRepo");
    await updateAgent(env.DB, agentId, { name: "UpdatedAgent", bio: "new bio", soul: "be precise" });
    const agent = await getAgent(env.DB, agentId, userId);
    expect(agent!.name).toBe("UpdatedAgent");
    expect(agent!.bio).toBe("new bio");
    expect(agent!.soul).toBe("be precise");
  });

  it("deletes agent", async () => {
    const { deleteAgent } = await import("../apps/web/server/agentRepo");
    const temp = await createTestAgent(env.DB, userId, { name: "ToDelete", username: "to-delete", runtime: "claude" });
    const deleted = await deleteAgent(env.DB, temp.id);
    expect(deleted).toBe(true);
    const row = await env.DB.prepare("SELECT id FROM agents WHERE id = ?").bind(temp.id).first();
    expect(row).toBeNull();
  });

  it("list agents returns computed status and usage", async () => {
    const { listAgents } = await import("../apps/web/server/agentRepo");
    const agents = await listAgents(env.DB, userId);
    const agent = agents.find((a) => a.id === agentId);
    expect(agent).toBeTruthy();
    expect(agent!.status).toEqual({
      schedulable: false,
      tasks: {
        todo: 0,
        in_progress: 0,
        in_review: 0,
        done: 0,
        cancelled: 0,
      },
    });
    expect(agent!.input_tokens).toBe(0);
  });
});

describe("agent task status count computation", () => {
  let userId: string;
  let agentId: string;
  let machineId: string;

  it("setup", async () => {
    const { upsertMachine } = await import("../apps/web/server/machineRepo");
    userId = await seedUser(env.DB, "user-status", "status@test.com");
    const machine = await upsertMachine(env.DB, userId, {
      name: "status-machine",
      os: "test",
      version: "1.0",
      runtimes: [],
      device_id: "test-device-redesign-status",
    });
    machineId = machine.id;

    const agent = await createTestAgent(env.DB, userId, { name: "StatusAgent", username: "status-agent", runtime: "claude" });
    agentId = agent.id;
  });

  it("reports zero task counts with no assigned tasks", async () => {
    const { getAgent } = await import("../apps/web/server/agentRepo");
    const agent = await getAgent(env.DB, agentId, userId);
    expect(agent!.status.tasks).toEqual({
      todo: 0,
      in_progress: 0,
      in_review: 0,
      done: 0,
      cancelled: 0,
    });
  });

  it("counts assigned tasks by status", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const board = await createBoard(env.DB, userId, "Status board", "ops");
    const statuses = ["todo", "in_progress", "in_review", "done", "cancelled"] as const;
    for (const status of statuses) {
      const task = await createTask(env.DB, userId, {
        board_id: board.id,
        title: `${status} task`,
        assigned_to: agentId,
        skipRuntimeAvailability: true,
      });
      await env.DB.prepare("UPDATE tasks SET status = ? WHERE id = ?").bind(status, task.id).run();
    }

    const { getAgent } = await import("../apps/web/server/agentRepo");
    const agent = await getAgent(env.DB, agentId, userId);
    expect(agent!.status.tasks).toEqual({
      todo: 1,
      in_progress: 1,
      in_review: 1,
      done: 1,
      cancelled: 1,
    });
  });

  it("does not change task counts when sessions are created", async () => {
    const { createSession } = await import("../apps/web/server/agentSessionRepo");
    const { publicKey } = await createSessionKeypair();
    await createSession(env.DB, env, agentId, machineId, randomUUID(), publicKey, userId);

    const { getAgent } = await import("../apps/web/server/agentRepo");
    const agent = await getAgent(env.DB, agentId, userId);
    expect(agent!.status.tasks).toEqual({
      todo: 1,
      in_progress: 1,
      in_review: 1,
      done: 1,
      cancelled: 1,
    });
  });
});

describe("session lifecycle", () => {
  let userId: string;
  let agentId: string;
  let machineId: string;
  let sessionId: string;

  it("setup", async () => {
    const { upsertMachine } = await import("../apps/web/server/machineRepo");
    userId = await seedUser(env.DB, "user-session", "session@test.com");
    const machine = await upsertMachine(env.DB, userId, {
      name: "session-machine",
      os: "test",
      version: "1.0",
      runtimes: [],
      device_id: "test-device-redesign-session",
    });
    machineId = machine.id;

    const agent = await createTestAgent(env.DB, userId, { name: "SessionAgent", username: "session-agent", runtime: "claude" });
    agentId = agent.id;
  });

  it("creates a session without a Better Auth agentHost record", async () => {
    const { upsertMachine } = await import("../apps/web/server/machineRepo");
    const freshMachine = await upsertMachine(env.DB, userId, {
      name: "fresh-machine-no-host",
      os: "test",
      version: "1.0",
      runtimes: [],
      device_id: "test-device-no-host",
    });
    const freshAgent = await createTestAgent(env.DB, userId, {
      name: "FreshAgent",
      username: "fresh-agent-no-host",
      runtime: "claude",
    });
    const { createSession, getSession } = await import("../apps/web/server/agentSessionRepo");
    const { publicKey } = await createSessionKeypair();
    const freshSessionId = randomUUID();
    await createSession(env.DB, env, freshAgent.id, freshMachine.id, freshSessionId, publicKey, userId);
    const session = await getSession(env.DB, freshSessionId);
    expect(session!.status).toBe("active");
  });

  it("close session sets status and closed_at", async () => {
    const { createSession, closeSession, getSession } = await import("../apps/web/server/agentSessionRepo");
    const { publicKey } = await createSessionKeypair();
    sessionId = randomUUID();
    await createSession(env.DB, env, agentId, machineId, sessionId, publicKey, userId);

    await closeSession(env.DB, sessionId);
    const session = await getSession(env.DB, sessionId);
    expect(session!.status).toBe("closed");
    expect(session!.closed_at).toBeTruthy();
  });

  it("list sessions shows full history", async () => {
    const { createSession, listSessions } = await import("../apps/web/server/agentSessionRepo");
    const { publicKey } = await createSessionKeypair();
    await createSession(env.DB, env, agentId, machineId, randomUUID(), publicKey, userId);

    const sessions = await listSessions(env.DB, agentId);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.some((s) => s.status === "closed")).toBe(true);
    expect(sessions.some((s) => s.status === "active")).toBe(true);
    expect(sessions[0].machine_name).toBe("session-machine");
  });

  it("session usage accumulates", async () => {
    const { updateSessionUsage } = await import("../apps/web/server/agentSessionRepo");
    const active = await env.DB.prepare("SELECT id FROM agent_sessions WHERE agent_id = ? AND status = 'active'")
      .bind(agentId)
      .first<{ id: string }>();

    await updateSessionUsage(env.DB, active!.id, {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      cache_creation_tokens: 5,
      cost_micro_usd: 500,
    });
    await updateSessionUsage(env.DB, active!.id, {
      input_tokens: 200,
      output_tokens: 100,
      cache_read_tokens: 20,
      cache_creation_tokens: 10,
      cost_micro_usd: 1000,
    });

    const session = await env.DB.prepare("SELECT * FROM agent_sessions WHERE id = ?").bind(active!.id).first<any>();
    expect(session.input_tokens).toBe(300);
    expect(session.output_tokens).toBe(150);
    expect(session.cost_micro_usd).toBe(1500);
  });

  it("agent usage is aggregated from sessions", async () => {
    const { getAgent } = await import("../apps/web/server/agentRepo");
    const agent = await getAgent(env.DB, agentId, userId);
    expect(agent!.input_tokens).toBeGreaterThanOrEqual(300);
    expect(agent!.cost_micro_usd).toBeGreaterThanOrEqual(1500);
  });
});

describe("message sender model", () => {
  let userId: string;
  let agentId: string;
  let taskId: string;

  it("setup board + task", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    userId = await seedUser(env.DB, "user-msg", "msg@test.com");
    const agent = await createTestAgent(env.DB, userId, { name: "MsgAgent", username: "msg-agent", runtime: "claude" });
    agentId = agent.id;
    const board = await createBoard(env.DB, userId, "msg-board", "ops");
    const task = await createTask(env.DB, userId, { title: "Msg task", board_id: board.id });
    taskId = task.id;
  });

  it("creates user message with sender_type=user", async () => {
    const { createMessage } = await import("../apps/web/server/messageRepo");
    const msg = await createMessage(env.DB, taskId, "user", userId, "Hello agent");
    expect(msg.sender_type).toBe("user");
    expect(msg.sender_id).toBe(userId);
    expect(msg.content).toBe("Hello agent");
  });

  it("creates agent message with sender_type=agent", async () => {
    const { createMessage } = await import("../apps/web/server/messageRepo");
    const msg = await createMessage(env.DB, taskId, "agent", agentId, "Working on it");
    expect(msg.sender_type).toBe("agent");
    expect(msg.sender_id).toBe(agentId);
  });

  it("list messages returns sender fields", async () => {
    const { listMessages } = await import("../apps/web/server/messageRepo");
    const msgs = await listMessages(env.DB, taskId);
    expect(msgs.length).toBe(2);
    expect(msgs[0].sender_type).toBe("user");
    expect(msgs[1].sender_type).toBe("agent");
    // old fields should not exist
    expect((msgs[0] as any).role).toBeUndefined();
    expect((msgs[0] as any).agent_id).toBeUndefined();
  });
});

describe("delegation proof security", () => {
  it("tampered proof is rejected", async () => {
    const { generateKeypair, signDelegation, verifyDelegation } = await import("@agent-kanban/shared");

    const agent = await generateKeypair();
    const session = await generateKeypair();
    const proof = await signDelegation(agent.privateKeyJwk, session.publicKeyBase64);

    // Tamper with the proof
    const tampered = `${proof.slice(0, -2)}XX`;
    const valid = await verifyDelegation(agent.publicKeyBase64, session.publicKeyBase64, tampered);
    expect(valid).toBe(false);
  });

  it("wrong agent key rejects proof", async () => {
    const { generateKeypair, signDelegation, verifyDelegation } = await import("@agent-kanban/shared");

    const agent1 = await generateKeypair();
    const agent2 = await generateKeypair();
    const session = await generateKeypair();
    const proof = await signDelegation(agent1.privateKeyJwk, session.publicKeyBase64);

    // Verify with wrong agent public key
    const valid = await verifyDelegation(agent2.publicKeyBase64, session.publicKeyBase64, proof);
    expect(valid).toBe(false);
  });

  it("wrong session key rejects proof", async () => {
    const { generateKeypair, signDelegation, verifyDelegation } = await import("@agent-kanban/shared");

    const agent = await generateKeypair();
    const session1 = await generateKeypair();
    const session2 = await generateKeypair();
    const proof = await signDelegation(agent.privateKeyJwk, session1.publicKeyBase64);

    // Verify with wrong session public key
    const valid = await verifyDelegation(agent.publicKeyBase64, session2.publicKeyBase64, proof);
    expect(valid).toBe(false);
  });
});

describe("user assigns task to agent", () => {
  let userId: string;
  let agentId: string;
  let taskId: string;

  it("setup", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const { updateMachine, upsertMachine } = await import("../apps/web/server/machineRepo");
    userId = await seedUser(env.DB, "user-assign", "assign@test.com");
    const machine = await upsertMachine(env.DB, userId, {
      name: "assign-runtime-machine",
      os: "test",
      version: "1.0",
      runtimes: [{ name: "claude", status: "ready", checked_at: "2026-03-21T10:00:00Z" }],
      device_id: "test-device-redesign-assign-runtime",
    });
    await updateMachine(env.DB, machine.id, userId, {});
    const agent = await createTestAgent(env.DB, userId, { name: "AssignAgent", username: "assign-agent", runtime: "claude" });
    agentId = agent.id;
    const board = await createBoard(env.DB, userId, "assign-board", "ops");
    const task = await createTask(env.DB, userId, { title: "Assign task", board_id: board.id });
    taskId = task.id;
  });

  it("assigns task via repo function", async () => {
    const { assignTask } = await import("../apps/web/server/taskRepo");
    const task = await assignTask(env.DB, taskId, agentId, "machine", "system");
    expect(task!.assigned_to).toBe(agentId);
    expect(task).not.toHaveProperty("board_owner_id");
    expect(task!.status).toBe("todo"); // assign doesn't change status
  });

  it("task logs record assignment with persistent agent ID", async () => {
    const logs = await env.DB.prepare("SELECT * FROM task_actions WHERE task_id = ? AND action = 'assigned'").bind(taskId).all();
    expect(logs.results.length).toBe(1);
    expect((logs.results[0] as any).actor_id).toBe("system");
  });

  it("release resets status from in_progress to todo", async () => {
    const { claimTask, releaseTask } = await import("../apps/web/server/taskRepo");
    await claimTask(env.DB, taskId, agentId, "agent:worker");
    const task = await releaseTask(env.DB, taskId, "machine", "system", "machine");
    expect(task!.status).toBe("todo");
  });
});
