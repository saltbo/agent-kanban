// @vitest-environment node
//
// Tests for the bounded-read contracts introduced in messageRepo.listMessages
// and taskRepo.getTaskActions:
//   - Without `since`: returns the most recent `limit` rows in ASC order.
//   - With `since`: returns up to `limit` rows *after* the cursor in ASC order.
//   - Default limit is 500; callers may pass a smaller value.

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, seedUser, setupMiniflare } from "./helpers/db";

const env = createTestEnv();
let mf: Miniflare;

beforeAll(async () => {
  ({ mf, db: env.DB } = await setupMiniflare());
  await seedUser(env.DB, "limits-user", "limits@test.com");
});

afterAll(async () => {
  await mf.dispose();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeBoard(name: string) {
  const { createBoard } = await import("../apps/web/server/boardRepo");
  return createBoard(env.DB, "limits-user", name, "ops");
}

async function makeTask(boardId: string, title: string) {
  const { createTask } = await import("../apps/web/server/taskRepo");
  return createTask(env.DB, "limits-user", { title, board_id: boardId });
}

async function insertActions(taskId: string, count: number): Promise<string[]> {
  const { addTaskAction } = await import("../apps/web/server/taskRepo");
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    // Small sleep to guarantee distinct created_at timestamps in SQLite
    await new Promise((r) => setTimeout(r, 2));
    const action = await addTaskAction(env.DB, taskId, "machine", "system", "commented", `action ${i}`);
    ids.push(action.id);
  }
  return ids;
}

async function insertMessages(taskId: string, count: number): Promise<string[]> {
  const { createMessage } = await import("../apps/web/server/messageRepo");
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    await new Promise((r) => setTimeout(r, 2));
    const msg = await createMessage(env.DB, taskId, "user", "limits-user", `message ${i}`);
    ids.push(msg.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// listMessages
// ---------------------------------------------------------------------------

describe("listMessages — no since (tail window)", () => {
  let taskId: string;

  beforeAll(async () => {
    const board = await makeBoard("lm-no-since-board");
    const task = await makeTask(board.id, "lm-no-since-task");
    taskId = task.id;
  });

  it("returns empty array for task with no messages", async () => {
    const { listMessages } = await import("../apps/web/server/messageRepo");
    const msgs = await listMessages(env.DB, taskId);
    expect(msgs).toEqual([]);
  });

  it("returns single message in ASC order", async () => {
    const { createMessage, listMessages } = await import("../apps/web/server/messageRepo");
    await createMessage(env.DB, taskId, "user", "limits-user", "only message");
    const msgs = await listMessages(env.DB, taskId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("only message");
  });

  it("returns results in ascending created_at order", async () => {
    const { createMessage, listMessages } = await import("../apps/web/server/messageRepo");
    await createMessage(env.DB, taskId, "user", "limits-user", "second message");
    const msgs = await listMessages(env.DB, taskId);
    // created_at of last entry must be >= first
    expect(new Date(msgs[msgs.length - 1].created_at).getTime()).toBeGreaterThanOrEqual(new Date(msgs[0].created_at).getTime());
  });

  it("truncates to limit and returns the tail (most recent rows)", async () => {
    const board = await makeBoard("lm-truncate-board");
    const task = await makeTask(board.id, "lm-truncate-task");
    await insertMessages(task.id, 7);

    const { listMessages } = await import("../apps/web/server/messageRepo");
    const msgs = await listMessages(env.DB, task.id, undefined, 5);
    expect(msgs).toHaveLength(5);
    // The tail window: should contain messages 2–6 (0-indexed), not message 0 or 1
    expect(msgs.some((m) => m.content === "message 0")).toBe(false);
    expect(msgs.some((m) => m.content === "message 1")).toBe(false);
    expect(msgs.some((m) => m.content === "message 6")).toBe(true);
  });

  it("returns exactly limit rows when count equals limit", async () => {
    const board = await makeBoard("lm-exact-board");
    const task = await makeTask(board.id, "lm-exact-task");
    await insertMessages(task.id, 5);

    const { listMessages } = await import("../apps/web/server/messageRepo");
    const msgs = await listMessages(env.DB, task.id, undefined, 5);
    expect(msgs).toHaveLength(5);
  });
});

describe("listMessages — with since (incremental catch-up)", () => {
  let taskId: string;

  beforeAll(async () => {
    const board = await makeBoard("lm-since-board");
    const task = await makeTask(board.id, "lm-since-task");
    taskId = task.id;
    await insertMessages(taskId, 5);
  });

  it("returns empty when since is after all messages", async () => {
    const { listMessages } = await import("../apps/web/server/messageRepo");
    const future = new Date(Date.now() + 60000).toISOString();
    const msgs = await listMessages(env.DB, taskId, future);
    expect(msgs).toEqual([]);
  });

  it("returns only messages after the since cursor", async () => {
    const { listMessages } = await import("../apps/web/server/messageRepo");
    // Fetch all to get the 2nd message's created_at
    const all = await listMessages(env.DB, taskId);
    const pivot = all[1].created_at;

    const msgs = await listMessages(env.DB, taskId, pivot);
    expect(msgs.length).toBe(3);
    // All returned rows must be strictly after the pivot
    for (const m of msgs) {
      expect(new Date(m.created_at).getTime()).toBeGreaterThan(new Date(pivot).getTime());
    }
  });

  it("returns results in ascending order when since is provided", async () => {
    const { listMessages } = await import("../apps/web/server/messageRepo");
    const all = await listMessages(env.DB, taskId);
    const pivot = all[0].created_at;

    const msgs = await listMessages(env.DB, taskId, pivot);
    for (let i = 1; i < msgs.length; i++) {
      expect(new Date(msgs[i].created_at).getTime()).toBeGreaterThanOrEqual(new Date(msgs[i - 1].created_at).getTime());
    }
  });

  it("truncates to limit when rows after cursor exceed limit", async () => {
    const { listMessages } = await import("../apps/web/server/messageRepo");
    const all = await listMessages(env.DB, taskId);
    const pivot = all[0].created_at; // after first, 4 rows remain

    const msgs = await listMessages(env.DB, taskId, pivot, 2);
    expect(msgs).toHaveLength(2);
    // Should be the first two after the cursor (head), not the tail
    expect(msgs[0].content).toBe("message 1");
    expect(msgs[1].content).toBe("message 2");
  });

  it("returns all rows after cursor when count is below limit", async () => {
    const { listMessages } = await import("../apps/web/server/messageRepo");
    const all = await listMessages(env.DB, taskId);
    const pivot = all[2].created_at; // 2 rows remain after index 2

    const msgs = await listMessages(env.DB, taskId, pivot, 500);
    expect(msgs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// getTaskActions
// ---------------------------------------------------------------------------

describe("getTaskActions — no since (tail window)", () => {
  let taskId: string;

  beforeAll(async () => {
    const board = await makeBoard("gta-no-since-board");
    const task = await makeTask(board.id, "gta-no-since-task");
    taskId = task.id;
    // createTask inserts a "created" action already
  });

  it("returns at least the creation action for a new task", async () => {
    const { getTaskActions } = await import("../apps/web/server/taskRepo");
    const actions = await getTaskActions(env.DB, taskId);
    expect(actions.length).toBeGreaterThanOrEqual(1);
    expect(actions[0].action).toBe("created");
  });

  it("returns results in ascending created_at order", async () => {
    await insertActions(taskId, 2);
    const { getTaskActions } = await import("../apps/web/server/taskRepo");
    const actions = await getTaskActions(env.DB, taskId);
    for (let i = 1; i < actions.length; i++) {
      expect(new Date(actions[i].created_at).getTime()).toBeGreaterThanOrEqual(new Date(actions[i - 1].created_at).getTime());
    }
  });

  it("truncates to limit and returns the tail (most recent rows)", async () => {
    const board = await makeBoard("gta-trunc-board");
    const task = await makeTask(board.id, "gta-trunc-task");
    // createTask inserts 1 "created" action; insert 6 more → 7 total
    await insertActions(task.id, 6);

    const { getTaskActions } = await import("../apps/web/server/taskRepo");
    const actions = await getTaskActions(env.DB, task.id, undefined, 5);
    expect(actions).toHaveLength(5);
    // "created" action should be excluded (oldest row dropped)
    expect(actions.some((a) => a.action === "created")).toBe(false);
    // Most recent action should be present
    expect(actions[actions.length - 1].detail).toBe("action 5");
  });

  it("returns exactly limit rows when count equals limit", async () => {
    const board = await makeBoard("gta-exact-board");
    const task = await makeTask(board.id, "gta-exact-task");
    // 1 "created" + 4 more = 5 total
    await insertActions(task.id, 4);

    const { getTaskActions } = await import("../apps/web/server/taskRepo");
    const actions = await getTaskActions(env.DB, task.id, undefined, 5);
    expect(actions).toHaveLength(5);
  });
});

describe("getTaskActions — with since (incremental catch-up)", () => {
  let taskId: string;

  beforeAll(async () => {
    const board = await makeBoard("gta-since-board");
    const task = await makeTask(board.id, "gta-since-task");
    taskId = task.id;
    await insertActions(taskId, 5);
  });

  it("returns empty when since is after all actions", async () => {
    const { getTaskActions } = await import("../apps/web/server/taskRepo");
    const future = new Date(Date.now() + 60000).toISOString();
    const actions = await getTaskActions(env.DB, taskId, future);
    expect(actions).toEqual([]);
  });

  it("returns only actions after the since cursor", async () => {
    const { getTaskActions } = await import("../apps/web/server/taskRepo");
    const all = await getTaskActions(env.DB, taskId);
    const pivot = all[1].created_at;

    const actions = await getTaskActions(env.DB, taskId, pivot);
    for (const a of actions) {
      expect(new Date(a.created_at).getTime()).toBeGreaterThan(new Date(pivot).getTime());
    }
  });

  it("returns results in ascending order when since is provided", async () => {
    const { getTaskActions } = await import("../apps/web/server/taskRepo");
    const all = await getTaskActions(env.DB, taskId);
    const pivot = all[0].created_at;

    const actions = await getTaskActions(env.DB, taskId, pivot);
    for (let i = 1; i < actions.length; i++) {
      expect(new Date(actions[i].created_at).getTime()).toBeGreaterThanOrEqual(new Date(actions[i - 1].created_at).getTime());
    }
  });

  it("truncates to limit when rows after cursor exceed limit", async () => {
    const { getTaskActions } = await import("../apps/web/server/taskRepo");
    const all = await getTaskActions(env.DB, taskId);
    // After the first row (created), we have the "created" action + 5 "commented"
    const pivot = all[0].created_at; // skip first; up to 5 rows remain

    const actions = await getTaskActions(env.DB, taskId, pivot, 2);
    expect(actions).toHaveLength(2);
    // head of the window: first two after pivot
    expect(actions[0].detail).toBe("action 0");
    expect(actions[1].detail).toBe("action 1");
  });

  it("returns all rows after cursor when count is below limit", async () => {
    const { getTaskActions } = await import("../apps/web/server/taskRepo");
    const all = await getTaskActions(env.DB, taskId);
    const pivot = all[all.length - 3].created_at; // 2 rows remain

    const actions = await getTaskActions(env.DB, taskId, pivot, 500);
    expect(actions).toHaveLength(2);
  });
});
