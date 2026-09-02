// @vitest-environment node

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations as applyAllMigrations, seedUser } from "./helpers/db";

let db: D1Database;
let mf: Miniflare;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "test-db" },
  });
  db = await mf.getD1Database("DB");
  await applyAllMigrations(db);
});

afterAll(async () => {
  await mf.dispose();
});

describe("task JSON field parsing (labels, input, metadata)", () => {
  const ownerId = "user-json-task";
  let boardId: string;
  let taskId: string;

  it("setup: create board", async () => {
    await seedUser(db, ownerId, `${ownerId}@test.local`);
    const { createBoard } = await import("../server/adapters/d1/boardRepo");
    const board = await createBoard(db, ownerId, "json-test-board", "ops");
    boardId = board.id;
    await createBoard(db, ownerId, "json-empty-labels-board", "ops");
    await db
      .prepare("UPDATE boards SET labels = ? WHERE id = ?")
      .bind(
        JSON.stringify([
          { name: "bug", color: "#EF4444", description: "Bug fix" },
          { name: "urgent", color: "#EAB308", description: "Urgent work" },
          { name: "feature", color: "#22D3EE", description: "Feature work" },
        ]),
        boardId,
      )
      .run();
  });

  it("createTask returns labels as array and input as object", async () => {
    const { createTask } = await import("../server/adapters/d1/taskRepo");
    const task = await createTask(db, ownerId, {
      title: "Test labels and input",
      board_id: boardId,
      labels: ["bug", "urgent"],
      input: { prompt: "fix the thing", context: { file: "main.ts", line: 42 } },
      metadata: { annotations: { "ama.sessionId": "session_123", "ama.dispatch.result": "accepted" } },
    });
    taskId = task.id;

    expect(Array.isArray(task.labels)).toBe(true);
    expect(task.labels).toEqual(["bug", "urgent"]);
    expect(typeof task.input).toBe("object");
    expect(task.input).toEqual({ prompt: "fix the thing", context: { file: "main.ts", line: 42 } });
    expect(task.metadata).toEqual({ annotations: { "ama.sessionId": "session_123", "ama.dispatch.result": "accepted" } });
  });

  it("createTask rejects labels that are not defined on the board", async () => {
    const { createTask } = await import("../server/adapters/d1/taskRepo");
    await expect(
      createTask(db, ownerId, {
        title: "Unknown label",
        board_id: boardId,
        labels: ["missing"],
      }),
    ).rejects.toThrow("Label not found: missing");
  });

  it("createTask with null labels/input returns null", async () => {
    const { createTask } = await import("../server/adapters/d1/taskRepo");
    const task = await createTask(db, ownerId, {
      title: "Bare task",
      board_id: boardId,
    });

    expect(task.labels).toBeNull();
    expect(task.input).toBeNull();
    expect(task.metadata).toEqual({});
  });

  it("listTasks returns parsed labels and input", async () => {
    const { listTasks } = await import("../server/adapters/d1/taskRepo");
    const tasks = await listTasks(db, ownerId, { board_id: boardId });
    const task = tasks.find((t) => t.id === taskId)!;

    expect(Array.isArray(task.labels)).toBe(true);
    expect(task.labels).toEqual(["bug", "urgent"]);
    expect(typeof task.input).toBe("object");
    expect(task.input!.prompt).toBe("fix the thing");
    expect(task.metadata).toEqual({ annotations: { "ama.sessionId": "session_123", "ama.dispatch.result": "accepted" } });
  });

  it("getTask returns parsed labels and input", async () => {
    const { getTask } = await import("../server/adapters/d1/taskRepo");
    const task = await getTask(db, taskId, ownerId);

    expect(task).toBeTruthy();
    expect(Array.isArray(task!.labels)).toBe(true);
    expect(task!.labels).toEqual(["bug", "urgent"]);
    expect(typeof task!.input).toBe("object");
    expect(task!.input!.context).toEqual({ file: "main.ts", line: 42 });
    expect(task!.metadata).toEqual({ annotations: { "ama.sessionId": "session_123", "ama.dispatch.result": "accepted" } });
  });

  it("updateTask accepts arrays/objects and returns parsed values", async () => {
    const { updateTask } = await import("../server/adapters/d1/taskRepo");
    const task = await updateTask(db, taskId, {
      labels: ["feature"],
      input: { prompt: "new prompt" },
      metadata: { annotations: { "ama.sessionId": "session_456", "ama.dispatch.result": "resumed" } },
    });

    expect(task).toBeTruthy();
    expect(task!.labels).toEqual(["feature"]);
    expect(task!.input).toEqual({ prompt: "new prompt" });
    expect(task!.metadata).toEqual({ annotations: { "ama.sessionId": "session_456", "ama.dispatch.result": "resumed" } });
  });

  it("updated values persist through getTask", async () => {
    const { getTask } = await import("../server/adapters/d1/taskRepo");
    const task = await getTask(db, taskId, ownerId);

    expect(task!.labels).toEqual(["feature"]);
    expect(task!.input).toEqual({ prompt: "new prompt" });
    expect(task!.metadata).toEqual({ annotations: { "ama.sessionId": "session_456", "ama.dispatch.result": "resumed" } });
  });

  it("getBoard returns tasks with parsed labels and input", async () => {
    const { getBoard } = await import("../server/adapters/d1/boardRepo");
    const board = await getBoard(db, boardId, ownerId);

    expect(board).toBeTruthy();
    const task = board!.tasks.find((t) => t.id === taskId)!;
    expect(Array.isArray(task.labels)).toBe(true);
    expect(task.labels).toEqual(["feature"]);
    expect(typeof task.input).toBe("object");
    expect(task.input).toEqual({ prompt: "new prompt" });
    expect(task.metadata).toEqual({ annotations: { "ama.sessionId": "session_456", "ama.dispatch.result": "resumed" } });
  });

  it("deleteBoardLabel removes the label from tasks on the same board", async () => {
    const { createTask, getTask } = await import("../server/adapters/d1/taskRepo");
    const { deleteBoardLabel } = await import("../server/adapters/d1/boardRepo");
    const task = await createTask(db, ownerId, {
      title: "Delete label propagation",
      board_id: boardId,
      labels: ["bug", "feature"],
    });

    const board = await deleteBoardLabel(db, boardId, ownerId, "bug");
    const updated = await getTask(db, task.id, ownerId);

    expect(board!.labels.map((label) => label.name)).not.toContain("bug");
    expect(updated!.labels).toEqual(["feature"]);
  });
});
