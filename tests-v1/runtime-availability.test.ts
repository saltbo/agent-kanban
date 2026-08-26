// @vitest-environment node

import { randomUUID } from "node:crypto";
import type { AgentRuntime, MachineRuntime, MachineRuntimeStatus } from "@agent-kanban/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestAgent, seedUser, setupMiniflare } from "./helpers/db";

let db: D1Database;
let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];

async function createBoard(ownerId: string) {
  const { createBoard } = await import("../apps/web/server/boardRepo");
  return createBoard(db, ownerId, `runtime-board-${randomUUID().slice(0, 8)}`, "ops");
}

function runtime(name: AgentRuntime, status: MachineRuntimeStatus): MachineRuntime {
  return { name, status, checked_at: new Date().toISOString() };
}

async function createOnlineMachine(ownerId: string, runtimes: MachineRuntime[] | string[]) {
  const { updateMachine, upsertMachine } = await import("../apps/web/server/machineRepo");
  const machine = await upsertMachine(db, ownerId, {
    name: `machine-${randomUUID().slice(0, 8)}`,
    os: "darwin arm64",
    version: "1.0.0",
    runtimes,
    device_id: `runtime-device-${randomUUID()}`,
  });
  return updateMachine(db, machine.id, ownerId, {});
}

beforeAll(async () => {
  const setup = await setupMiniflare();
  mf = setup.mf;
  db = setup.db;
});

afterAll(async () => {
  await mf.dispose();
});

describe("runtime availability", () => {
  it("returns true for online non-stale machines with a ready runtime", async () => {
    const { isRuntimeAvailable, runtimeMatchValues } = await import("../apps/web/server/machineRepo");
    const ownerId = "runtime-canonical-match-user";
    await seedUser(db, ownerId, `${ownerId}@test.local`);
    await createOnlineMachine(ownerId, [runtime("claude", "ready")]);

    expect(runtimeMatchValues("claude")).toEqual(["claude", "Claude Code"]);
    await expect(isRuntimeAvailable(db, ownerId, "claude")).resolves.toBe(true);
    await expect(isRuntimeAvailable(db, ownerId, "Claude Code")).resolves.toBe(true);
    await expect(isRuntimeAvailable(db, ownerId, "codex")).resolves.toBe(false);
  });

  it("returns false for an online non-stale machine with only a limited runtime", async () => {
    const { isRuntimeAvailable } = await import("../apps/web/server/machineRepo");
    const ownerId = "runtime-limited-user";
    await seedUser(db, ownerId, `${ownerId}@test.local`);
    await createOnlineMachine(ownerId, [runtime("claude", "limited")]);

    await expect(isRuntimeAvailable(db, ownerId, "claude")).resolves.toBe(false);
  });

  it("normalizes legacy display labels at the machine boundary", async () => {
    const { isRuntimeAvailable } = await import("../apps/web/server/machineRepo");
    const ownerId = "runtime-label-match-user";
    await seedUser(db, ownerId, `${ownerId}@test.local`);
    await createOnlineMachine(ownerId, ["Claude Code"]);

    await expect(isRuntimeAvailable(db, ownerId, "claude")).resolves.toBe(true);
    await expect(isRuntimeAvailable(db, ownerId, "Claude Code")).resolves.toBe(true);
    await expect(isRuntimeAvailable(db, ownerId, "codex")).resolves.toBe(false);
  });

  it("matches codex by canonical id and official display label only", async () => {
    const { isRuntimeAvailable, runtimeMatchValues } = await import("../apps/web/server/machineRepo");
    const ownerId = "runtime-codex-label-user";
    await seedUser(db, ownerId, `${ownerId}@test.local`);
    await createOnlineMachine(ownerId, [runtime("codex", "ready")]);

    expect(runtimeMatchValues("codex")).toEqual(["codex", "Codex CLI"]);
    expect(runtimeMatchValues("Codex CLI")).toEqual(["codex", "Codex CLI"]);
    expect(runtimeMatchValues("Codex")).toEqual(["Codex"]);
    await expect(isRuntimeAvailable(db, ownerId, "codex")).resolves.toBe(true);
    await expect(isRuntimeAvailable(db, ownerId, "Codex CLI")).resolves.toBe(true);
    await expect(isRuntimeAvailable(db, ownerId, "Codex")).resolves.toBe(false);
  });

  it("ignores offline, stale, and other-owner machines", async () => {
    const { isRuntimeAvailable, upsertMachine } = await import("../apps/web/server/machineRepo");
    const ownerId = "runtime-scope-user";
    const otherOwnerId = "runtime-scope-other";
    await seedUser(db, ownerId, `${ownerId}@test.local`);
    await seedUser(db, otherOwnerId, `${otherOwnerId}@test.local`);
    await upsertMachine(db, ownerId, {
      name: "offline-claude",
      os: "darwin",
      version: "1.0.0",
      runtimes: [runtime("claude", "ready")],
      device_id: "offline-claude-device",
    });
    const staleMachine = await createOnlineMachine(ownerId, [runtime("claude", "ready")]);
    await createOnlineMachine(otherOwnerId, [runtime("claude", "ready")]);

    const staleHeartbeat = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await db.prepare("UPDATE machines SET last_heartbeat_at = ? WHERE id = ?").bind(staleHeartbeat, staleMachine!.id).run();

    await expect(isRuntimeAvailable(db, ownerId, "claude")).resolves.toBe(false);
  });
});

describe("agent runtime load fields", () => {
  it("reports runtime availability and queued/active task counts", async () => {
    const { getAgent, listAgents } = await import("../apps/web/server/agentRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const ownerId = "runtime-load-user";
    await seedUser(db, ownerId, `${ownerId}@test.local`);
    await createOnlineMachine(ownerId, [runtime("claude", "ready")]);
    const board = await createBoard(ownerId);
    const agent = await createTestAgent(db, ownerId, {
      name: "Runtime Load Agent",
      username: "runtime-load-agent",
      runtime: "claude",
    });
    const queuedTask = await createTask(db, ownerId, { title: "Queued runtime task", board_id: board.id, assigned_to: agent.id });
    const activeTask = await createTask(db, ownerId, { title: "Active runtime task", board_id: board.id, assigned_to: agent.id });
    await db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").bind(activeTask.id).run();

    const listedAgent = (await listAgents(db, ownerId)).find((candidate) => candidate.id === agent.id)!;
    const fetchedAgent = await getAgent(db, agent.id, ownerId);

    expect(listedAgent.status).toEqual({
      schedulable: true,
      tasks: {
        todo: 1,
        in_progress: 1,
        in_review: 0,
        done: 0,
        cancelled: 0,
      },
    });
    expect(fetchedAgent!.status).toEqual({
      schedulable: true,
      tasks: {
        todo: 1,
        in_progress: 1,
        in_review: 0,
        done: 0,
        cancelled: 0,
      },
    });
    expect(queuedTask.assigned_to).toBe(agent.id);
  });
});

describe("task assignment runtime guards", () => {
  it("rejects task creation assigned to an agent with no available runtime", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const ownerId = "runtime-create-reject-user";
    await seedUser(db, ownerId, `${ownerId}@test.local`);
    const board = await createBoard(ownerId);
    const agent = await createTestAgent(db, ownerId, {
      name: "Unavailable Create Agent",
      username: "unavailable-create-agent",
      runtime: "gemini",
    });

    await expect(createTask(db, ownerId, { title: "Unavailable runtime task", board_id: board.id, assigned_to: agent.id })).rejects.toThrow(
      'Runtime "gemini" is not available on any online machine',
    );
  });

  it("rejects assigning a task to an agent with no available runtime", async () => {
    const { assignTask, createTask } = await import("../apps/web/server/taskRepo");
    const ownerId = "runtime-assign-reject-user";
    await seedUser(db, ownerId, `${ownerId}@test.local`);
    const board = await createBoard(ownerId);
    const agent = await createTestAgent(db, ownerId, {
      name: "Unavailable Assign Agent",
      username: "unavailable-assign-agent",
      runtime: "codex",
    });
    const task = await createTask(db, ownerId, { title: "Assign unavailable runtime", board_id: board.id });

    await expect(assignTask(db, task.id, agent.id, "machine", "system")).rejects.toThrow('Runtime "codex" is not available on any online machine');
  });
});
