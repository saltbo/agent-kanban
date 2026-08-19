// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT } from "jose";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestAgent } from "./helpers/db";

// Integration test: validates CLI AgentClient JWT passthrough with new session model
// User creates agent → machine creates session → AgentClient uses session JWT

const MIGRATIONS_DIR = join(__dirname, "../apps/web/migrations");
const AUTH_SECRET = "test-secret-32-chars-minimum-ok!!";
const BETTER_AUTH_URL = "http://localhost:8788";

const testEnv = {
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

async function seedUser(db: D1Database, userId = "test-user-cli-jwt"): Promise<string> {
  const now = new Date().toISOString();
  await db
    .prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)")
    .bind(userId, "CLI JWT Test", `${userId}@example.com`, now, now)
    .run();
  return userId;
}

async function createApiKeyForUser(db: D1Database, userId: string): Promise<string> {
  const { createAuth } = await import("../apps/web/server/betterAuth");
  const auth = createAuth({ ...testEnv, DB: db });
  const result = await auth.api.createApiKey({ body: { userId } });
  return result.key;
}

async function honoRequest(method: string, path: string, body?: any, token?: string) {
  const { api } = await import("../apps/web/server/routes");
  const headers: Record<string, string> = { "Content-Type": "application/json", Host: "localhost:8788", "x-forwarded-proto": "http" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body) init.body = JSON.stringify(body);
  return api.request(path, init, testEnv);
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "test-db" },
  });
  const db = await mf.getD1Database("DB");
  testEnv.DB = db;
  await applyMigrations(db);
});

afterAll(async () => {
  await mf.dispose();
});

describe("CLI ApiClient agent JWT passthrough", () => {
  let userId: string;
  let apiKey: string;
  let _machineId: string;
  let agentId: string;
  let sessionId: string;
  let boardId: string;
  let taskId: string;
  let sessionPrivKeyJwk: JsonWebKey;
  let leaderAgentId: string;
  let leaderSessionId: string;

  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(vars: Record<string, string>) {
    for (const [k, v] of Object.entries(vars)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it("sets up machine + agent + session + board + task", async () => {
    userId = await seedUser(testEnv.DB);
    apiKey = await createApiKeyForUser(testEnv.DB, userId);

    // Create machine
    const machineRes = await honoRequest(
      "POST",
      "/api/machines",
      {
        name: "jwt-test-machine",
        os: "test",
        version: "1.0.0",
        runtimes: [{ name: "claude", status: "ready", checked_at: "2026-03-21T10:00:00Z" }],
        device_id: "test-device-cli-jwt",
      },
      apiKey,
    );
    expect(machineRes.status).toBe(201);
    _machineId = ((await machineRes.json()) as any).id;
    const heartbeatRes = await honoRequest("POST", `/api/machines/${_machineId}/heartbeat`, {}, apiKey);
    expect(heartbeatRes.status).toBe(200);

    // Create persistent agent (user-only, use repo directly)
    const agent = await createTestAgent(testEnv.DB, userId, { name: "JWT Test Agent", username: "jwt-test-agent", runtime: "claude" });
    agentId = agent.id;

    // Create session keypair (CSR — daemon generates locally)
    sessionId = randomUUID();
    const keypair = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"]);
    const pubJwk = await crypto.subtle.exportKey("jwk", (keypair as any).publicKey);
    sessionPrivKeyJwk = await crypto.subtle.exportKey("jwk", (keypair as any).privateKey);

    // Register session via API
    const sessionRes = await honoRequest(
      "POST",
      `/api/agents/${agentId}/sessions`,
      {
        session_id: sessionId,
        session_public_key: pubJwk.x!,
      },
      apiKey,
    );
    expect(sessionRes.status).toBe(201);

    // Create leader agent + session for assign
    const leaderAgent = await createTestAgent(testEnv.DB, userId, {
      name: "JWT Leader Agent",
      username: "jwt-leader-agent",
      runtime: "claude",
      kind: "leader",
    });
    leaderAgentId = leaderAgent.id;
    leaderSessionId = randomUUID();
    const leaderKeypair = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"]);
    const leaderPubJwk = await crypto.subtle.exportKey("jwk", (leaderKeypair as any).publicKey);
    const leaderSessionRes = await honoRequest(
      "POST",
      `/api/agents/${leaderAgentId}/sessions`,
      { session_id: leaderSessionId, session_public_key: leaderPubJwk.x! },
      apiKey,
    );
    expect(leaderSessionRes.status).toBe(201);

    // Create board + task
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask, assignTask } = await import("../apps/web/server/taskRepo");
    const board = await createBoard(testEnv.DB, userId, "jwt-test-board", "ops");
    boardId = board.id;
    const task = await createTask(testEnv.DB, userId, { title: "JWT test task", board_id: boardId });
    taskId = task.id;

    // Assign task to the worker agent so the worker can claim it in subsequent tests
    await assignTask(testEnv.DB, taskId, agentId, "machine", "system", null, {
      metadata: { annotations: { "runtime.source": "legacy" } },
    });
  }, 10_000);

  it("ApiClient constructs valid session JWT that server accepts for claim", async () => {
    setEnv({
      AK_AGENT_ID: agentId,
      AK_SESSION_ID: sessionId,
      AK_AGENT_KEY: JSON.stringify(sessionPrivKeyJwk),
      AK_API_URL: BETTER_AUTH_URL,
    });

    let capturedToken: string | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const path = new URL(url).pathname;
      const headers = new Headers(init?.headers);
      capturedToken = headers.get("Authorization")?.replace("Bearer ", "") || null;
      return honoRequest(init?.method || "GET", path, init?.body ? JSON.parse(init.body as string) : undefined, capturedToken!);
    });

    const { createClient } = await import("../packages/cli/src/agent/leader.js");
    const client = await createClient();

    const claimed = (await client.claimTask(taskId)) as any;
    expect(claimed.status).toBe("in_progress");
    expect(claimed.assigned_to).toBe(agentId);
    expect(capturedToken!.split(".")).toHaveLength(3);
  });

  it("ApiClient constructs valid session JWT that server accepts for review", async () => {
    setEnv({
      AK_AGENT_ID: agentId,
      AK_SESSION_ID: sessionId,
      AK_AGENT_KEY: JSON.stringify(sessionPrivKeyJwk),
      AK_API_URL: BETTER_AUTH_URL,
    });

    let capturedToken: string | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const path = new URL(url).pathname;
      const headers = new Headers(init?.headers);
      capturedToken = headers.get("Authorization")?.replace("Bearer ", "") || null;
      return honoRequest(init?.method || "GET", path, init?.body ? JSON.parse(init.body as string) : undefined, capturedToken!);
    });

    const { createClient } = await import("../packages/cli/src/agent/leader.js");
    const client = await createClient();

    const reviewed = (await client.reviewTask(taskId, { pr_url: "https://github.com/test/pull/1" })) as any;
    expect(reviewed.status).toBe("in_review");
  });

  it("machine API key is correctly rejected for claim (agent-only endpoint)", async () => {
    const res = await honoRequest("POST", `/api/tasks/${taskId}/claim`, { agent_id: agentId }, apiKey);
    expect(res.status).toBe(403);
  });

  it("rejects an otherwise valid JWT for a closed runtime agent session", async () => {
    const runtimeUserId = await seedUser(testEnv.DB, `runtime-closed-${randomUUID()}`);
    const runtimeAgent = await createTestAgent(testEnv.DB, runtimeUserId, {
      name: "Closed Runtime Agent",
      username: `closed-runtime-${randomUUID().slice(0, 8)}`,
      runtime: "claude",
    });
    const runtimeSessionId = randomUUID();
    const runtimeKeypair = (await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"])) as CryptoKeyPair;
    const runtimePubJwk = await crypto.subtle.exportKey("jwk", runtimeKeypair.publicKey);
    const { createAmaAgentSession, closeSession } = await import("../apps/web/server/agentSessionRepo");
    await createAmaAgentSession(testEnv.DB, testEnv, {
      ownerId: runtimeUserId,
      agentId: runtimeAgent.id,
      sessionId: runtimeSessionId,
      sessionPublicKey: runtimePubJwk.x!,
      amaSessionId: "ama-session-closed",
    });

    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { assignTask, createTask } = await import("../apps/web/server/taskRepo");
    const board = await createBoard(testEnv.DB, runtimeUserId, `closed-runtime-board-${randomUUID().slice(0, 8)}`, "ops");
    const task = await createTask(testEnv.DB, runtimeUserId, { title: "Closed runtime JWT task", board_id: board.id });
    await assignTask(testEnv.DB, task.id, runtimeAgent.id, "machine", "system", null, { skipRuntimeAvailability: true });
    await closeSession(testEnv.DB, runtimeSessionId);

    const jwt = await new SignJWT({ sub: runtimeSessionId, aid: runtimeAgent.id, jti: randomUUID(), aud: BETTER_AUTH_URL })
      .setProtectedHeader({ alg: "EdDSA", typ: "agent+jwt" })
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(runtimeKeypair.privateKey);

    const res = await honoRequest("POST", `/api/tasks/${task.id}/claim`, { agent_id: runtimeAgent.id }, jwt);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN", message: "Agent session is not registered" },
    });

    const runtimeSession = await testEnv.DB.prepare("SELECT status FROM ama_agent_sessions WHERE id = ?").bind(runtimeSessionId).first<any>();
    expect(runtimeSession?.status).toBe("closed");
    const legacySession = await testEnv.DB.prepare("SELECT id FROM agent_sessions WHERE id = ?").bind(runtimeSessionId).first<any>();
    expect(legacySession).toBeNull();
  });
});
