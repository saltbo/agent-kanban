// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { failTask } from "../apps/web/server/taskRepo.js";

function rawTodo(assignedTo: string | null) {
  return {
    id: "task-1",
    board_id: "board-1",
    seq: 1,
    status: "todo",
    title: "Assigned runtime task",
    description: null,
    repository_id: null,
    labels: null,
    created_by: "user-1",
    assigned_to: assignedTo,
    result: null,
    pr_url: null,
    input: null,
    metadata: "{}",
    created_from: null,
    scheduled_at: null,
    position: 0,
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
  };
}

function fakeDb(task: ReturnType<typeof rawTodo>, sessionBound = true) {
  const statements: Array<{ sql: string; args: unknown[]; bind: ReturnType<typeof vi.fn>; first: ReturnType<typeof vi.fn> }> = [];
  const prepare = vi.fn((sql: string) => {
    const statement = {
      sql,
      args: [] as unknown[],
      bind: vi.fn(),
      first: vi.fn(),
    };
    statement.bind.mockImplementation((...args: unknown[]) => {
      statement.args = args;
      return statement;
    });
    statement.first.mockImplementation(async () => {
      if (sql.includes("FROM tasks")) return task;
      if (sql.includes("FROM agent_sessions")) return sessionBound ? { bound: 1 } : null;
      return null;
    });
    statements.push(statement);
    return statement;
  });
  return {
    prepare,
    batch: vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }]),
    statements,
  };
}

const failure = {
  category: "protocol" as const,
  code: "ORPHANED_BEFORE_CLAIM",
  message: "Runtime disappeared before claim",
  retryable: true,
};
const attemptId = "attempt_12345678";

describe("failTask todo assignment guard", () => {
  it("rejects an unassigned todo before writing error records", async () => {
    const db = fakeDb(rawTodo(null));

    await expect(failTask(db as any, "task-1", "machine-actor", failure, "session-1", "claude", "machine-1", attemptId)).rejects.toMatchObject({
      status: 409,
      message: "Runtime failure requires an assigned task session",
    });
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("rejects a session that is not bound to the reporting machine and assigned agent", async () => {
    const db = fakeDb(rawTodo("agent-1"), false);

    await expect(failTask(db as any, "task-1", "machine-actor", failure, "session-1", "claude", "machine-1", attemptId)).rejects.toMatchObject({
      status: 409,
      message: "Task failure session is not bound to this machine and assigned agent",
    });
    const bindingCheck = db.statements.find(({ sql }) => sql.includes("FROM agent_sessions"));
    expect(bindingCheck?.args).toEqual(["session-1", "machine-1", "agent-1"]);
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("allows an assigned todo to enter the runtime error queue", async () => {
    const db = fakeDb(rawTodo("agent-1"));

    const task = await failTask(db as any, "task-1", "machine-actor", failure, "session-1", "claude", "machine-1", attemptId);

    expect(task).toMatchObject({ id: "task-1", status: "error", assigned_to: "agent-1" });
    const update = db.statements.find(({ sql }) => sql.includes("UPDATE tasks SET status = 'error'"));
    expect(update?.sql).toContain("AND assigned_to = ?");
    expect(update?.args.at(-1)).toBe("agent-1");
    expect(update?.args[1]).toBe(attemptId);
    const errorInsert = db.statements.find(({ sql }) => sql.includes("INSERT INTO task_errors"));
    expect(errorInsert?.args[0]).toBe(attemptId);
    const failedAction = db.statements.find(({ sql }) => sql.includes("'failed'"));
    expect(JSON.parse(failedAction?.args[3] as string)).toMatchObject({ ...failure, attempt_id: attemptId });
    expect(db.batch).toHaveBeenCalledOnce();
  });
});

describe("machine failure route guards", () => {
  const routes = readFileSync(new URL("../apps/web/server/routes.ts", import.meta.url), "utf8");
  const failRoute = routes.match(/api\.post\("\/api\/tasks\/:id\/fail",[\s\S]*?\n\}\);/)?.[0] ?? "";

  it("checks owner-scoped task data and rejects non-legacy runtime ownership", () => {
    expect(failRoute).toContain('getTask(c.env.DB, c.req.param("id"), c.get("ownerId"))');
    expect(failRoute).toContain('taskRuntimeSource(ownedTask) !== "legacy"');
    expect(failRoute).toContain("Local machine runtime cannot fail a task routed to AMA");
  });

  it("passes both the session and authenticated machine binding to failTask", () => {
    expect(failRoute).toContain('const machineId = c.get("machineId")');
    expect(failRoute).toContain("if (!machineId || !failureSessionId)");
    expect(failRoute).toContain("attempt_id is required and must be a stable opaque identifier");
    expect(failRoute).toMatch(/failTask\([\s\S]*?failureSessionId,[\s\S]*?machineId,[\s\S]*?body\.attempt_id,/);
  });
});
