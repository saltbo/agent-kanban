import type { BoardAction, CreateTaskInput, IdentityType, Task, TaskAction, TaskActionType, TaskStatus, TaskWithNotes } from "@agent-kanban/shared";
import { hasNoScheduleTaint, validateTransition } from "@agent-kanban/shared";
import { HTTPException } from "hono/http-exception";
import { getDefaultBoard } from "./boardRepo";
import { recordBoardRepository } from "./boardRepositoryRepo";
import { type D1, MAX_TASK_PARTITION_ROWS, newLongId, parseJsonFields } from "./db";
import { isRuntimeAvailable } from "./machineRepo";
import { computeBlocked, detectCycle, getDependencies, setDependencies } from "./taskDeps";

const parseTask = <T extends Task>(row: T & { result?: string | null }): T => {
  const task = parseJsonFields(row, ["labels", "input", "metadata"]) as T & { result?: string | null };
  delete task.result;
  return task;
};

async function assertKnownLabels(db: D1, boardId: string, labels: string[] | null | undefined): Promise<void> {
  if (!labels?.length) return;
  const board = await db.prepare("SELECT labels FROM boards WHERE id = ?").bind(boardId).first<{ labels: string }>();
  if (!board) throw new HTTPException(400, { message: "Board not found" });
  const knownLabels = new Set((JSON.parse(board.labels) as { name: string }[]).map((label) => label.name));
  const unknown = labels.find((label) => !knownLabels.has(label));
  if (unknown) throw new HTTPException(400, { message: `Label not found: ${unknown}` });
}

async function assertRepositoryBelongsToBoardOwner(db: D1, boardId: string, repositoryId: string): Promise<void> {
  const row = await db
    .prepare(
      `
      SELECT 1
      FROM boards b
      JOIN repositories r ON r.owner_id = b.owner_id
      WHERE b.id = ? AND r.id = ?
    `,
    )
    .bind(boardId, repositoryId)
    .first();
  if (!row) throw new HTTPException(404, { message: "Repository not found" });
}

async function assertOwnedTaskIds(db: D1, ownerId: string, taskIds: string[], message: string): Promise<void> {
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM tasks t
       JOIN boards b ON b.id = t.board_id
       WHERE t.id IN (${placeholders}) AND b.owner_id = ?`,
    )
    .bind(...ids, ownerId)
    .first<{ count: number }>();
  if (row?.count !== ids.length) throw new HTTPException(400, { message });
}

function enforceTransition(action: TaskActionType, currentStatus: TaskStatus, identity: IdentityType): void {
  const error = validateTransition(action as any, currentStatus, identity);
  if (error) {
    const status = error.code === "FORBIDDEN" ? 403 : 409;
    throw new HTTPException(status, { message: error.message });
  }
}

async function assertAssignableWorkerAgent(
  db: D1,
  ownerId: string,
  agentId: string,
  missingStatus: 400 | 404,
  skipRuntimeAvailability = false,
): Promise<void> {
  const agent = await db
    .prepare("SELECT kind, runtime, taints FROM agents WHERE id = ? AND owner_id = ?")
    .bind(agentId, ownerId)
    .first<{ kind: string; runtime: string; taints: string | null }>();
  if (!agent) throw new HTTPException(missingStatus, { message: "Agent not found" });
  if (agent.kind !== "worker") throw new HTTPException(400, { message: "Tasks can only be assigned to worker agents" });
  if (hasNoScheduleTaint(agent.taints ? JSON.parse(agent.taints) : null)) {
    throw new HTTPException(409, { message: "Agent is tainted NoSchedule and cannot be assigned normal tasks" });
  }
  if (skipRuntimeAvailability) return;
  if (!(await isRuntimeAvailable(db, ownerId, agent.runtime))) {
    throw new HTTPException(409, {
      message: `Runtime "${agent.runtime}" is not available on any online machine. Choose or create a worker that uses an available runtime.`,
    });
  }
}

export async function createTask(
  db: D1,
  ownerId: string,
  input: CreateTaskInput & { actorType?: string; actorId?: string; assigned_to?: string; skipRuntimeAvailability?: boolean },
): Promise<Task> {
  const actorType = input.actorType ?? "machine";
  const actorId = input.actorId ?? "system";
  const board = input.board_id
    ? await db
        .prepare("SELECT id, type FROM boards WHERE id = ? AND owner_id = ?")
        .bind(input.board_id, ownerId)
        .first<{ id: string; type: string }>()
    : await getDefaultBoard(db, ownerId);

  if (!board) throw new HTTPException(400, { message: input.board_id ? "Board not found" : "No board exists. Create a board first." });

  if (board.type === "dev" && !input.repository_id) {
    throw new HTTPException(400, { message: "repository_id is required for dev board tasks" });
  }
  if (board.type === "ops" && input.repository_id) {
    throw new HTTPException(400, { message: "repository_id is not allowed for ops board tasks" });
  }
  if (input.repository_id) await assertRepositoryBelongsToBoardOwner(db, board.id, input.repository_id);

  const maxPos = await db
    .prepare("SELECT COALESCE(MAX(position), -1) as max_pos FROM tasks WHERE board_id = ? AND status = 'todo'")
    .bind(board.id)
    .first<{ max_pos: number }>();

  const taskId = newLongId();
  const logId = newLongId();
  const now = new Date().toISOString();
  const labelsJson = input.labels ? JSON.stringify(input.labels) : null;
  const inputJson = input.input ? JSON.stringify(input.input) : null;
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : "{}";
  const position = (maxPos?.max_pos ?? -1) + 1;

  if (input.depends_on?.length) {
    await assertOwnedTaskIds(db, ownerId, input.depends_on, "Dependency task not found");
    const hasCycle = await detectCycle(db, taskId, input.depends_on);
    if (hasCycle) throw new HTTPException(400, { message: "Circular dependency detected" });
  }

  if (input.created_from) {
    await assertOwnedTaskIds(db, ownerId, [input.created_from], "Parent task not found");
  }

  if (input.assigned_to) {
    await assertAssignableWorkerAgent(db, ownerId, input.assigned_to, 400, input.skipRuntimeAvailability);
  }
  await assertKnownLabels(db, board.id, input.labels);

  // Atomically allocate the next seq number via RETURNING
  const seqResult = await db
    .prepare("UPDATE boards SET task_seq = task_seq + 1 WHERE id = ? RETURNING task_seq")
    .bind(board.id)
    .first<{ task_seq: number }>();
  const seq = seqResult!.task_seq;

  const stmts = [
    db
      .prepare(`
      INSERT INTO tasks (id, board_id, seq, status, title, description, repository_id, labels, created_by, assigned_to, result, pr_url, input, metadata, created_from, scheduled_at, position, created_at, updated_at)
      VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        taskId,
        board.id,
        seq,
        input.title,
        input.description || null,
        input.repository_id || null,
        labelsJson,
        actorId,
        input.assigned_to || null,
        inputJson,
        metadataJson,
        input.created_from || null,
        input.scheduled_at || null,
        position,
        now,
        now,
      ),
    db
      .prepare(
        "INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at) VALUES (?, ?, ?, ?, 'created', NULL, NULL, ?)",
      )
      .bind(logId, taskId, actorType, actorId, now),
    ...(input.assigned_to
      ? [
          db
            .prepare(
              "INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at) VALUES (?, ?, ?, ?, 'assigned', NULL, NULL, ?)",
            )
            .bind(newLongId(), taskId, actorType, actorId, now),
        ]
      : []),
    ...(input.depends_on || []).map((depId) => db.prepare("INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)").bind(taskId, depId)),
  ];

  await db.batch(stmts);
  if (input.repository_id) await recordBoardRepository(db, board.id, input.repository_id);

  return {
    id: taskId,
    board_id: board.id,
    seq,
    status: "todo" as const,
    title: input.title,
    description: input.description || null,
    repository_id: input.repository_id || null,
    labels: input.labels || null,
    created_by: actorId,
    assigned_to: input.assigned_to || null,
    pr_url: null,
    input: input.input || null,
    metadata: input.metadata || {},
    created_from: input.created_from || null,
    scheduled_at: input.scheduled_at || null,
    position,
    created_at: now,
    updated_at: now,
  };
}

export async function assertTaskOwner(db: D1, taskId: string, ownerId: string): Promise<void> {
  const row = await db
    .prepare("SELECT 1 FROM tasks t JOIN boards b ON t.board_id = b.id WHERE t.id = ? AND b.owner_id = ?")
    .bind(taskId, ownerId)
    .first();
  if (!row) throw new HTTPException(404, { message: "Task not found" });
}

export async function listTasks(
  db: D1,
  ownerId: string,
  filters: {
    repository_id?: string;
    status?: string;
    label?: string;
    board_id?: string;
    parent?: string;
    assigned_to?: string;
    runtime_source?: "ama" | "legacy";
  },
): Promise<Task[]> {
  let query = `
    SELECT t.*, r.name as repository_name, b.type as board_type FROM tasks t
    LEFT JOIN repositories r ON t.repository_id = r.id
    JOIN boards b ON t.board_id = b.id
    WHERE b.owner_id = ?
  `;
  const binds: unknown[] = [ownerId];

  if (filters.board_id) {
    query += " AND t.board_id = ?";
    binds.push(filters.board_id);
  }
  if (filters.repository_id) {
    query += " AND t.repository_id = ?";
    binds.push(filters.repository_id);
  }
  if (filters.status) {
    query += " AND t.status = ?";
    binds.push(filters.status);
  }
  if (filters.label) {
    query += " AND EXISTS (SELECT 1 FROM json_each(t.labels) WHERE json_each.value = ?)";
    binds.push(filters.label);
  }
  if (filters.parent) {
    query += " AND t.created_from = ?";
    binds.push(filters.parent);
  }
  if (filters.assigned_to) {
    query += " AND t.assigned_to = ?";
    binds.push(filters.assigned_to);
  }
  if (filters.runtime_source) {
    query += ` AND json_extract(t.metadata, '$.annotations."runtime.source"') = ?`;
    binds.push(filters.runtime_source);
  }

  query += " ORDER BY t.position";

  const stmt = db.prepare(query);
  const result = await (binds.length ? stmt.bind(...binds) : stmt).all<Task>();
  const tasks = result.results.map(parseTask);

  const taskIds = tasks.map((t) => t.id);
  if (taskIds.length > 0) {
    const blockedSet = await computeBlocked(db, taskIds);
    const depsMap = new Map<string, string[]>();
    for (let i = 0; i < taskIds.length; i += 90) {
      const chunk = taskIds.slice(i, i + 90);
      const placeholders = chunk.map(() => "?").join(",");
      const depsResult = await db
        .prepare(`SELECT task_id, depends_on FROM task_dependencies WHERE task_id IN (${placeholders})`)
        .bind(...chunk)
        .all<{ task_id: string; depends_on: string }>();
      for (const row of depsResult.results) {
        const arr = depsMap.get(row.task_id) || [];
        arr.push(row.depends_on);
        depsMap.set(row.task_id, arr);
      }
    }
    for (const task of tasks) {
      task.blocked = blockedSet.has(task.id);
      (task as any).depends_on = depsMap.get(task.id) || [];
    }
  }

  return tasks;
}

export async function getTask(db: D1, taskId: string, ownerId: string): Promise<TaskWithNotes | null> {
  const task = await db
    .prepare(`
    SELECT t.*, a.name as agent_name, a.public_key as agent_public_key, a.fingerprint as agent_fingerprint,
      r.name as repository_name,
      (SELECT COUNT(*) FROM tasks sub WHERE sub.created_from = t.id) as subtask_count,
      (SELECT ta.session_id FROM task_actions ta WHERE ta.task_id = t.id AND ta.action = 'claimed' ORDER BY ta.created_at DESC LIMIT 1) as active_session_id
    FROM tasks t
    LEFT JOIN agents a ON t.assigned_to = a.id
    LEFT JOIN repositories r ON t.repository_id = r.id
    JOIN boards b ON t.board_id = b.id
    WHERE t.id = ? AND b.owner_id = ?
  `)
    .bind(taskId, ownerId)
    .first<Task & { subtask_count: number; active_session_id: string | null }>();
  if (!task) return null;
  parseTask(task);

  const [actions, deps, blockedSet] = await Promise.all([getTaskActions(db, taskId), getDependencies(db, taskId), computeBlocked(db, [taskId])]);

  const duration = computeDuration(actions);
  task.blocked = blockedSet.has(taskId);

  return { ...task, notes: actions, duration_minutes: duration, depends_on: deps, subtask_count: task.subtask_count };
}

export async function updateTask(
  db: D1,
  taskId: string,
  updates: Partial<Pick<Task, "title" | "description" | "repository_id" | "labels" | "pr_url" | "input" | "position" | "scheduled_at">> & {
    metadata?: Record<string, unknown>;
    depends_on?: string[];
  },
  ownerId?: string,
): Promise<Task | null> {
  const task = ownerId
    ? await db
        .prepare("SELECT t.* FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.id = ? AND b.owner_id = ?")
        .bind(taskId, ownerId)
        .first<Task>()
    : await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first<Task>();
  if (!task) return null;

  if (updates.depends_on !== undefined) {
    if (updates.depends_on.length > 0) {
      const taskOwner =
        ownerId ?? (await db.prepare("SELECT owner_id FROM boards WHERE id = ?").bind(task.board_id).first<{ owner_id: string }>())?.owner_id;
      if (!taskOwner) return null;
      await assertOwnedTaskIds(db, taskOwner, updates.depends_on, "Dependency task not found");
      const hasCycle = await detectCycle(db, taskId, updates.depends_on);
      if (hasCycle) throw new HTTPException(400, { message: "Circular dependency detected" });
    }
    await setDependencies(db, taskId, updates.depends_on);
  }
  if (updates.labels !== undefined) {
    await assertKnownLabels(db, task.board_id, updates.labels);
  }
  if (updates.repository_id) {
    await assertRepositoryBelongsToBoardOwner(db, task.board_id, updates.repository_id);
  }

  const now = new Date().toISOString();
  const sets: string[] = ["updated_at = ?"];
  const binds: unknown[] = [now];

  const jsonFields = new Set(["labels", "input", "metadata"]);
  const allowedFields = ["title", "description", "repository_id", "labels", "pr_url", "input", "metadata", "position", "scheduled_at"] as const;
  for (const field of allowedFields) {
    if (field in updates && (updates as any)[field] !== undefined) {
      sets.push(`${field} = ?`);
      const val = (updates as any)[field];
      binds.push(jsonFields.has(field) && val != null ? JSON.stringify(val) : val);
    }
  }

  binds.push(taskId);
  if (ownerId) binds.push(ownerId);
  await db
    .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?${ownerId ? " AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)" : ""}`)
    .bind(...binds)
    .run();
  if (updates.repository_id) await recordBoardRepository(db, task.board_id, updates.repository_id);

  return parseTask({ ...task, ...updates, updated_at: now } as Task);
}

export async function deleteTask(db: D1, taskId: string, ownerId: string): Promise<boolean> {
  const task = await db
    .prepare(
      `SELECT t.status, t.assigned_to FROM tasks t
       JOIN boards b ON b.id = t.board_id
       WHERE t.id = ? AND b.owner_id = ?`,
    )
    .bind(taskId, ownerId)
    .first<{ status: string; assigned_to: string | null }>();
  if (!task) return false;

  const canDelete = task.status === "todo" || task.status === "cancelled";
  if (!canDelete) {
    throw new HTTPException(409, { message: `Cannot delete task in ${task.status}${task.assigned_to ? " (assigned)" : ""} status` });
  }

  const result = await db
    .prepare("DELETE FROM tasks WHERE id = ? AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)")
    .bind(taskId, ownerId)
    .run();
  return result.meta.changes > 0;
}

export async function deleteTaskAfterFailedDispatch(db: D1, taskId: string): Promise<void> {
  await db.prepare("DELETE FROM tasks WHERE id = ?").bind(taskId).run();
}

export async function claimTask(
  db: D1,
  taskId: string,
  agentId: string,
  identity: IdentityType,
  sessionId: string | null = null,
  expectedRuntimeSource?: "ama" | "legacy",
): Promise<Task | null> {
  const task = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first<Task>();
  if (!task) return null;
  if (task.assigned_to !== agentId) throw new HTTPException(409, { message: "Task is not assigned to this agent" });
  enforceTransition("claim" as any, task.status as TaskStatus, identity);

  const now = new Date().toISOString();
  const logId = newLongId();
  const sourceGuard =
    expectedRuntimeSource === "ama"
      ? `AND (
          json_extract(metadata, '$.annotations."runtime.source"') = ?
          OR (
            json_extract(metadata, '$.annotations."runtime.source"') IS NULL
            AND (
              json_type(metadata, '$.annotations."ama.sessionId"') = 'text'
              OR json_type(metadata, '$.annotations."ama.dispatch.result"') = 'text'
            )
          )
        )`
      : expectedRuntimeSource === "legacy"
        ? `AND json_extract(metadata, '$.annotations."runtime.source"') = ?`
        : "";
  const results = await db.batch([
    db
      .prepare(`
        UPDATE tasks SET
          status = 'in_progress',
          updated_at = ?,
          metadata = json_set(
            json_set(COALESCE(metadata, '{}'), '$.annotations', json(COALESCE(json_extract(metadata, '$.annotations'), '{}'))),
            '$.annotations."runtime.claimToken"', ?
          )
        WHERE id = ? AND status = 'todo' AND assigned_to = ? ${sourceGuard}
      `)
      .bind(...(expectedRuntimeSource ? [now, logId, taskId, agentId, expectedRuntimeSource] : [now, logId, taskId, agentId])),
    db
      .prepare(`
        INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at)
        SELECT ?, ?, ?, ?, 'claimed', NULL, ?, ?
        FROM tasks
        WHERE id = ? AND json_extract(metadata, '$.annotations."runtime.claimToken"') = ?
      `)
      .bind(logId, taskId, identity, agentId, sessionId, now, taskId, logId),
    db
      .prepare(`
        UPDATE tasks SET metadata = json_remove(metadata, '$.annotations."runtime.claimToken"')
        WHERE id = ? AND json_extract(metadata, '$.annotations."runtime.claimToken"') = ?
      `)
      .bind(taskId, logId),
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    throw new HTTPException(409, { message: "Task status, assignment, or runtime source changed before claim" });
  }

  return parseTask({ ...task, status: "in_progress" as const, updated_at: now });
}

export async function assignTask(
  db: D1,
  taskId: string,
  targetAgentId: string,
  actorType: string,
  actorId: string,
  sessionId: string | null = null,
  options: { skipRuntimeAvailability?: boolean; metadata?: Record<string, unknown>; assignmentToken?: string } = {},
): Promise<Task | null> {
  const task = await db
    .prepare("SELECT t.*, b.owner_id as board_owner_id FROM tasks t JOIN boards b ON t.board_id = b.id WHERE t.id = ?")
    .bind(taskId)
    .first<Task & { board_owner_id: string }>();
  if (!task) return null;
  if (task.status !== "todo") throw new HTTPException(409, { message: "Can only assign tasks in todo status" });
  if (task.assigned_to) throw new HTTPException(409, { message: "Task is already assigned" });

  const { board_owner_id: ownerId, ...taskRow } = task;
  await assertAssignableWorkerAgent(db, ownerId, targetAgentId, 404, options.skipRuntimeAvailability);

  const now = new Date().toISOString();
  const logId = options.assignmentToken ?? newLongId();

  const metadata = options.metadata ?? parseTask(taskRow).metadata;
  const statements = [
    db
      .prepare(`
        UPDATE tasks SET
          assigned_to = ?,
          metadata = json_set(
            json_set(?, '$.annotations', json(COALESCE(json_extract(?, '$.annotations'), '{}'))),
            '$.annotations."runtime.assignmentToken"', ?
          ),
          updated_at = ?
        WHERE id = ? AND status = 'todo' AND assigned_to IS NULL
      `)
      .bind(targetAgentId, JSON.stringify(metadata ?? {}), JSON.stringify(metadata ?? {}), logId, now, taskId),
    db
      .prepare(
        `INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at)
         SELECT ?, ?, ?, ?, 'assigned', NULL, ?, ?
         FROM tasks
         WHERE id = ? AND json_extract(metadata, '$.annotations."runtime.assignmentToken"') = ?`,
      )
      .bind(logId, taskId, actorType, actorId, sessionId, now, taskId, logId),
  ];
  if (!options.assignmentToken) {
    statements.push(
      db
        .prepare(`
          UPDATE tasks SET metadata = json_remove(metadata, '$.annotations."runtime.assignmentToken"')
          WHERE id = ? AND json_extract(metadata, '$.annotations."runtime.assignmentToken"') = ?
        `)
        .bind(taskId, logId),
    );
  }
  const results = await db.batch(statements);
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    throw new HTTPException(409, { message: "Task status or assignment changed before assignment" });
  }

  return parseTask({ ...taskRow, assigned_to: targetAgentId, metadata, updated_at: now } as Task);
}

export async function finalizeTaskAssignment(db: D1, taskId: string, assignmentToken: string): Promise<Task | null> {
  await db
    .prepare(`
      UPDATE tasks SET metadata = json_remove(metadata, '$.annotations."runtime.assignmentToken"')
      WHERE id = ? AND json_extract(metadata, '$.annotations."runtime.assignmentToken"') = ?
    `)
    .bind(taskId, assignmentToken)
    .run();
  const task = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first<Task>();
  return task ? parseTask(task) : null;
}

export async function rollbackTaskAssignment(
  db: D1,
  taskId: string,
  targetAgentId: string,
  assignmentToken: string,
  metadata: Record<string, unknown> | null,
  updatedAt: string,
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(`
        UPDATE tasks SET assigned_to = NULL, updated_at = ?
        WHERE id = ?
          AND status = 'todo'
          AND assigned_to = ?
          AND json_extract(metadata, '$.annotations."runtime.assignmentToken"') = ?
      `)
      .bind(updatedAt, taskId, targetAgentId, assignmentToken),
    db
      .prepare(`
        DELETE FROM task_actions
        WHERE id = ? AND task_id = ?
          AND EXISTS (
            SELECT 1 FROM tasks
            WHERE id = ?
              AND assigned_to IS NULL
              AND json_extract(metadata, '$.annotations."runtime.assignmentToken"') = ?
          )
      `)
      .bind(assignmentToken, taskId, taskId, assignmentToken),
    db
      .prepare(`
        UPDATE tasks SET metadata = ?
        WHERE id = ?
          AND assigned_to IS NULL
          AND json_extract(metadata, '$.annotations."runtime.assignmentToken"') = ?
      `)
      .bind(JSON.stringify(metadata ?? {}), taskId, assignmentToken),
  ]);
  return (results[0]?.meta?.changes ?? 0) > 0;
}

export async function completeTask(
  db: D1,
  taskId: string,
  actorType: string,
  actorId: string,
  identity: IdentityType,
  sessionId: string | null = null,
): Promise<Task | null> {
  const task = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first<Task>();
  if (!task) return null;
  enforceTransition("complete" as any, task.status as TaskStatus, identity);

  const now = new Date().toISOString();
  const logId = newLongId();

  await db.batch([
    db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?").bind(now, taskId),
    db
      .prepare(
        "INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)",
      )
      .bind(logId, taskId, actorType, actorId, null, sessionId, now),
  ]);

  return parseTask({ ...task, status: "done" as const, updated_at: now });
}

export async function cancelTask(
  db: D1,
  taskId: string,
  actorType: string,
  actorId: string,
  identity: IdentityType,
  sessionId: string | null = null,
): Promise<Task | null> {
  const task = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first<Task>();
  if (!task) return null;
  enforceTransition("cancel" as any, task.status as TaskStatus, identity);

  const now = new Date().toISOString();
  const logId = newLongId();

  await db.batch([
    db.prepare("UPDATE tasks SET status = 'cancelled', assigned_to = NULL, updated_at = ? WHERE id = ?").bind(now, taskId),
    db
      .prepare(
        "INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at) VALUES (?, ?, ?, ?, 'cancelled', NULL, ?, ?)",
      )
      .bind(logId, taskId, actorType, actorId, sessionId, now),
  ]);

  return parseTask({ ...task, status: "cancelled" as const, assigned_to: null, updated_at: now });
}

export async function reviewTask(
  db: D1,
  taskId: string,
  ownerId: string,
  actorType: string,
  actorId: string,
  prUrl: string | null,
  identity: IdentityType,
  sessionId: string | null = null,
): Promise<Task | null> {
  const task = await db
    .prepare("SELECT t.* FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.id = ? AND b.owner_id = ?")
    .bind(taskId, ownerId)
    .first<Task>();
  if (!task) return null;
  enforceTransition("review" as any, task.status as TaskStatus, identity);

  const now = new Date().toISOString();
  const logId = newLongId();

  await db.batch([
    db
      .prepare(
        "UPDATE tasks SET status = 'in_review', pr_url = COALESCE(?, pr_url), updated_at = ? WHERE id = ? AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)",
      )
      .bind(prUrl, now, taskId, ownerId),
    db
      .prepare(
        "INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at) VALUES (?, ?, ?, ?, 'review_requested', NULL, ?, ?)",
      )
      .bind(logId, taskId, actorType, actorId, sessionId, now),
  ]);

  return parseTask({ ...task, status: "in_review" as const, pr_url: prUrl || task.pr_url, updated_at: now });
}

export async function releaseTask(
  db: D1,
  taskId: string,
  actorType: string,
  actorId: string,
  identity: IdentityType,
  action: "released" | "timed_out" = "released",
  sessionId: string | null = null,
): Promise<Task | null> {
  const task = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first<Task>();
  if (!task) return null;
  enforceTransition("release" as any, task.status as TaskStatus, identity);

  const now = new Date().toISOString();
  const logId = newLongId();

  await db.batch([
    db.prepare("UPDATE tasks SET status = 'todo', scheduled_at = NULL, updated_at = ? WHERE id = ?").bind(now, taskId),
    db
      .prepare(
        "INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
      )
      .bind(logId, taskId, actorType, actorId, action, sessionId, now),
  ]);

  return parseTask({ ...task, status: "todo" as const, updated_at: now });
}

export async function rejectTask(
  db: D1,
  taskId: string,
  actorType: string,
  actorId: string,
  identity: IdentityType,
  reason?: string,
  sessionId: string | null = null,
): Promise<Task | null> {
  const task = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first<Task>();
  if (!task) return null;
  enforceTransition("reject" as any, task.status as TaskStatus, identity);

  const now = new Date().toISOString();
  const logId = newLongId();

  await db.batch([
    db.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?").bind(now, taskId),
    db
      .prepare(
        "INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at) VALUES (?, ?, ?, ?, 'rejected', ?, ?, ?)",
      )
      .bind(logId, taskId, actorType, actorId, reason || null, sessionId, now),
  ]);

  return parseTask({ ...task, status: "in_progress" as const, updated_at: now });
}

export async function addTaskAction(
  db: D1,
  taskId: string,
  actorType: string,
  actorId: string,
  action: string,
  detail: string | null,
  sessionId: string | null = null,
): Promise<TaskAction> {
  const actionId = newLongId();
  const now = new Date().toISOString();

  await db
    .prepare("INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(actionId, taskId, actorType, actorId, action, detail, sessionId, now)
    .run();

  return {
    id: actionId,
    task_id: taskId,
    actor_type: actorType as any,
    actor_id: actorId,
    actor_name: null,
    actor_public_key: null,
    action: action as any,
    detail,
    session_id: sessionId,
    created_at: now,
  };
}

// When `since` is provided, returns up to `limit` rows after the cursor in
// ASC order (incremental catch-up). Without `since`, returns the most recent
// `limit` rows — fetched DESC then reversed so callers always see ASC order.
// A hard LIMIT protects against tasks with runaway action counts.
//
// KNOWN LIMITATION: `since` uses `n.created_at > ?`, which skips rows sharing
// the cursor's millisecond. `newLongId()` is random (not monotonic) so the id
// can't serve as a tiebreaker today. Tracked for follow-up — fix requires
// either a monotonic sequence column or cursor-pair semantics.
export async function getTaskActions(db: D1, taskId: string, since?: string, limit: number = MAX_TASK_PARTITION_ROWS): Promise<TaskAction[]> {
  const base =
    "SELECT n.*, ag.name as actor_name, ag.public_key as actor_public_key FROM task_actions n LEFT JOIN agents ag ON n.actor_type LIKE 'agent:%' AND n.actor_id = ag.id WHERE n.task_id = ?";

  if (since) {
    const result = await db.prepare(`${base} AND n.created_at > ? ORDER BY n.created_at ASC LIMIT ?`).bind(taskId, since, limit).all<TaskAction>();
    return result.results;
  }
  const result = await db.prepare(`${base} ORDER BY n.created_at DESC LIMIT ?`).bind(taskId, limit).all<TaskAction>();
  return result.results.reverse();
}

export async function getBoardActionsByBoardId(db: D1, boardId: string, since: string): Promise<BoardAction[]> {
  const result = await db
    .prepare(`
      SELECT n.*, ag.name as actor_name, ag.public_key as actor_public_key, ag.kind as agent_kind
      FROM task_actions n
      JOIN tasks t ON n.task_id = t.id
      LEFT JOIN agents ag ON n.actor_type LIKE 'agent:%' AND n.actor_id = ag.id
      WHERE t.board_id = ? AND n.created_at > ?
      ORDER BY n.created_at ASC
      LIMIT 100
    `)
    .bind(boardId, since)
    .all<BoardAction>();
  return result.results;
}

export async function getBoardActions(db: D1, boardId: string, ownerId: string, since: string): Promise<BoardAction[]> {
  const result = await db
    .prepare(`
      SELECT n.*, ag.name as actor_name, ag.public_key as actor_public_key, ag.kind as agent_kind
      FROM task_actions n
      JOIN tasks t ON n.task_id = t.id
      JOIN boards b ON t.board_id = b.id
      LEFT JOIN agents ag ON n.actor_type LIKE 'agent:%' AND n.actor_id = ag.id
      WHERE t.board_id = ? AND b.owner_id = ? AND n.created_at > ?
      ORDER BY n.created_at ASC
      LIMIT 100
    `)
    .bind(boardId, ownerId, since)
    .all<BoardAction>();
  return result.results;
}

function computeDuration(actions: TaskAction[]): number | null {
  const claimed = actions.find((l) => l.action === "claimed");
  if (!claimed) return null;
  const end = actions.find((l) => l.action === "completed" || l.action === "cancelled");
  if (!end) return null;
  return Math.round((new Date(end.created_at).getTime() - new Date(claimed.created_at).getTime()) / 60000);
}
