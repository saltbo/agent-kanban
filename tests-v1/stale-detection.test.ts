// @vitest-environment node

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestAgent, seedUser, setupMiniflare } from "./helpers/db";

let db: D1Database;
let mf: Miniflare;

const OWNER = "stale-test-user";

beforeAll(async () => {
  ({ mf, db } = await setupMiniflare());
  await seedUser(db, OWNER, "stale@test.com");
});

afterAll(async () => {
  await mf.dispose();
});

// ─── detectAndReleaseStaleAll ──────────────────────────────────────────────

describe("detectAndReleaseStaleAll", () => {
  it("releases a stale in_progress task across all boards", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const { detectAndReleaseStaleAll } = await import("../apps/web/server/taskStale");

    const board = await createBoard(db, OWNER, "Board-A", "ops");
    const task = await createTask(db, OWNER, { title: "Stale task", board_id: board.id });
    const agent = await createTestAgent(db, OWNER, { name: "Stale Agent", username: "stale-agent-a", runtime: "claude" });

    // Manually force the task to in_progress with assigned_to
    const agentId = agent.id;
    await db.prepare("UPDATE tasks SET status = 'in_progress', assigned_to = ? WHERE id = ?").bind(agentId, task.id).run();

    // Backdate ALL existing actions so MAX(created_at) is beyond the stale cutoff
    const pastTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await db.prepare("UPDATE task_actions SET created_at = ? WHERE task_id = ?").bind(pastTime, task.id).run();

    await detectAndReleaseStaleAll(db);

    const row = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first<any>();
    expect(row!.status).toBe("todo");
  });

  it("does not release a fresh in_progress task", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const { detectAndReleaseStaleAll } = await import("../apps/web/server/taskStale");

    const board = await createBoard(db, OWNER, "Board-B", "ops");
    const task = await createTask(db, OWNER, { title: "Fresh task", board_id: board.id });
    const agent = await createTestAgent(db, OWNER, { name: "Fresh Agent", username: "fresh-agent-b", runtime: "claude" });

    const agentId = agent.id;
    await db.prepare("UPDATE tasks SET status = 'in_progress', assigned_to = ? WHERE id = ?").bind(agentId, task.id).run();

    // The task_action from createTask is already recent (within 24h) — no changes needed

    await detectAndReleaseStaleAll(db);

    const row = await db.prepare("SELECT status, assigned_to FROM tasks WHERE id = ?").bind(task.id).first<any>();
    expect(row!.status).toBe("in_progress");
    expect(row!.assigned_to).toBe(agentId);
  });

  it("releases stale task on one board but not fresh task on another board", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const { detectAndReleaseStaleAll } = await import("../apps/web/server/taskStale");

    const boardStale = await createBoard(db, OWNER, "Board-Stale", "ops");
    const boardFresh = await createBoard(db, OWNER, "Board-Fresh", "ops");
    const staleTask = await createTask(db, OWNER, { title: "Stale task mixed", board_id: boardStale.id });
    const freshTask = await createTask(db, OWNER, { title: "Fresh task mixed", board_id: boardFresh.id });

    const agent = await createTestAgent(db, OWNER, { name: "Mixed Agent", username: "mixed-agent-c", runtime: "claude" });
    const agentId = agent.id;
    await db.prepare("UPDATE tasks SET status = 'in_progress', assigned_to = ? WHERE id = ?").bind(agentId, staleTask.id).run();
    await db.prepare("UPDATE tasks SET status = 'in_progress', assigned_to = ? WHERE id = ?").bind(agentId, freshTask.id).run();

    // Backdate all stale task's actions so MAX(created_at) exceeds the 24h cutoff
    const pastTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await db.prepare("UPDATE task_actions SET created_at = ? WHERE task_id = ?").bind(pastTime, staleTask.id).run();
    // freshTask actions remain at NOW — within the 24h window

    await detectAndReleaseStaleAll(db);

    const staleRow = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind(staleTask.id).first<any>();
    expect(staleRow!.status).toBe("todo");

    const freshRow = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind(freshTask.id).first<any>();
    expect(freshRow!.status).toBe("in_progress");
  });

  it("is a no-op when no tasks are in_progress", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const { detectAndReleaseStaleAll } = await import("../apps/web/server/taskStale");

    const board = await createBoard(db, OWNER, "Board-Noop", "ops");
    const task = await createTask(db, OWNER, { title: "Todo task noop", board_id: board.id });

    await detectAndReleaseStaleAll(db);

    const row = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first<any>();
    expect(row!.status).toBe("todo");
  });
});

// ─── detectAndReleaseStale (board-scoped) ─────────────────────────────────

describe("detectAndReleaseStale (board-scoped)", () => {
  it("releases a stale in_progress task on the specified board", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const { detectAndReleaseStale } = await import("../apps/web/server/taskStale");

    const board = await createBoard(db, OWNER, "Board-Scoped", "ops");
    const task = await createTask(db, OWNER, { title: "Scoped stale task", board_id: board.id });
    const agent = await createTestAgent(db, OWNER, { name: "Scoped Agent", username: "scoped-agent-d", runtime: "claude" });

    await db.prepare("UPDATE tasks SET status = 'in_progress', assigned_to = ? WHERE id = ?").bind(agent.id, task.id).run();
    const pastTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await db.prepare("UPDATE task_actions SET created_at = ? WHERE task_id = ?").bind(pastTime, task.id).run();

    await detectAndReleaseStale(db, board.id);

    const row = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first<any>();
    expect(row!.status).toBe("todo");
  });

  it("does not release a stale task on a different board", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const { detectAndReleaseStale } = await import("../apps/web/server/taskStale");

    const boardA = await createBoard(db, OWNER, "Board-ScopedA", "ops");
    const boardB = await createBoard(db, OWNER, "Board-ScopedB", "ops");
    const task = await createTask(db, OWNER, { title: "Cross-board task", board_id: boardA.id });
    const agent = await createTestAgent(db, OWNER, { name: "Cross Agent", username: "cross-agent-e", runtime: "claude" });

    await db.prepare("UPDATE tasks SET status = 'in_progress', assigned_to = ? WHERE id = ?").bind(agent.id, task.id).run();
    const pastTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await db.prepare("UPDATE task_actions SET created_at = ? WHERE task_id = ?").bind(pastTime, task.id).run();

    // Sweep a different board — task on boardA should be untouched
    await detectAndReleaseStale(db, boardB.id);

    const row = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first<any>();
    expect(row!.status).toBe("in_progress");
  });
});

// ─── detectStaleMachines ───────────────────────────────────────────────────

describe("detectStaleMachines", () => {
  it("marks an online machine offline when its heartbeat is beyond the stale timeout", async () => {
    const { upsertMachine, updateMachine, detectStaleMachines } = await import("../apps/web/server/machineRepo");

    const machine = await upsertMachine(db, OWNER, {
      name: "stale-machine",
      os: "linux",
      version: "1.0.0",
      runtimes: [{ name: "claude", status: "ready", checked_at: "2026-03-21T10:00:00Z" }],
      device_id: "device-stale-machine",
    });

    await updateMachine(db, machine.id, OWNER, {});

    // Force the heartbeat timestamp to be beyond MACHINE_STALE_TIMEOUT_MS (60s)
    const pastTime = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 minutes ago
    await db.prepare("UPDATE machines SET last_heartbeat_at = ? WHERE id = ?").bind(pastTime, machine.id).run();

    await detectStaleMachines(db);

    const row = await db.prepare("SELECT status FROM machines WHERE id = ?").bind(machine.id).first<any>();
    expect(row!.status).toBe("offline");
  });

  it("does not mark a recently-heartbeated machine offline", async () => {
    const { upsertMachine, updateMachine, detectStaleMachines } = await import("../apps/web/server/machineRepo");

    const machine = await upsertMachine(db, OWNER, {
      name: "fresh-machine",
      os: "linux",
      version: "1.0.0",
      runtimes: [{ name: "claude", status: "ready", checked_at: "2026-03-21T10:00:00Z" }],
      device_id: "device-fresh-machine",
    });

    // Heartbeat is now — within stale window
    await updateMachine(db, machine.id, OWNER, {});

    await detectStaleMachines(db);

    const row = await db.prepare("SELECT status FROM machines WHERE id = ?").bind(machine.id).first<any>();
    expect(row!.status).toBe("online");
  });

  it("leaves already-offline machines untouched", async () => {
    const { upsertMachine, detectStaleMachines } = await import("../apps/web/server/machineRepo");

    const machine = await upsertMachine(db, OWNER, {
      name: "already-offline-machine",
      os: "linux",
      version: "1.0.0",
      runtimes: [{ name: "claude", status: "ready", checked_at: "2026-03-21T10:00:00Z" }],
      device_id: "device-already-offline",
    });
    // Never heartbeated — status stays 'offline'

    await detectStaleMachines(db);

    const row = await db.prepare("SELECT status FROM machines WHERE id = ?").bind(machine.id).first<any>();
    expect(row!.status).toBe("offline");
  });
});
