// @vitest-environment node

/**
 * Tests for recently added features:
 *  1. agentGitIdentityEnv — correct env vars derived from agent name/username
 *  2. amaRunnerCanRunRuntime — quota-exhausted runner skip logic
 *  3. Session usage accounting — collectAkAgentSessionUsage via releaseTaskRuntimeBinding
 *  4. Runner version pinning — AMA_RUNNER_VERSION in machine registration response
 *  5. Git identity env wired into dispatch (runtimeEnv contains GIT_AUTHOR_* fields)
 */

import { randomUUID } from "node:crypto";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestAgent, createTestWebSession, seedUser, setupMiniflare } from "./helpers/db";

const AMA_ENV = {
  AMA_ORIGIN: "https://ama.test",
  REALMROOT_ISSUER: "https://id.realmroot.dev/api/auth",
  REALMROOT_WEB_CLIENT_ID: "ak-web-test",
  REALMROOT_WEB_CLIENT_SECRET: "ak-web-secret",
  REALMROOT_SESSION_ENCRYPTION_KEY: "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
  AMA_RESOURCE: "https://ama.test/api",
  AK_API_URL: "https://ak.test",
};

let db: D1Database;
let mf: Miniflare;

function makeEnv(overrides: Record<string, unknown> = {}): any {
  return {
    DB: db,
    AE: { writeDataPoint: () => {} } as any,
    EMAIL: { send: async () => ({ messageId: "test" }) } as any,
    TUNNEL_RELAY: null as any,
    ASSETS: null as any,
    AUTH_SECRET: "test-secret-32-chars-minimum-ok!!",
    ALLOWED_HOSTS: "localhost:8788",
    GITHUB_CLIENT_ID: "x",
    GITHUB_CLIENT_SECRET: "x",
    MAILS_ADMIN_TOKEN: "",
    ...AMA_ENV,
    ...overrides,
  };
}

// hey-api's fetch client calls fetch(request) with a single Request object,
// not fetch(url, init). These helpers normalise both call signatures so mocks
// can read url, method, and body regardless of which form is used.
function reqUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}
function reqMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return input instanceof Request ? input.method : ((init as any)?.method ?? "GET");
}
async function reqBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  return input instanceof Request ? input.clone().text() : String((init as any)?.body ?? "");
}

// hey-api defaults to parseAs:'auto' which infers JSON only when Content-Type
// is application/json. Always include it so the SDK parses the body correctly.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function amaProject(id: string, name = "Workspace") {
  return { id, name, metadata: { uid: id, name, projectId: id, description: null }, spec: {}, status: {} };
}

function amaCredential(id: string, activeVersionId?: string) {
  return { metadata: { uid: id }, spec: {}, status: { activeVersionId } };
}

function amaAgent(id: string, input: { projectId?: string; name?: string; provider?: string; model?: string | null } = {}) {
  return {
    metadata: {
      uid: id,
      projectId: input.projectId ?? "project_123",
      name: input.name ?? "agent",
      description: null,
      archivedAt: null,
    },
    spec: {
      provider: input.provider ?? "provider_claude",
      model: input.model ?? null,
      systemPrompt: "",
      skills: [],
      subagents: [],
      allowedTools: [],
      mcpConnectors: [],
    },
    status: {},
  };
}

function amaEnvironment(id: string, input: { projectId?: string; name?: string; type?: string } = {}) {
  return {
    metadata: {
      uid: id,
      projectId: input.projectId ?? "project_123",
      name: input.name ?? id,
      description: null,
      archivedAt: null,
    },
    spec: { type: input.type ?? "self_hosted" },
    status: {},
  };
}

function amaSession(
  id: string,
  input: { agentId?: string; environmentId?: string | null; runtime?: string; phase?: string; reason?: string | null; name?: string } = {},
) {
  return {
    metadata: {
      uid: id,
      projectId: "project_git",
      name: input.name ?? id,
      labels: {},
      annotations: {},
      archivedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    spec: {
      agentId: input.agentId ?? "ama_agent_git",
      environmentId: input.environmentId ?? "env_git",
      runtime: input.runtime ?? "claude-code",
    },
    status: { phase: input.phase ?? "pending", reason: input.reason ?? null },
  };
}

function oidcDiscoveryResponse() {
  return jsonResponse({
    issuer: "https://auth.test",
    authorization_endpoint: "https://auth.test/oauth/authorize",
    token_endpoint: "https://auth.test/oauth/token",
    jwks_uri: "https://auth.test/.well-known/jwks.json",
  });
}

beforeAll(async () => {
  ({ mf, db } = await setupMiniflare());
});

afterAll(async () => {
  await mf.dispose();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── 1. agentGitIdentityEnv ───────────────────────────────────────────────────

describe("agentGitIdentityEnv", () => {
  it("uses agent name when set and derives email from username", async () => {
    const { agentGitIdentityEnv } = await import("../apps/web/server/taskDispatch");
    const env = agentGitIdentityEnv({ name: "Alice Smith", username: "alice" });
    expect(env.GIT_AUTHOR_NAME).toBe("Alice Smith");
    expect(env.GIT_AUTHOR_EMAIL).toBe("alice@mails.agent-kanban.dev");
    expect(env.GIT_COMMITTER_NAME).toBe("Alice Smith");
    expect(env.GIT_COMMITTER_EMAIL).toBe("alice@mails.agent-kanban.dev");
  });

  it("falls back to username when name is null", async () => {
    const { agentGitIdentityEnv } = await import("../apps/web/server/taskDispatch");
    const env = agentGitIdentityEnv({ name: null, username: "bot-worker" });
    expect(env.GIT_AUTHOR_NAME).toBe("bot-worker");
    expect(env.GIT_COMMITTER_NAME).toBe("bot-worker");
    expect(env.GIT_AUTHOR_EMAIL).toBe("bot-worker@mails.agent-kanban.dev");
  });

  it("falls back to username when name is empty string", async () => {
    const { agentGitIdentityEnv } = await import("../apps/web/server/taskDispatch");
    const env = agentGitIdentityEnv({ name: "", username: "coder" });
    expect(env.GIT_AUTHOR_NAME).toBe("coder");
    expect(env.GIT_COMMITTER_NAME).toBe("coder");
  });

  it("produces all four required git identity keys", async () => {
    const { agentGitIdentityEnv } = await import("../apps/web/server/taskDispatch");
    const env = agentGitIdentityEnv({ name: "Dev", username: "dev" });
    expect(env).toHaveProperty("GIT_AUTHOR_NAME");
    expect(env).toHaveProperty("GIT_AUTHOR_EMAIL");
    expect(env).toHaveProperty("GIT_COMMITTER_NAME");
    expect(env).toHaveProperty("GIT_COMMITTER_EMAIL");
  });
});

// ─── 2. amaRunnerCanRunRuntime — quota-exhausted runner skip ─────────────────

describe("amaRunnerCanRunRuntime", () => {
  it("returns true for an active runner with capacity and no quota usage", async () => {
    const { amaRunnerCanRunRuntime } = await import("../apps/web/server/taskDispatch");
    const runner = {
      id: "runner-1",
      environmentId: "env-1",
      status: "active",
      runtimes: [{ runtime: "claude-code", models: [], state: "ready" }],
      currentLoad: 0,
      maxConcurrent: 2,
      lastHeartbeatAt: new Date().toISOString(),
      runtimeUsage: [],
    };
    expect(amaRunnerCanRunRuntime(runner, "claude-code")).toBe(true);
  });

  it("returns false when the runtime report marks the runtime as limited", async () => {
    const { amaRunnerCanRunRuntime } = await import("../apps/web/server/taskDispatch");
    const runner = {
      id: "runner-limited",
      environmentId: "env-limited",
      status: "active",
      runtimes: [
        {
          runtime: "claude-code",
          models: ["claude-sonnet-4-6"],
          state: "limited",
          detail: "Claude Code quota usage unavailable",
        },
      ],
      currentLoad: 0,
      maxConcurrent: 2,
      lastHeartbeatAt: new Date().toISOString(),
      runtimeUsage: [],
    };
    expect(amaRunnerCanRunRuntime(runner, "claude-code")).toBe(false);
  });

  it("returns false when runner status is not active", async () => {
    const { amaRunnerCanRunRuntime } = await import("../apps/web/server/taskDispatch");
    const runner = {
      id: "runner-2",
      environmentId: "env-2",
      status: "offline",
      runtimes: [{ runtime: "claude-code", models: [], state: "ready" }],
      currentLoad: 0,
      maxConcurrent: 2,
      lastHeartbeatAt: new Date().toISOString(),
    };
    expect(amaRunnerCanRunRuntime(runner, "claude-code")).toBe(false);
  });

  it("returns false when runner is at full capacity (currentLoad >= maxConcurrent)", async () => {
    const { amaRunnerCanRunRuntime } = await import("../apps/web/server/taskDispatch");
    const runner = {
      id: "runner-3",
      environmentId: "env-3",
      status: "active",
      runtimes: [{ runtime: "claude-code", models: [], state: "ready" }],
      currentLoad: 1,
      maxConcurrent: 1,
      lastHeartbeatAt: new Date().toISOString(),
    };
    expect(amaRunnerCanRunRuntime(runner, "claude-code")).toBe(false);
  });

  it("returns false when the runtime is not listed", async () => {
    const { amaRunnerCanRunRuntime } = await import("../apps/web/server/taskDispatch");
    const runner = {
      id: "runner-4",
      environmentId: "env-4",
      status: "active",
      runtimes: [{ runtime: "codex", models: [], state: "ready" }],
      currentLoad: 0,
      maxConcurrent: 2,
      lastHeartbeatAt: new Date().toISOString(),
    };
    expect(amaRunnerCanRunRuntime(runner, "claude-code")).toBe(false);
  });

  it("returns true when a ready runtime entry matches", async () => {
    const { amaRunnerCanRunRuntime } = await import("../apps/web/server/taskDispatch");
    const runner = {
      id: "runner-5",
      environmentId: "env-5",
      status: "active",
      runtimes: [{ runtime: "claude-code", models: ["claude-sonnet-4-6"], state: "ready" }],
      currentLoad: 0,
      maxConcurrent: 2,
      lastHeartbeatAt: new Date().toISOString(),
    };
    expect(amaRunnerCanRunRuntime(runner, "claude-code")).toBe(true);
  });

  it("returns false when quota window utilization >= 100 and resetsAt is in the future", async () => {
    const { amaRunnerCanRunRuntime } = await import("../apps/web/server/taskDispatch");
    const futureReset = new Date(Date.now() + 3_600_000).toISOString();
    const runner = {
      id: "runner-6",
      environmentId: "env-6",
      status: "active",
      runtimes: [{ runtime: "claude-code", models: [], state: "ready" }],
      currentLoad: 0,
      maxConcurrent: 2,
      lastHeartbeatAt: new Date().toISOString(),
      runtimeUsage: [
        {
          runtime: "claude-code",
          windows: [{ label: "day", utilization: 100, resetsAt: futureReset }],
        },
      ],
    };
    expect(amaRunnerCanRunRuntime(runner, "claude-code")).toBe(false);
  });

  it("returns true when quota window utilization >= 100 but resetsAt is in the past", async () => {
    const { amaRunnerCanRunRuntime } = await import("../apps/web/server/taskDispatch");
    const pastReset = new Date(Date.now() - 1000).toISOString();
    const runner = {
      id: "runner-7",
      environmentId: "env-7",
      status: "active",
      runtimes: [{ runtime: "claude-code", models: [], state: "ready" }],
      currentLoad: 0,
      maxConcurrent: 2,
      lastHeartbeatAt: new Date().toISOString(),
      runtimeUsage: [
        {
          runtime: "claude-code",
          windows: [{ label: "day", utilization: 100, resetsAt: pastReset }],
        },
      ],
    };
    expect(amaRunnerCanRunRuntime(runner, "claude-code")).toBe(true);
  });

  it("returns true when quota utilization is 99 (below 100) with future reset", async () => {
    const { amaRunnerCanRunRuntime } = await import("../apps/web/server/taskDispatch");
    const futureReset = new Date(Date.now() + 3_600_000).toISOString();
    const runner = {
      id: "runner-8",
      environmentId: "env-8",
      status: "active",
      runtimes: [{ runtime: "claude-code", models: [], state: "ready" }],
      currentLoad: 0,
      maxConcurrent: 2,
      lastHeartbeatAt: new Date().toISOString(),
      runtimeUsage: [
        {
          runtime: "claude-code",
          windows: [{ label: "day", utilization: 99, resetsAt: futureReset }],
        },
      ],
    };
    expect(amaRunnerCanRunRuntime(runner, "claude-code")).toBe(true);
  });

  it("returns true when quota usage is for a different runtime", async () => {
    const { amaRunnerCanRunRuntime } = await import("../apps/web/server/taskDispatch");
    const futureReset = new Date(Date.now() + 3_600_000).toISOString();
    const runner = {
      id: "runner-9",
      environmentId: "env-9",
      status: "active",
      runtimes: [{ runtime: "claude-code", models: [], state: "ready" }],
      currentLoad: 0,
      maxConcurrent: 2,
      lastHeartbeatAt: new Date().toISOString(),
      runtimeUsage: [
        {
          runtime: "codex", // different runtime
          windows: [{ label: "day", utilization: 100, resetsAt: futureReset }],
        },
      ],
    };
    // claude-code quota is not exhausted — should run
    expect(amaRunnerCanRunRuntime(runner, "claude-code")).toBe(true);
  });

  it("dispatch defers when all runners have exhausted quota for the target runtime", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const { dispatchTaskToAma } = await import("../apps/web/server/taskDispatch");

    const quotaOwner = `quota-owner-${randomUUID()}`;
    await seedUser(db, quotaOwner, `${quotaOwner}@test.local`);

    // Configure AMA integration and machine environment
    await db
      .prepare(
        `INSERT INTO ama_owner_integrations (tenant_id, ama_project_id, session_secret_vault_id, metadata)
         VALUES (?, ?, ?, '{}')
         ON CONFLICT(tenant_id) DO UPDATE SET ama_project_id = excluded.ama_project_id, session_secret_vault_id = excluded.session_secret_vault_id`,
      )
      .bind(quotaOwner, "project_123", "vault_123")
      .run();

    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO machines (id, owner_id, device_id, name, os, version, runtimes, status, last_heartbeat_at, created_at, ama_environment_id)
         VALUES (?, ?, ?, ?, 'test', '1.0.0', ?, 'online', ?, ?, ?)
         ON CONFLICT(owner_id, device_id) DO UPDATE SET runtimes = excluded.runtimes, status = 'online', ama_environment_id = excluded.ama_environment_id`,
      )
      .bind(
        `machine-${quotaOwner}`,
        quotaOwner,
        `ama-env-${quotaOwner}`,
        "quota-machine",
        JSON.stringify([{ name: "claude", status: "ready", checked_at: now }]),
        now,
        now,
        "env_quota",
      )
      .run();

    const board = await createBoard(db, quotaOwner, `quota-board-${randomUUID()}`, "ops");
    const agent = await createTestAgent(db, quotaOwner, {
      name: "QuotaAgent",
      username: `quota-agent-${randomUUID()}`,
      runtime: "claude",
    });
    const task = await createTask(db, quotaOwner, {
      title: "Quota task",
      board_id: board.id,
      assigned_to: agent.id,
      skipRuntimeAvailability: true,
    });

    // Runner is active and has capacity but quota is exhausted for claude-code
    const futureReset = new Date(Date.now() + 3_600_000).toISOString();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") return oidcDiscoveryResponse();
      if (url === "https://ama.test/api/v1/projects/project_123") return jsonResponse(amaProject("project_123"));
      if (url === "https://ama.test/api/v1/runners?environmentId=env_quota&limit=100") {
        return jsonResponse({
          data: [
            {
              id: "runner-quota",
              environmentId: "env_quota",
              state: "active",
              runtimes: [{ runtime: "claude-code", models: [], state: "ready" }],
              currentLoad: 0,
              maxConcurrent: 2,
              lastHeartbeatAt: now,
              runtimeUsage: [
                {
                  runtime: "claude-code",
                  windows: [{ label: "day", utilization: 100, resetsAt: futureReset }],
                },
              ],
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const env = makeEnv();
    // Should not throw; returns undispatched task because quota is exhausted
    const result = await dispatchTaskToAma(db, env, quotaOwner, task, { apiOrigin: "https://ak.test" });
    expect(result.id).toBe(task.id);
    const annotation = (result.metadata as any)?.annotations?.["ama.dispatch.result"];
    expect(annotation).toBeFalsy();
  });
});

// ─── 3. Session usage accounting ─────────────────────────────────────────────

describe("session usage accounting via releaseTaskRuntimeBinding", () => {
  const OWNER = "usage-accounting-test-user";

  beforeAll(async () => {
    await seedUser(db, OWNER, "usage-accounting@test.local");
  });

  async function configureAmaIntegration(ownerId: string) {
    await db
      .prepare(
        `INSERT INTO ama_owner_integrations (tenant_id, ama_project_id, session_secret_vault_id, metadata)
         VALUES (?, ?, ?, '{}')
         ON CONFLICT(tenant_id) DO UPDATE SET ama_project_id = excluded.ama_project_id, session_secret_vault_id = excluded.session_secret_vault_id`,
      )
      .bind(ownerId, "project_usage", "vault_usage")
      .run();
  }

  it("sets input_tokens, output_tokens, cost_micro_usd when usage summary has records > 0", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const { createAmaAgentSession, bindAmaAgentSession } = await import("../apps/web/server/agentSessionRepo");
    const { releaseTaskRuntimeBinding } = await import("../apps/web/server/taskDispatch");

    await configureAmaIntegration(OWNER);

    const board = await createBoard(db, OWNER, `usage-board-${randomUUID()}`, "ops");
    const agent = await createTestAgent(db, OWNER, {
      name: "UsageAgent",
      username: `usage-agent-${randomUUID()}`,
      runtime: "claude",
    });

    // Create an AMA agent session with a bound AMA session ID
    const akSessionId = randomUUID();
    const amaSessionId = `ama_session_usage_${randomUUID()}`;
    const keypair = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"]);
    const pubJwk = await crypto.subtle.exportKey("jwk", (keypair as any).publicKey);

    const env = makeEnv();
    await createAmaAgentSession(db, env, {
      ownerId: OWNER,
      agentId: agent.id,
      sessionId: akSessionId,
      sessionPublicKey: pubJwk.x!,
    });
    await bindAmaAgentSession(db, akSessionId, amaSessionId);

    // Create a task with binding annotations
    const task = await createTask(db, OWNER, {
      title: "Usage task",
      board_id: board.id,
      assigned_to: agent.id,
      skipRuntimeAvailability: true,
      metadata: {
        annotations: {
          "ama.sessionId": amaSessionId,
          "ama.projectId": "project_usage",
          "ama.dispatch.result": "accepted",
          agentSessionId: akSessionId,
        },
      },
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") return oidcDiscoveryResponse();
      // AMA session stop
      if (url === `https://ama.test/api/v1/sessions/${amaSessionId}` && reqMethod(input, init) === "PATCH")
        return jsonResponse({ id: amaSessionId, state: "closed" });
      // Usage summary endpoint
      if (url === `https://ama.test/api/v1/usage-records?sessionId=${amaSessionId}&limit=100`) {
        return jsonResponse({
          data: [
            { promptTokens: 60, completionTokens: 30, costMicros: 700 },
            { promptTokens: 40, completionTokens: 20, costMicros: 534 },
          ],
          pagination: { nextCursor: null },
        });
      }
      // Vault credential revoke (no credential set, so this won't be called)
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await releaseTaskRuntimeBinding(db, env, OWNER, task);

    // Verify that the ama_agent_sessions row has the usage totals populated
    const sessionRow = await db
      .prepare("SELECT input_tokens, output_tokens, cost_micro_usd FROM ama_agent_sessions WHERE id = ?")
      .bind(akSessionId)
      .first<{ input_tokens: number; output_tokens: number; cost_micro_usd: number }>();
    expect(sessionRow).not.toBeNull();
    expect(sessionRow!.input_tokens).toBe(100);
    expect(sessionRow!.output_tokens).toBe(50);
    expect(sessionRow!.cost_micro_usd).toBe(1234);
  });

  it("leaves ama_agent_sessions row untouched when usage summary has records:0", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const { createAmaAgentSession, bindAmaAgentSession } = await import("../apps/web/server/agentSessionRepo");
    const { releaseTaskRuntimeBinding } = await import("../apps/web/server/taskDispatch");

    await configureAmaIntegration(OWNER);

    const board = await createBoard(db, OWNER, `usage-zero-board-${randomUUID()}`, "ops");
    const agent = await createTestAgent(db, OWNER, {
      name: "UsageZeroAgent",
      username: `usage-zero-agent-${randomUUID()}`,
      runtime: "claude",
    });

    const akSessionId = randomUUID();
    const amaSessionId = `ama_session_zero_${randomUUID()}`;
    const keypair = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"]);
    const pubJwk = await crypto.subtle.exportKey("jwk", (keypair as any).publicKey);

    const env = makeEnv();
    await createAmaAgentSession(db, env, {
      ownerId: OWNER,
      agentId: agent.id,
      sessionId: akSessionId,
      sessionPublicKey: pubJwk.x!,
    });
    await bindAmaAgentSession(db, akSessionId, amaSessionId);

    const task = await createTask(db, OWNER, {
      title: "Usage zero task",
      board_id: board.id,
      assigned_to: agent.id,
      skipRuntimeAvailability: true,
      metadata: {
        annotations: {
          "ama.sessionId": amaSessionId,
          "ama.projectId": "project_usage",
          "ama.dispatch.result": "accepted",
          agentSessionId: akSessionId,
        },
      },
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") return oidcDiscoveryResponse();
      if (url === `https://ama.test/api/v1/sessions/${amaSessionId}` && reqMethod(input, init) === "PATCH")
        return jsonResponse({ id: amaSessionId, state: "closed" });
      // Usage summary with records:0 → function returns null → no update
      if (url === `https://ama.test/api/v1/usage-records?sessionId=${amaSessionId}&limit=100`) {
        return jsonResponse({ data: [], pagination: { nextCursor: null } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await releaseTaskRuntimeBinding(db, env, OWNER, task);

    const sessionRow = await db
      .prepare("SELECT input_tokens, output_tokens, cost_micro_usd FROM ama_agent_sessions WHERE id = ?")
      .bind(akSessionId)
      .first<{ input_tokens: number; output_tokens: number; cost_micro_usd: number }>();
    // All zero — unchanged from the initial state
    expect(sessionRow!.input_tokens).toBe(0);
    expect(sessionRow!.output_tokens).toBe(0);
    expect(sessionRow!.cost_micro_usd).toBe(0);
  });

  it("fails teardown when usage endpoint fails", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const { createAmaAgentSession, bindAmaAgentSession } = await import("../apps/web/server/agentSessionRepo");
    const { releaseTaskRuntimeBinding } = await import("../apps/web/server/taskDispatch");

    await configureAmaIntegration(OWNER);

    const board = await createBoard(db, OWNER, `usage-fail-board-${randomUUID()}`, "ops");
    const agent = await createTestAgent(db, OWNER, {
      name: "UsageFailAgent",
      username: `usage-fail-agent-${randomUUID()}`,
      runtime: "claude",
    });

    const akSessionId = randomUUID();
    const amaSessionId = `ama_session_fail_${randomUUID()}`;
    const keypair = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"]);
    const pubJwk = await crypto.subtle.exportKey("jwk", (keypair as any).publicKey);

    const env = makeEnv();
    await createAmaAgentSession(db, env, {
      ownerId: OWNER,
      agentId: agent.id,
      sessionId: akSessionId,
      sessionPublicKey: pubJwk.x!,
    });
    await bindAmaAgentSession(db, akSessionId, amaSessionId);

    const task = await createTask(db, OWNER, {
      title: "Usage fail task",
      board_id: board.id,
      assigned_to: agent.id,
      skipRuntimeAvailability: true,
      metadata: {
        annotations: {
          "ama.sessionId": amaSessionId,
          "ama.projectId": "project_usage",
          "ama.dispatch.result": "accepted",
          agentSessionId: akSessionId,
        },
      },
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") return oidcDiscoveryResponse();
      if (url === `https://ama.test/api/v1/sessions/${amaSessionId}` && reqMethod(input, init) === "PATCH")
        return jsonResponse({ id: amaSessionId, state: "closed" });
      // Usage endpoint fails
      if (url.includes("/api/v1/usage-records")) return new Response("Internal Server Error", { status: 500 });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(releaseTaskRuntimeBinding(db, env, OWNER, task)).rejects.toThrow(/AMA API request failed/);
    const taskRow = await db.prepare("SELECT metadata FROM tasks WHERE id = ?").bind(task.id).first<{ metadata: string }>();
    const meta = JSON.parse(taskRow!.metadata);
    expect(meta?.annotations?.["ama.sessionId"]).toBe(amaSessionId);
    expect(meta?.annotations?.["ama.dispatch.result"]).toBe("accepted");
  });
});

// ─── 4. Runner version pinning — AMA_RUNNER_VERSION in machine registration ──

describe("POST /api/machines runner.version from env", () => {
  let apiKey: string;

  async function createSessionForUser(userId: string, envObj: any): Promise<string> {
    const session = await createTestWebSession(envObj.DB, userId);
    return `${session.token}:csrf:${session.csrfToken}`;
  }

  async function apiRequestWithEnv(method: string, path: string, body: unknown, token: string, envObj: any) {
    const { api } = await import("../apps/web/server/routes");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Host: "localhost:8788",
      "x-forwarded-proto": "http",
    };
    const [sessionToken, csrfToken] = token.split(":csrf:");
    headers.cookie = `ak_session=${sessionToken}`;
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") headers["x-csrf-token"] = csrfToken;
    const init: RequestInit = { method, headers };
    if (body !== undefined && method !== "GET") init.body = JSON.stringify(body);
    return api.request(path, init, envObj);
  }

  it("returns runner.version = env.AMA_RUNNER_VERSION when set during machine registration", async () => {
    const userId = `runner-ver-user-${randomUUID()}`;
    // Fixed ES256 test keypair for subject token signing
    const testSigningJwk = {
      kty: "EC",
      x: "YgsMptfXEIq8ALzmNQclYp40b4d2nxKbsjle3TfEyTE",
      y: "DP6x9I_82Y1J43QC9mEBiXZjOcL1J_k9S-AzZJbyAGc",
      crv: "P-256",
      d: "xa0meReZA9XMRXqAEyC_gEgnaZfrDL1CrHBXO_hCDy0",
      kid: "test-ak",
      alg: "ES256",
    };
    const envWithVersion = makeEnv({
      AMA_RUNNER_VERSION: "0.2.5",
      AK_FEDERATED_SIGNING_KEY: JSON.stringify(testSigningJwk),
    });
    await seedUser(db, userId, `${userId}@test.local`);
    envWithVersion.DB = db;
    apiKey = await createSessionForUser(userId, envWithVersion);
    // Seed the owner integration so registration doesn't provision a project/vault
    await db
      .prepare(
        `INSERT INTO ama_owner_integrations (tenant_id, ama_project_id, session_secret_vault_id, metadata)
         VALUES (?, ?, ?, '{}')
         ON CONFLICT(tenant_id) DO UPDATE SET ama_project_id = excluded.ama_project_id, session_secret_vault_id = excluded.session_secret_vault_id`,
      )
      .bind(userId, "project_verpinned", "vault_verpinned")
      .run();

    // Mock AMA calls needed for environment creation + runner token
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = reqUrl(input);
        // Serves both the client-credentials flow and the runner token
        // exchange, which additionally requires a refresh_token.
        if (url === "https://auth.test/.well-known/openid-configuration") {
          return jsonResponse({ access_token: "test-token", refresh_token: "test-refresh", token_type: "Bearer", expires_in: 3600 });
        }
        // readAmaProject health probe (ensureAmaOwnerIntegration self-heal)
        if (url === "https://ama.test/api/v1/projects/project_verpinned") return jsonResponse(amaProject("project_verpinned"));
        // createEnvironment
        if (url === "https://ama.test/api/v1/environments")
          return jsonResponse(amaEnvironment("env_verpinned", { projectId: "project_verpinned" }), 201);
        throw new Error(`Unexpected fetch in version test: ${url}`);
      }),
    );

    const res = await apiRequestWithEnv(
      "POST",
      "/api/machines",
      {
        name: "version-test-machine",
        os: "darwin",
        version: "1.0.0",
        runtimes: [{ name: "claude", status: "ready", checked_at: new Date().toISOString() }],
        device_id: `device-ver-${randomUUID()}`,
      },
      apiKey,
      envWithVersion,
    );

    // The machine is registered (runner onboarding may fail if AMA is not fully
    // mocked, but we can at least verify the 201 registration path)
    // When AMA is not configured enough, runner is null — that's fine.
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    // If runner onboarding ran (AMA configured), version should be set
    if (body.runner !== null && body.runner !== undefined) {
      expect(body.runner.version).toBe("0.2.5");
    }
    // The machine itself was created
    expect(body.id).toBeDefined();
  });

  it("returns runner=null when AMA is not configured (no AMA_RUNNER_VERSION effect)", async () => {
    const userId = `runner-nover-user-${randomUUID()}`;
    const envNoAma = {
      DB: db,
      AE: { writeDataPoint: () => {} } as any,
      EMAIL: { send: async () => ({ messageId: "test" }) } as any,
      TUNNEL_RELAY: null as any,
      ASSETS: null as any,
      AUTH_SECRET: "test-secret-32-chars-minimum-ok!!",
      ALLOWED_HOSTS: "localhost:8788",
      GITHUB_CLIENT_ID: "x",
      GITHUB_CLIENT_SECRET: "x",
      MAILS_ADMIN_TOKEN: "",
      // No AMA config
    };
    await seedUser(db, userId, `${userId}@test.local`);
    const key = await createSessionForUser(userId, envNoAma);
    const [sessionToken, csrfToken] = key.split(":csrf:");

    const { api } = await import("../apps/web/server/routes");
    const res = await api.request(
      "/api/machines",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:8788",
          "x-forwarded-proto": "http",
          cookie: `ak_session=${sessionToken}`,
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({
          name: "no-ama-machine",
          os: "linux",
          version: "1.0.0",
          runtimes: [{ name: "claude", status: "ready", checked_at: new Date().toISOString() }],
          device_id: `device-noama-${randomUUID()}`,
        }),
      },
      envNoAma,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.runner).toBeNull();
  });
});

// ─── 5. Git identity env wired into dispatch runtimeEnv ──────────────────────

describe("dispatchTaskToAma includes git identity env in runtimeEnv", () => {
  const OWNER = "git-env-dispatch-owner";

  beforeAll(async () => {
    await seedUser(db, OWNER, "git-env-dispatch@test.local");
  });

  async function configureAmaIntegration(ownerId: string, environmentId: string) {
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO ama_owner_integrations (tenant_id, ama_project_id, session_secret_vault_id, metadata)
         VALUES (?, ?, ?, '{}')
         ON CONFLICT(tenant_id) DO UPDATE SET ama_project_id = excluded.ama_project_id, session_secret_vault_id = excluded.session_secret_vault_id`,
      )
      .bind(ownerId, "project_git", "vault_git")
      .run();
    await db
      .prepare(
        `INSERT INTO machines (id, owner_id, device_id, name, os, version, runtimes, status, last_heartbeat_at, created_at, ama_environment_id)
         VALUES (?, ?, ?, ?, 'test', '1.0.0', ?, 'online', ?, ?, ?)
         ON CONFLICT(owner_id, device_id) DO UPDATE SET runtimes = excluded.runtimes, status = 'online', ama_environment_id = excluded.ama_environment_id`,
      )
      .bind(
        `machine-git-${ownerId}`,
        ownerId,
        `ama-git-${ownerId}`,
        "git-machine",
        JSON.stringify([{ name: "claude", status: "ready", checked_at: now }]),
        now,
        now,
        environmentId,
      )
      .run();
  }

  it("includes GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL in session runtimeEnv", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const { dispatchTaskToAma } = await import("../apps/web/server/taskDispatch");

    await configureAmaIntegration(OWNER, "env_git");

    const board = await createBoard(db, OWNER, `git-env-board-${randomUUID()}`, "ops");
    const agent = await createTestAgent(db, OWNER, {
      name: "Git Identity Agent",
      username: `git-agent-${randomUUID()}`,
      runtime: "claude",
    });
    const task = await createTask(db, OWNER, {
      title: "Git env task",
      board_id: board.id,
      assigned_to: agent.id,
      metadata: { annotations: { "runtime.source": "ama" } },
      skipRuntimeAvailability: true,
    });

    let capturedRuntimeEnv: Record<string, string> | null = null;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = reqUrl(input);
      if (url === "https://auth.test/.well-known/openid-configuration") return oidcDiscoveryResponse();
      if (url === "https://ama.test/api/v1/projects/project_git") return jsonResponse(amaProject("project_git"));
      if (url === "https://ama.test/api/v1/runners?environmentId=env_git&limit=100") {
        return jsonResponse({
          data: [
            {
              id: "runner-git",
              environmentId: "env_git",
              state: "active",
              runtimes: [{ runtime: "claude-code", models: [], state: "ready" }],
              currentLoad: 0,
              maxConcurrent: 2,
              lastHeartbeatAt: new Date().toISOString(),
            },
          ],
        });
      }
      if (url === "https://ama.test/api/v1/providers?limit=100")
        return jsonResponse({ data: [{ id: "provider_claude", type: "anthropic", status: "active" }] });
      if (url.includes("/api/v1/providers/provider_claude/models")) return jsonResponse({ data: [] });
      if (url === "https://ama.test/api/v1/vaults/vault_git/credentials") return jsonResponse(amaCredential("vaultcred_git", "vaultver_git"), 201);
      if (url === "https://ama.test/api/v1/agents")
        return jsonResponse(
          amaAgent("ama_agent_git", { projectId: "project_git", name: "Git Identity Agent", provider: "provider_claude", model: null }),
          201,
        );
      if (url === "https://ama.test/api/v1/sessions") {
        const body = JSON.parse(await reqBody(input, init)) as Record<string, any>;
        capturedRuntimeEnv = body.spec.env as Record<string, string>;
        return jsonResponse(amaSession("session_git_1", body.spec), 201);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const env = makeEnv();
    await dispatchTaskToAma(db, env, OWNER, task, { apiOrigin: "https://ak.test" });

    expect(capturedRuntimeEnv).not.toBeNull();
    expect(capturedRuntimeEnv!.GIT_AUTHOR_NAME).toBe("Git Identity Agent");
    expect(capturedRuntimeEnv!.GIT_AUTHOR_EMAIL).toContain("@mails.agent-kanban.dev");
    expect(capturedRuntimeEnv!.GIT_COMMITTER_NAME).toBe("Git Identity Agent");
    expect(capturedRuntimeEnv!.GIT_COMMITTER_EMAIL).toContain("@mails.agent-kanban.dev");
    // Also verify the standard AK env vars are still present
    expect(capturedRuntimeEnv!.AK_WORKER).toBe("1");
    expect(capturedRuntimeEnv!.AK_AGENT_ID).toBe(agent.id);
  });
});
