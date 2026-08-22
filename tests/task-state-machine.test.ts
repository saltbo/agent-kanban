// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT } from "jose";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations as applyAllMigrations, createTestAgent, createTestWebSession, seedUser as seedRealmrootUser } from "./helpers/db";

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
    "0033_board_maintainer_heartbeat_enabled.sql",
    "0034_task_assignee_status_index.sql",
    "0035_board_maintainer_vault.sql",
    "0036_backfill_ama_session_secret_refs.sql",
    "0037_unique_latest_leader_per_runtime.sql",
    "0038_board_maintainer_http_trigger_serial.sql",
    "0039_realmroot_native.sql",
    "0040_ama_resource_initialization_claims.sql",
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

async function seedUser(db: D1Database): Promise<string> {
  const userId = "test-user-sm";
  await seedRealmrootUser(db, userId, "sm@example.com");
  return userId;
}

async function createWebSessionForUser(db: D1Database, userId: string): Promise<string> {
  const session = await createTestWebSession(db, userId);
  return `${session.token}:csrf:${session.csrfToken}`;
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

// ─── Unit tests: validateTransition ───

describe("validateTransition", () => {
  let validateTransition: typeof import("@agent-kanban/shared").validateTransition;

  beforeAll(async () => {
    ({ validateTransition } = await import("@agent-kanban/shared"));
  });

  // Valid transitions
  it("allows claim: todo → in_progress (agent:worker)", () => {
    expect(validateTransition("claim", "todo", "agent:worker")).toBeNull();
  });

  it("allows review: in_progress → in_review (agent:worker)", () => {
    expect(validateTransition("review", "in_progress", "agent:worker")).toBeNull();
  });

  it("allows reject: in_review → in_progress (agent:leader)", () => {
    expect(validateTransition("reject", "in_review", "agent:leader")).toBeNull();
  });

  it("allows reject: in_review → in_progress (agent:maintainer)", () => {
    expect(validateTransition("reject", "in_review", "agent:maintainer")).toBeNull();
  });

  it("allows complete: in_review → done (agent:leader)", () => {
    expect(validateTransition("complete", "in_review", "agent:leader")).toBeNull();
  });

  it("allows complete: in_review → done (agent:maintainer)", () => {
    expect(validateTransition("complete", "in_review", "agent:maintainer")).toBeNull();
  });

  it("allows cancel: in_progress → cancelled (agent:leader)", () => {
    expect(validateTransition("cancel", "in_progress", "agent:leader")).toBeNull();
  });

  it("allows cancel: in_progress → cancelled (agent:maintainer)", () => {
    expect(validateTransition("cancel", "in_progress", "agent:maintainer")).toBeNull();
  });

  it("allows cancel: in_review → cancelled (agent:leader)", () => {
    expect(validateTransition("cancel", "in_review", "agent:leader")).toBeNull();
  });

  it("allows release: in_progress → todo (machine)", () => {
    expect(validateTransition("release", "in_progress", "machine")).toBeNull();
  });

  it("rejects release from in_review", () => {
    expect(validateTransition("release", "in_review", "machine")).toEqual({
      code: "INVALID_TRANSITION",
      message: "Cannot release from in_review (allowed from: in_progress)",
    });
  });

  // Invalid transitions — wrong source status
  it("rejects claim from in_progress", () => {
    const err = validateTransition("claim", "in_progress", "agent:worker");
    expect(err?.code).toBe("INVALID_TRANSITION");
  });

  it("rejects claim from done", () => {
    const err = validateTransition("claim", "done", "agent:worker");
    expect(err?.code).toBe("INVALID_TRANSITION");
  });

  it("rejects review from todo", () => {
    const err = validateTransition("review", "todo", "agent:worker");
    expect(err?.code).toBe("INVALID_TRANSITION");
  });

  it("rejects review from in_review", () => {
    const err = validateTransition("review", "in_review", "agent:worker");
    expect(err?.code).toBe("INVALID_TRANSITION");
  });

  it("rejects complete from todo", () => {
    const err = validateTransition("complete", "todo", "agent:leader");
    expect(err?.code).toBe("INVALID_TRANSITION");
  });

  it("rejects complete from in_progress", () => {
    const err = validateTransition("complete", "in_progress", "agent:leader");
    expect(err?.code).toBe("INVALID_TRANSITION");
  });

  it("allows cancel: todo → cancelled (agent:leader)", () => {
    expect(validateTransition("cancel", "todo", "agent:leader")).toBeNull();
  });

  it("rejects cancel from done", () => {
    const err = validateTransition("cancel", "done", "agent:leader");
    expect(err?.code).toBe("INVALID_TRANSITION");
  });

  it("rejects cancel from cancelled", () => {
    const err = validateTransition("cancel", "cancelled", "agent:leader");
    expect(err?.code).toBe("INVALID_TRANSITION");
  });

  it("rejects reject from in_progress", () => {
    const err = validateTransition("reject", "in_progress", "agent:leader");
    expect(err?.code).toBe("INVALID_TRANSITION");
  });

  it("rejects release from todo", () => {
    const err = validateTransition("release", "todo", "machine");
    expect(err?.code).toBe("INVALID_TRANSITION");
  });

  it("rejects release from done", () => {
    const err = validateTransition("release", "done", "machine");
    expect(err?.code).toBe("INVALID_TRANSITION");
  });

  // Terminal states — nothing allowed
  it("rejects all actions from done", () => {
    for (const action of ["claim", "review", "reject", "complete", "cancel", "release"] as const) {
      const identities = ["machine", "agent:worker", "agent:leader"] as const;
      for (const id of identities) {
        const err = validateTransition(action, "done", id);
        expect(err).not.toBeNull();
      }
    }
  });

  it("rejects all actions from cancelled", () => {
    for (const action of ["claim", "review", "reject", "complete", "cancel", "release"] as const) {
      const identities = ["machine", "agent:worker", "agent:leader"] as const;
      for (const id of identities) {
        const err = validateTransition(action, "cancelled", id);
        expect(err).not.toBeNull();
      }
    }
  });

  // Permission violations — wrong identity
  it("rejects claim by machine", () => {
    const err = validateTransition("claim", "todo", "machine");
    expect(err?.code).toBe("FORBIDDEN");
  });

  it("rejects claim by agent:leader", () => {
    const err = validateTransition("claim", "todo", "agent:leader");
    expect(err?.code).toBe("FORBIDDEN");
  });

  it("rejects review by machine", () => {
    const err = validateTransition("review", "in_progress", "machine");
    expect(err?.code).toBe("FORBIDDEN");
  });

  it("rejects review by agent:leader", () => {
    const err = validateTransition("review", "in_progress", "agent:leader");
    expect(err?.code).toBe("FORBIDDEN");
  });

  it("allows complete by machine", () => {
    expect(validateTransition("complete", "in_review", "machine")).toBeNull();
  });

  it("rejects complete by agent:worker", () => {
    const err = validateTransition("complete", "in_review", "agent:worker");
    expect(err?.code).toBe("FORBIDDEN");
  });

  it("allows cancel by machine", () => {
    expect(validateTransition("cancel", "in_progress", "machine")).toBeNull();
  });

  it("rejects cancel by agent:worker", () => {
    const err = validateTransition("cancel", "in_progress", "agent:worker");
    expect(err?.code).toBe("FORBIDDEN");
  });

  it("rejects reject by machine", () => {
    const err = validateTransition("reject", "in_review", "machine");
    expect(err?.code).toBe("FORBIDDEN");
  });

  it("rejects reject by agent:worker", () => {
    const err = validateTransition("reject", "in_review", "agent:worker");
    expect(err?.code).toBe("FORBIDDEN");
  });

  it("rejects release by agent:worker", () => {
    const err = validateTransition("release", "in_progress", "agent:worker");
    expect(err?.code).toBe("FORBIDDEN");
  });

  it("allows release by agent:leader", () => {
    expect(validateTransition("release", "in_progress", "agent:leader")).toBeNull();
  });
});

// ─── Integration tests: repo functions ───

describe("task lifecycle repo functions", () => {
  const userId = "test-user-sm";
  let boardId: string;
  let testAgentId: string;
  let otherAgentId: string;
  let leaderAgentId: string;

  async function createTestTask() {
    const { createTask } = await import("../apps/web/server/taskRepo");
    return createTask(env.DB, userId, { title: `Task ${randomUUID().slice(0, 8)}`, board_id: boardId });
  }

  async function forceStatus(taskId: string, status: string) {
    await env.DB.prepare("UPDATE tasks SET status = ? WHERE id = ?").bind(status, taskId).run();
  }

  beforeAll(async () => {
    await seedUser(env.DB);
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const board = await createBoard(env.DB, userId, "sm-board", "ops");
    boardId = board.id;
    const { updateMachine, upsertMachine } = await import("../apps/web/server/machineRepo");
    const machine = await upsertMachine(env.DB, userId, {
      name: "sm-runtime-machine",
      os: "darwin",
      version: "1.0.0",
      runtimes: [{ name: "claude", status: "ready", checked_at: "2026-03-21T10:00:00Z" }],
      device_id: "sm-runtime-machine-device",
    });
    await updateMachine(env.DB, machine.id, userId, {});
    const agent = await createTestAgent(env.DB, userId, { name: "SM Test Agent", username: "sm-test-agent", runtime: "claude" });
    testAgentId = agent.id;
    const agent2 = await createTestAgent(env.DB, userId, { name: "SM Agent 2", username: "sm-agent-2", runtime: "claude" });
    otherAgentId = agent2.id;
    const leaderAgent = await createTestAgent(env.DB, userId, {
      name: "SM Leader Agent",
      username: "sm-leader-agent",
      runtime: "claude",
      kind: "leader",
    });
    leaderAgentId = leaderAgent.id;
  });

  describe("claim", () => {
    it("succeeds: todo → in_progress (agent:worker)", async () => {
      const { claimTask, assignTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await assignTask(env.DB, task.id, testAgentId, "machine", "system");
      const result = await claimTask(env.DB, task.id, testAgentId, "agent:worker");
      expect(result!.status).toBe("in_progress");
    });

    it("rejects claim from in_progress", async () => {
      const { claimTask, assignTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await assignTask(env.DB, task.id, testAgentId, "machine", "system");
      await forceStatus(task.id, "in_progress");
      await expect(claimTask(env.DB, task.id, testAgentId, "agent:worker")).rejects.toThrow();
    });

    it("rejects claim by wrong agent", async () => {
      const { claimTask, assignTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await assignTask(env.DB, task.id, testAgentId, "machine", "system");
      await expect(claimTask(env.DB, task.id, otherAgentId, "agent:worker")).rejects.toThrow("not assigned");
    });

    it("rejects a runtime-source mismatch atomically without status or action changes", async () => {
      const { claimTask, assignTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await assignTask(env.DB, task.id, testAgentId, "machine", "system", null, {
        metadata: { annotations: { "runtime.source": "legacy" } },
      });

      await expect(claimTask(env.DB, task.id, testAgentId, "agent:worker", "session-mismatch", "ama")).rejects.toThrow("runtime source changed");
      const stored = await env.DB.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first<{ status: string }>();
      const claimedActions = await env.DB.prepare("SELECT COUNT(*) AS count FROM task_actions WHERE task_id = ? AND action = 'claimed'")
        .bind(task.id)
        .first<{ count: number }>();
      expect(stored?.status).toBe("todo");
      expect(claimedActions?.count).toBe(0);
      const failedMetadata = await env.DB.prepare("SELECT metadata FROM tasks WHERE id = ?").bind(task.id).first<{ metadata: string }>();
      expect(JSON.parse(failedMetadata!.metadata).annotations).not.toHaveProperty("runtime.claimToken");

      const claimed = await claimTask(env.DB, task.id, testAgentId, "agent:worker", "session-match", "legacy");
      expect(claimed?.status).toBe("in_progress");
      const successfulMetadata = await env.DB.prepare("SELECT metadata FROM tasks WHERE id = ?").bind(task.id).first<{ metadata: string }>();
      expect(JSON.parse(successfulMetadata!.metadata).annotations).not.toHaveProperty("runtime.claimToken");
    });

    it("accepts an AMA claim for rollout tasks with only legacy AMA binding annotations", async () => {
      const { claimTask, assignTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await assignTask(env.DB, task.id, testAgentId, "machine", "system", null, {
        metadata: { annotations: { "ama.sessionId": "rollout-session", "ama.dispatch.result": "accepted" } },
      });

      const claimed = await claimTask(env.DB, task.id, testAgentId, "agent:worker", "rollout-ak-session", "ama");
      expect(claimed?.status).toBe("in_progress");
      const stored = await env.DB.prepare("SELECT metadata FROM tasks WHERE id = ?").bind(task.id).first<{ metadata: string }>();
      expect(JSON.parse(stored!.metadata).annotations).toMatchObject({
        "ama.sessionId": "rollout-session",
        "ama.dispatch.result": "accepted",
      });
      expect(JSON.parse(stored!.metadata).annotations).not.toHaveProperty("runtime.claimToken");
      const claimedActions = await env.DB.prepare("SELECT COUNT(*) AS count FROM task_actions WHERE task_id = ? AND action = 'claimed'")
        .bind(task.id)
        .first<{ count: number }>();
      expect(claimedActions?.count).toBe(1);
    });
  });

  describe("review", () => {
    it("succeeds: in_progress → in_review (agent:worker)", async () => {
      const { reviewTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "in_progress");
      const result = await reviewTask(env.DB, task.id, userId, "agent:worker", testAgentId, null, "agent:worker");
      expect(result!.status).toBe("in_review");
    });

    it("rejects review from todo", async () => {
      const { reviewTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await expect(reviewTask(env.DB, task.id, userId, "agent:worker", testAgentId, null, "agent:worker")).rejects.toThrow();
    });

    it("rejects review by machine", async () => {
      const { reviewTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "in_progress");
      await expect(reviewTask(env.DB, task.id, userId, "machine", "system", null, "machine")).rejects.toThrow();
    });
  });

  describe("reject", () => {
    it("succeeds: in_review → in_progress (agent:leader)", async () => {
      const { rejectTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "in_review");
      const result = await rejectTask(env.DB, task.id, "agent:leader", "system", "agent:leader");
      expect(result!.status).toBe("in_progress");
    });

    it("rejects reject from in_progress", async () => {
      const { rejectTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "in_progress");
      await expect(rejectTask(env.DB, task.id, "agent:leader", "system", "agent:leader")).rejects.toThrow();
    });

    it("rejects reject by agent:worker", async () => {
      const { rejectTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "in_review");
      await expect(rejectTask(env.DB, task.id, "agent:worker", "system", "agent:worker")).rejects.toThrow();
    });
  });

  describe("complete", () => {
    it("succeeds: in_review → done (agent:leader)", async () => {
      const { completeTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "in_review");
      const result = await completeTask(env.DB, task.id, "agent:leader", "system", "agent:leader");
      expect(result!.status).toBe("done");
    });

    it("preserves existing PR metadata when completing", async () => {
      const { completeTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await env.DB.prepare("UPDATE tasks SET status = 'in_review', pr_url = ?, result = ? WHERE id = ?")
        .bind("https://github.com/org/repo/pull/42", "legacy result", task.id)
        .run();

      const result = await completeTask(env.DB, task.id, "agent:leader", "system", "agent:leader");
      const stored = await env.DB.prepare("SELECT pr_url, result FROM tasks WHERE id = ?")
        .bind(task.id)
        .first<{ pr_url: string | null; result: string | null }>();
      const actions = await env.DB.prepare("SELECT detail FROM task_actions WHERE task_id = ? AND action = 'completed'")
        .bind(task.id)
        .all<{ detail: string | null }>();

      expect(result!.pr_url).toBe("https://github.com/org/repo/pull/42");
      expect(stored!.pr_url).toBe("https://github.com/org/repo/pull/42");
      expect(stored!.result).toBe("legacy result");
      expect(actions.results[0]?.detail).toBeNull();
    });

    it("rejects complete from todo", async () => {
      const { completeTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await expect(completeTask(env.DB, task.id, "agent:leader", "system", "agent:leader")).rejects.toThrow();
    });

    it("rejects complete from in_progress", async () => {
      const { completeTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "in_progress");
      await expect(completeTask(env.DB, task.id, "agent:leader", "system", "agent:leader")).rejects.toThrow();
    });

    it("rejects complete by agent:worker", async () => {
      const { completeTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "in_review");
      await expect(completeTask(env.DB, task.id, "agent:worker", "system", "agent:worker")).rejects.toThrow();
    });
  });

  describe("cancel", () => {
    it("succeeds: in_progress → cancelled (agent:leader)", async () => {
      const { cancelTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "in_progress");
      const result = await cancelTask(env.DB, task.id, "agent:leader", "system", "agent:leader");
      expect(result!.status).toBe("cancelled");
    });

    it("succeeds: in_review → cancelled (agent:leader)", async () => {
      const { cancelTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "in_review");
      const result = await cancelTask(env.DB, task.id, "agent:leader", "system", "agent:leader");
      expect(result!.status).toBe("cancelled");
    });

    it("allows cancel: todo → cancelled (agent:leader)", async () => {
      const { cancelTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      const result = await cancelTask(env.DB, task.id, "agent:leader", "system", "agent:leader");
      expect(result!.status).toBe("cancelled");
      expect(result!.assigned_to).toBeNull();
    });

    it("rejects cancel from done", async () => {
      const { cancelTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "done");
      await expect(cancelTask(env.DB, task.id, "agent:leader", "system", "agent:leader")).rejects.toThrow();
    });

    it("rejects cancel from cancelled", async () => {
      const { cancelTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "cancelled");
      await expect(cancelTask(env.DB, task.id, "agent:leader", "system", "agent:leader")).rejects.toThrow();
    });

    it("rejects cancel by agent:worker", async () => {
      const { cancelTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "in_progress");
      await expect(cancelTask(env.DB, task.id, "agent:worker", "system", "agent:worker")).rejects.toThrow();
    });
  });

  describe("release", () => {
    it("succeeds: in_progress → todo (machine)", async () => {
      const { releaseTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "in_progress");
      const result = await releaseTask(env.DB, task.id, "machine", "system", "machine");
      expect(result!.status).toBe("todo");
    });

    it("rejects release from in_review", async () => {
      const { releaseTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "in_review");
      await expect(releaseTask(env.DB, task.id, "machine", "system", "machine")).rejects.toThrow("Cannot release from in_review");
    });

    it("rejects release from todo", async () => {
      const { releaseTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await expect(releaseTask(env.DB, task.id, "machine", "system", "machine")).rejects.toThrow();
    });

    it("rejects release by agent:worker", async () => {
      const { releaseTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "in_progress");
      await expect(releaseTask(env.DB, task.id, "agent:worker", "system", "agent:worker")).rejects.toThrow();
    });

    it("allows release by agent:leader", async () => {
      const { releaseTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "in_progress");
      const result = await releaseTask(env.DB, task.id, "agent:leader", "system", "agent:leader");
      expect(result!.status).toBe("todo");
    });
  });

  describe("assign restrictions", () => {
    it("succeeds: assign in todo with no existing assignment", async () => {
      const { assignTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      const result = await assignTask(env.DB, task.id, testAgentId, "machine", "system");
      expect(result!.assigned_to).toBe(testAgentId);
    });

    it("rejects assign when already assigned", async () => {
      const { assignTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await assignTask(env.DB, task.id, testAgentId, "machine", "system");
      await expect(assignTask(env.DB, task.id, otherAgentId, "machine", "system")).rejects.toThrow("already assigned");
    });

    it("allows exactly one concurrent assignment winner without a fabricated action or token", async () => {
      const { assignTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      const attempts = await Promise.allSettled([
        assignTask(env.DB, task.id, testAgentId, "machine", "assigner-one", null, {
          metadata: { annotations: { "runtime.source": "legacy" } },
        }),
        assignTask(env.DB, task.id, otherAgentId, "machine", "assigner-two", null, {
          metadata: { annotations: { "runtime.source": "legacy" } },
        }),
      ]);

      const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
      const losers = attempts.filter((attempt) => attempt.status === "rejected") as PromiseRejectedResult[];
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]!.reason).toMatchObject({ status: 409 });

      const stored = await env.DB.prepare("SELECT assigned_to, metadata FROM tasks WHERE id = ?")
        .bind(task.id)
        .first<{ assigned_to: string; metadata: string }>();
      expect([testAgentId, otherAgentId]).toContain(stored?.assigned_to);
      expect(JSON.parse(stored!.metadata).annotations).toMatchObject({ "runtime.source": "legacy" });
      expect(JSON.parse(stored!.metadata).annotations).not.toHaveProperty("runtime.assignmentToken");

      const actions = await env.DB.prepare("SELECT actor_id FROM task_actions WHERE task_id = ? AND action = 'assigned'")
        .bind(task.id)
        .all<{ actor_id: string }>();
      expect(actions.results).toHaveLength(1);
      expect(actions.results[0]!.actor_id).toBe(stored?.assigned_to === testAgentId ? "assigner-one" : "assigner-two");
    });

    it("rejects assign in in_progress", async () => {
      const { assignTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "in_progress");
      await expect(assignTask(env.DB, task.id, testAgentId, "machine", "system")).rejects.toThrow("todo");
    });

    it("rejects assign in done", async () => {
      const { assignTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "done");
      await expect(assignTask(env.DB, task.id, testAgentId, "machine", "system")).rejects.toThrow("todo");
    });

    it("rejects assign to leader agent", async () => {
      const { assignTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await expect(assignTask(env.DB, task.id, leaderAgentId, "machine", "system")).rejects.toThrow("Tasks can only be assigned to worker agents");
    });

    it("rejects assign to NoSchedule-tainted worker agent", async () => {
      const { assignTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await env.DB.prepare("UPDATE agents SET taints = ? WHERE id = ?")
        .bind(JSON.stringify([{ key: "agent-kanban.dev/maintainer", value: "board-maintainer", effect: "NoSchedule" }]), testAgentId)
        .run();
      await expect(assignTask(env.DB, task.id, testAgentId, "machine", "system")).rejects.toThrow("tainted NoSchedule");
      await env.DB.prepare("UPDATE agents SET taints = NULL WHERE id = ?").bind(testAgentId).run();
    });

    it("rejects createTask with assigned_to leader agent", async () => {
      const { createTask } = await import("../apps/web/server/taskRepo");
      await expect(createTask(env.DB, userId, { title: "Leader Task", board_id: boardId, assigned_to: leaderAgentId })).rejects.toThrow(
        "Tasks can only be assigned to worker agents",
      );
    });

    it("rejects createTask with assigned_to NoSchedule-tainted worker agent", async () => {
      const { createTask } = await import("../apps/web/server/taskRepo");
      await env.DB.prepare("UPDATE agents SET taints = ? WHERE id = ?")
        .bind(JSON.stringify([{ key: "agent-kanban.dev/maintainer", value: "board-maintainer", effect: "NoSchedule" }]), testAgentId)
        .run();
      await expect(createTask(env.DB, userId, { title: "Tainted Worker Task", board_id: boardId, assigned_to: testAgentId })).rejects.toThrow(
        "tainted NoSchedule",
      );
      await env.DB.prepare("UPDATE agents SET taints = NULL WHERE id = ?").bind(testAgentId).run();
    });
  });

  describe("delete restrictions", () => {
    it("succeeds: delete unassigned todo", async () => {
      const { deleteTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      const result = await deleteTask(env.DB, task.id, userId);
      expect(result).toBe(true);
    });

    it("succeeds: delete cancelled task", async () => {
      const { deleteTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "cancelled");
      const result = await deleteTask(env.DB, task.id, userId);
      expect(result).toBe(true);
    });

    it("allows delete of assigned todo", async () => {
      const { deleteTask, assignTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await assignTask(env.DB, task.id, testAgentId, "machine", "system");
      const result = await deleteTask(env.DB, task.id, userId);
      expect(result).toBe(true);
    });

    it("rejects delete of in_progress task", async () => {
      const { deleteTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "in_progress");
      await expect(deleteTask(env.DB, task.id, userId)).rejects.toThrow("Cannot delete");
    });

    it("rejects delete of in_review task", async () => {
      const { deleteTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "in_review");
      await expect(deleteTask(env.DB, task.id, userId)).rejects.toThrow("Cannot delete");
    });

    it("rejects delete of done task", async () => {
      const { deleteTask } = await import("../apps/web/server/taskRepo");
      const task = await createTestTask();
      await forceStatus(task.id, "done");
      await expect(deleteTask(env.DB, task.id, userId)).rejects.toThrow("Cannot delete");
    });
  });
});

// ─── HTTP-level permission tests ───

describe.skip("legacy Agent JWT HTTP permissions (superseded by Realmroot at+jwt + DPoP coverage)", () => {
  let userId: string;
  let apiKey: string;
  let _machineId: string;
  let agentId: string;
  let sessionId: string;
  let sessionPrivateKey: CryptoKey;
  let leaderAgentId: string;
  let leaderSessionId: string;
  let leaderSessionPrivateKey: CryptoKey;
  let maintainerAgentId: string;
  let maintainerSessionId: string;
  let maintainerSessionPrivateKey: CryptoKey;
  let boardId: string;
  let otherBoardId: string;

  async function apiRequest(method: string, path: string, body?: any, token?: string) {
    const { api } = await import("../apps/web/server/routes");
    const headers: Record<string, string> = { "Content-Type": "application/json", Host: "localhost:8788", "x-forwarded-proto": "http" };
    if (token?.includes(":csrf:")) {
      const [sessionToken, csrfToken] = token.split(":csrf:");
      headers.cookie = `ak_session=${sessionToken}`;
      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") headers["x-csrf-token"] = csrfToken;
    } else if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
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

  async function signMaintainerSessionJWT(): Promise<string> {
    return new SignJWT({ sub: maintainerSessionId, aid: maintainerAgentId, jti: randomUUID(), aud: BETTER_AUTH_URL })
      .setProtectedHeader({ alg: "EdDSA", typ: "agent+jwt" })
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(maintainerSessionPrivateKey);
  }

  async function createTestTask(targetBoardId = boardId) {
    const { createTask } = await import("../apps/web/server/taskRepo");
    return createTask(env.DB, userId, { title: `HTTP Task ${randomUUID().slice(0, 8)}`, board_id: targetBoardId });
  }

  async function forceStatus(taskId: string, status: string) {
    await env.DB.prepare("UPDATE tasks SET status = ? WHERE id = ?").bind(status, taskId).run();
  }

  beforeAll(async () => {
    // Reuse user from previous describe block or create new
    userId = "test-user-sm";
    apiKey = await createWebSessionForUser(env.DB, userId);

    // Create machine
    const res = await apiRequest(
      "POST",
      "/api/machines",
      {
        name: "sm-machine",
        os: "darwin",
        version: "1.0.0",
        runtimes: [{ name: "claude", status: "ready", checked_at: "2026-03-21T10:00:00Z" }],
        device_id: "test-device-state-machine",
      },
      apiKey,
    );
    _machineId = ((await res.json()) as any).id;
    await apiRequest("POST", `/api/machines/${_machineId}/heartbeat`, {}, apiKey);

    // Create agent
    const agent = await createTestAgent(env.DB, userId, { name: "SM Agent", username: "sm-agent", runtime: "claude" });
    agentId = agent.id;

    // Create session
    sessionId = randomUUID();
    const keypair = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"]);
    sessionPrivateKey = (keypair as any).privateKey;
    const pubJwk = await crypto.subtle.exportKey("jwk", (keypair as any).publicKey);
    await apiRequest(
      "POST",
      `/api/agents/${agentId}/sessions`,
      {
        session_id: sessionId,
        session_public_key: pubJwk.x!,
      },
      apiKey,
    );

    const leaderAgent = await createTestAgent(env.DB, userId, {
      name: "SM HTTP Leader",
      username: "sm-http-leader",
      runtime: "codex",
      kind: "leader",
    });
    leaderAgentId = leaderAgent.id;

    leaderSessionId = randomUUID();
    const leaderKeypair = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"]);
    leaderSessionPrivateKey = (leaderKeypair as any).privateKey;
    const leaderPubJwk = await crypto.subtle.exportKey("jwk", (leaderKeypair as any).publicKey);
    await apiRequest(
      "POST",
      `/api/agents/${leaderAgentId}/sessions`,
      {
        session_id: leaderSessionId,
        session_public_key: leaderPubJwk.x!,
      },
      apiKey,
    );

    // Create board
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const board = await createBoard(env.DB, userId, "sm-http-board", "ops");
    boardId = board.id;
    const otherBoard = await createBoard(env.DB, userId, "sm-http-other-board", "ops");
    otherBoardId = otherBoard.id;

    const maintainerAgent = await createTestAgent(env.DB, userId, {
      name: "SM HTTP Maintainer",
      username: "sm-http-maintainer",
      runtime: "claude",
      role: "board-maintainer",
    });
    maintainerAgentId = maintainerAgent.id;

    maintainerSessionId = randomUUID();
    const maintainerKeypair = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"]);
    maintainerSessionPrivateKey = (maintainerKeypair as any).privateKey;
    const maintainerPubJwk = await crypto.subtle.exportKey("jwk", (maintainerKeypair as any).publicKey);
    await apiRequest(
      "POST",
      `/api/agents/${maintainerAgentId}/sessions`,
      {
        session_id: maintainerSessionId,
        session_public_key: maintainerPubJwk.x!,
      },
      apiKey,
    );

    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO board_maintainers (
        id, owner_id, board_id, agent_id, ama_schedule_id, prompt, interval_seconds, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '', 86400, 'active', ?, ?)`,
    )
      .bind(`maintainer-${randomUUID()}`, userId, boardId, maintainerAgentId, `sched-${randomUUID()}`, now, now)
      .run();
  });

  it("agent cannot complete a task (403)", async () => {
    const task = await createTestTask();
    await forceStatus(task.id, "in_review");
    const jwt = await signSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/complete`, {}, jwt);
    expect(res.status).toBe(403);
  });

  it("agent cannot cancel a task (403)", async () => {
    const task = await createTestTask();
    await forceStatus(task.id, "in_progress");
    const jwt = await signSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/cancel`, {}, jwt);
    expect(res.status).toBe(403);
  });

  it("agent cannot reject a task (403)", async () => {
    const task = await createTestTask();
    await forceStatus(task.id, "in_review");
    const jwt = await signSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/reject`, {}, jwt);
    expect(res.status).toBe(403);
  });

  it("active board maintainer can complete a task on its board", async () => {
    const task = await createTestTask();
    await forceStatus(task.id, "in_review");
    const jwt = await signMaintainerSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/complete`, {}, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("done");
  });

  it("active board maintainer can reject a task on its board", async () => {
    const task = await createTestTask();
    await forceStatus(task.id, "in_review");
    const jwt = await signMaintainerSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/reject`, { reason: "needs work" }, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("in_progress");
  });

  it("active board maintainer cannot complete a task on another board", async () => {
    const task = await createTestTask(otherBoardId);
    await forceStatus(task.id, "in_review");
    const jwt = await signMaintainerSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/complete`, {}, jwt);
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.message).toBe("agent:worker cannot perform complete");
  });

  it("paused board maintainer cannot complete a task on its board", async () => {
    await env.DB.prepare("UPDATE board_maintainers SET status = 'paused' WHERE agent_id = ? AND board_id = ?").bind(maintainerAgentId, boardId).run();
    const task = await createTestTask();
    await forceStatus(task.id, "in_review");
    const jwt = await signMaintainerSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/complete`, {}, jwt);
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.message).toBe("agent:worker cannot perform complete");
    await env.DB.prepare("UPDATE board_maintainers SET status = 'active' WHERE agent_id = ? AND board_id = ?").bind(maintainerAgentId, boardId).run();
  });

  it("worker agent cannot release a task (403)", async () => {
    const task = await createTestTask();
    await forceStatus(task.id, "in_progress");
    const jwt = await signSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/release`, {}, jwt);
    expect(res.status).toBe(403);
  });

  it("leader agent can release a task (200)", async () => {
    const task = await createTestTask();
    await forceStatus(task.id, "in_progress");
    const jwt = await signLeaderSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/release`, {}, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("todo");
  });

  it("leader agent can reject after BA grants are cleared", async () => {
    await env.DB.prepare("DELETE FROM agentCapabilityGrant WHERE agentId = ?").bind(leaderSessionId).run();
    const task = await createTestTask();
    await forceStatus(task.id, "in_review");
    const jwt = await signLeaderSessionJWT();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/reject`, { reason: "needs work" }, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("in_progress");
  });

  it("machine can release a task (200)", async () => {
    const task = await createTestTask();
    const { assignTask } = await import("../apps/web/server/taskRepo");
    await assignTask(env.DB, task.id, agentId, "machine", "system");
    await forceStatus(task.id, "in_progress");
    const res = await apiRequest("POST", `/api/tasks/${task.id}/release`, {}, apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("todo");
  });

  it("machine cannot claim a task (403)", async () => {
    const task = await createTestTask();
    const res = await apiRequest("POST", `/api/tasks/${task.id}/claim`, { agent_id: agentId }, apiKey);
    expect(res.status).toBe(403);
  });

  it("machine cannot review a task (403)", async () => {
    const task = await createTestTask();
    await forceStatus(task.id, "in_progress");
    const res = await apiRequest("POST", `/api/tasks/${task.id}/review`, {}, apiKey);
    expect(res.status).toBe(403);
  });
});
