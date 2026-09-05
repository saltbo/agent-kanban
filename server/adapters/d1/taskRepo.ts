import { getDefaultBoard } from "@server/adapters/d1/boardRepo";
import { recordBoardRepository } from "@server/adapters/d1/boardRepositoryRepo";
import {
  completeIdempotency,
  type ResourceIdempotency,
  ResourceIdempotencyReplay,
  resolveIdempotentResponse,
} from "@server/adapters/d1/resourceIdempotency";
import { computeBlocked, detectCycle, getDependencies, setDependencies } from "@server/adapters/d1/taskDeps";
import { mapTaskRow as parseTask } from "@server/adapters/d1/tasks/taskRow";
import { type D1, MAX_TASK_PARTITION_ROWS, newLongId } from "@server/db";
import type { PageWindow } from "@server/domain/pagination";
import { ApplicationError } from "@server/usecases/applicationError";
import type { BoardAction, CreateTaskInput, Task, TaskAction, TaskActionType, TaskActionWriteActorType, TaskWithNotes } from "@shared";

const TASK_ACTION_WRITE_ACTOR_TYPES = new Set<TaskActionWriteActorType>(["user", "machine", "service", "realmroot:agent", "system"]);

function assertTaskActionWriteActorType(actorType: TaskActionWriteActorType): void {
  if (!TASK_ACTION_WRITE_ACTOR_TYPES.has(actorType)) {
    throw new TypeError(`Unsupported v2 Task action actor type: ${actorType}`);
  }
}

async function assertKnownLabels(db: D1, boardId: string, labels: string[] | null | undefined): Promise<void> {
  if (!labels?.length) return;
  const board = await db.prepare("SELECT labels FROM boards WHERE id = ?").bind(boardId).first<{ labels: string }>();
  if (!board) throw new ApplicationError("invalid-request", "Board not found");
  const knownLabels = new Set((JSON.parse(board.labels) as { name: string }[]).map((label) => label.name));
  const unknown = labels.find((label) => !knownLabels.has(label));
  if (unknown) throw new ApplicationError("invalid-request", `Label not found: ${unknown}`);
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
  if (!row) throw new ApplicationError("not-found", "Repository not found");
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
  if (row?.count !== ids.length) throw new ApplicationError("invalid-request", message);
}

export async function createTask(
  db: D1,
  ownerId: string,
  input: CreateTaskInput & {
    actorType?: TaskActionWriteActorType;
    actorId?: string;
  },
  idempotency?: ResourceIdempotency<Task>,
  sequenceAttempt = 0,
): Promise<Task> {
  const actorType = input.actorType ?? "system";
  const actorId = input.actorId ?? "system";
  assertTaskActionWriteActorType(actorType);
  const board = input.board_id
    ? await db
        .prepare("SELECT id, type FROM boards WHERE id = ? AND owner_id = ?")
        .bind(input.board_id, ownerId)
        .first<{ id: string; type: string }>()
    : await getDefaultBoard(db, ownerId);

  if (!board) throw new ApplicationError("invalid-request", input.board_id ? "Board not found" : "No board exists. Create a board first.");

  if (board.type === "dev" && !input.repository_id) {
    throw new ApplicationError("invalid-request", "repository_id is required for dev board tasks");
  }
  if (board.type === "ops" && input.repository_id) {
    throw new ApplicationError("invalid-request", "repository_id is not allowed for ops board tasks");
  }
  if (input.repository_id) await assertRepositoryBelongsToBoardOwner(db, board.id, input.repository_id);

  const taskId = newLongId();
  const logId = newLongId();
  const now = new Date().toISOString();
  const labelsJson = input.labels ? JSON.stringify(input.labels) : null;
  const inputJson = input.input ? JSON.stringify(input.input) : null;
  const taskMetadata = input.metadata ?? {};
  const metadataJson = JSON.stringify(taskMetadata);

  if (input.depends_on?.length) {
    await assertOwnedTaskIds(db, ownerId, input.depends_on, "Dependency task not found");
    const hasCycle = await detectCycle(db, taskId, input.depends_on);
    if (hasCycle) throw new ApplicationError("invalid-request", "Circular dependency detected");
  }

  if (input.created_from) {
    await assertOwnedTaskIds(db, ownerId, [input.created_from], "Parent task not found");
  }

  await assertKnownLabels(db, board.id, input.labels);

  const allocation = await db
    .prepare(
      `SELECT b.task_seq + 1 AS seq,
              COALESCE(MAX(CASE WHEN t.status = 'todo' THEN t.position END), -1) + 1 AS position,
              b.task_seq AS expected_task_seq
       FROM boards b
       LEFT JOIN tasks t ON t.board_id = b.id
       WHERE b.id = ? AND b.owner_id = ?
       GROUP BY b.id`,
    )
    .bind(board.id, ownerId)
    .first<{ seq: number; position: number; expected_task_seq: number }>();
  if (!allocation) throw new ApplicationError("invalid-request", "Board not found");

  const blocked = input.depends_on?.length
    ? ((
        await db
          .prepare(
            `SELECT COUNT(*) AS count FROM tasks WHERE id IN (${input.depends_on.map(() => "?").join(",")}) AND status NOT IN ('done', 'cancelled')`,
          )
          .bind(...input.depends_on)
          .first<{ count: number }>()
      )?.count ?? 0) > 0
    : false;
  const createdTask: Task & { depends_on: string[] } = {
    id: taskId,
    version: 1,
    board_id: board.id,
    seq: allocation.seq,
    status: "todo",
    title: input.title,
    description: input.description || null,
    repository_id: input.repository_id || null,
    labels: input.labels ?? null,
    created_by: actorId,
    assigned_to: null,
    assignee_identity_type: null,
    pr_url: null,
    input: input.input ?? null,
    metadata: taskMetadata,
    created_from: input.created_from || null,
    scheduled_at: input.scheduled_at || null,
    position: allocation.position,
    created_at: now,
    updated_at: now,
    blocked,
    depends_on: input.depends_on ?? [],
  };

  const stmts = [
    db
      .prepare("UPDATE boards SET task_seq = ? WHERE id = ? AND owner_id = ? AND task_seq = ?")
      .bind(allocation.seq, board.id, ownerId, allocation.expected_task_seq),
    db
      .prepare(`
      INSERT INTO tasks (id, board_id, seq, status, title, description, repository_id, labels, created_by, assigned_to, assignee_identity_type, result, pr_url, input, metadata, created_from, scheduled_at, position, created_at, updated_at)
      VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        taskId,
        board.id,
        allocation.seq,
        input.title,
        input.description || null,
        input.repository_id || null,
        labelsJson,
        actorId,
        inputJson,
        metadataJson,
        input.created_from || null,
        input.scheduled_at || null,
        allocation.position,
        now,
        now,
      ),
    db
      .prepare(
        "INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at) VALUES (?, ?, ?, ?, 'created', NULL, NULL, ?)",
      )
      .bind(logId, taskId, actorType, actorId, now),
    ...(input.created_from
      ? [
          db
            .prepare(`
              UPDATE tasks
              SET version = version + 1, updated_at = ?
              WHERE id = ?
                AND EXISTS (SELECT 1 FROM tasks child WHERE child.id = ? AND child.created_from = tasks.id)
            `)
            .bind(now, input.created_from, taskId),
        ]
      : []),
    ...(input.depends_on || []).map((depId) => db.prepare("INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)").bind(taskId, depId)),
    ...(input.repository_id
      ? [db.prepare("INSERT OR IGNORE INTO board_repositories (board_id, repository_id) VALUES (?, ?)").bind(board.id, input.repository_id)]
      : []),
    ...(idempotency ? [completeIdempotency(db, idempotency, taskId, createdTask)] : []),
  ];

  try {
    await db.batch(stmts);
  } catch (error) {
    if (idempotency) {
      const replay = await resolveIdempotentResponse(db, idempotency);
      if (replay) throw new ResourceIdempotencyReplay(replay);
    }
    const sequenceRace = error instanceof Error && error.message.includes("tasks.board_id, tasks.seq");
    if (sequenceRace && sequenceAttempt < 4) return createTask(db, ownerId, input, idempotency, sequenceAttempt + 1);
    if (sequenceRace) throw new ApplicationError("conflict", "Task sequence allocation conflicted; retry the request");
    throw error;
  }
  if (idempotency) return createdTask;
  const created = await getTask(db, taskId, ownerId);
  if (!created) throw new Error("Task creation committed without a readable Task");
  return created;
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
  query += " ORDER BY t.position";

  const stmt = db.prepare(query);
  const result = await (binds.length ? stmt.bind(...binds) : stmt).all<Task>();
  return hydrateListedTasks(db, result.results.map(parseTask));
}

export async function listTaskPage(
  db: D1,
  ownerId: string,
  filters: {
    repository_id?: string;
    status?: string;
    label?: string;
    board_id?: string;
    parent?: string;
    assigned_to?: string;
  },
  window: PageWindow,
): Promise<Task[]> {
  let query = `
    SELECT t.*, r.name as repository_name, b.type as board_type FROM tasks t
    LEFT JOIN repositories r ON t.repository_id = r.id
    JOIN boards b ON t.board_id = b.id
    WHERE b.owner_id = ? AND t.created_at <= ?`;
  const binds: unknown[] = [ownerId, window.snapshot];
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
  if (window.afterCreatedAt && window.afterId) {
    query += " AND (t.created_at < ? OR (t.created_at = ? AND t.id < ?))";
    binds.push(window.afterCreatedAt, window.afterCreatedAt, window.afterId);
  }
  query += " ORDER BY t.created_at DESC, t.id DESC LIMIT ?";
  binds.push(window.pageSize + 1);
  const result = await db
    .prepare(query)
    .bind(...binds)
    .all<Task>();
  return hydrateListedTasks(db, result.results.map(parseTask));
}

async function hydrateListedTasks(db: D1, tasks: Task[]): Promise<Task[]> {
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
    SELECT t.*, r.name as repository_name, b.type AS board_type,
      (SELECT COUNT(*) FROM tasks sub WHERE sub.created_from = t.id) as subtask_count
    FROM tasks t
    LEFT JOIN repositories r ON t.repository_id = r.id
    JOIN boards b ON t.board_id = b.id
    WHERE t.id = ? AND b.owner_id = ?
  `)
    .bind(taskId, ownerId)
    .first<Task & { subtask_count: number }>();
  if (!task) return null;
  parseTask(task);

  const [actions, deps, blockedSet, sessionBinding] = await Promise.all([
    getTaskActions(db, taskId),
    getDependencies(db, taskId),
    computeBlocked(db, [taskId]),
    db
      .prepare(`
        SELECT agent_actor_id, runtime, runtime_session_id, bound_at
        FROM task_session_bindings
        WHERE task_id = ?
      `)
      .bind(taskId)
      .first<{ agent_actor_id: string; runtime: string; runtime_session_id: string; bound_at: string }>(),
  ]);

  const duration = computeDuration(actions);
  task.blocked = blockedSet.has(taskId);

  return {
    ...task,
    session_binding: sessionBinding,
    notes: actions,
    duration_minutes: duration,
    depends_on: deps,
    subtask_count: task.subtask_count,
  };
}

export async function updateTask(
  db: D1,
  taskId: string,
  updates: Partial<Pick<Task, "title" | "description" | "repository_id" | "labels" | "pr_url" | "input" | "position" | "scheduled_at">> & {
    metadata?: Record<string, unknown>;
    depends_on?: string[];
  },
  ownerId?: string,
  expectedVersion?: number,
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
      if (hasCycle) throw new ApplicationError("invalid-request", "Circular dependency detected");
    }
  }
  if (updates.labels !== undefined) {
    await assertKnownLabels(db, task.board_id, updates.labels);
  }
  if (updates.repository_id) {
    await assertRepositoryBelongsToBoardOwner(db, task.board_id, updates.repository_id);
  }

  const now = new Date().toISOString();
  const sets: string[] = ["updated_at = ?", "version = version + 1"];
  const binds: unknown[] = [now];
  const transitionToken = expectedVersion !== undefined && updates.depends_on !== undefined ? newLongId() : null;
  if (transitionToken) {
    sets.push("transition_token = ?");
    binds.push(transitionToken);
  }

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
  if (expectedVersion !== undefined) binds.push(expectedVersion);
  const updateStatement = db
    .prepare(
      `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?${ownerId ? " AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)" : ""}${
        expectedVersion !== undefined ? " AND version = ? AND transition_token IS NULL" : ""
      }`,
    )
    .bind(...binds);
  const results = transitionToken
    ? await db.batch([
        updateStatement,
        db
          .prepare("DELETE FROM task_dependencies WHERE task_id = ? AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND transition_token = ?)")
          .bind(taskId, taskId, transitionToken),
        ...updates.depends_on!.map((dependencyId) =>
          db
            .prepare(
              "INSERT INTO task_dependencies (task_id, depends_on) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND transition_token = ?)",
            )
            .bind(taskId, dependencyId, taskId, transitionToken),
        ),
        db.prepare("UPDATE tasks SET transition_token = NULL WHERE id = ? AND transition_token = ?").bind(taskId, transitionToken),
      ])
    : [await updateStatement.run()];
  if ((results[0]?.meta?.changes ?? 0) !== 1) return null;
  if (!transitionToken && updates.depends_on !== undefined) await setDependencies(db, taskId, updates.depends_on);
  if (updates.repository_id) await recordBoardRepository(db, task.board_id, updates.repository_id);
  const updated = await db
    .prepare(`SELECT tasks.* FROM tasks WHERE id = ?${ownerId ? " AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)" : ""}`)
    .bind(...(ownerId ? [taskId, ownerId] : [taskId]))
    .first<Task>();
  return updated ? parseTask(updated) : null;
}

export async function deleteTask(db: D1, taskId: string, ownerId: string, expectedVersion?: number): Promise<boolean> {
  const task = await db
    .prepare(
      `SELECT t.status, t.assigned_to, t.created_from FROM tasks t
       JOIN boards b ON b.id = t.board_id
       WHERE t.id = ? AND b.owner_id = ?`,
    )
    .bind(taskId, ownerId)
    .first<{ status: string; assigned_to: string | null; created_from: string | null }>();
  if (!task) return false;

  const canDelete = task.status === "todo" || task.status === "cancelled";
  if (!canDelete) {
    throw new ApplicationError("conflict", `Cannot delete task in ${task.status}${task.assigned_to ? " (assigned)" : ""} status`);
  }

  if (expectedVersion !== undefined) {
    const transitionToken = newLongId();
    const now = new Date().toISOString();
    const results = await db.batch([
      db
        .prepare(`
          UPDATE tasks SET transition_token = ?
          WHERE id = ?
            AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)
            AND status IN ('todo', 'cancelled')
            AND version = ?
            AND transition_token IS NULL
        `)
        .bind(transitionToken, taskId, ownerId, expectedVersion),
      ...(task.created_from
        ? [
            db
              .prepare(`
                UPDATE tasks
                SET version = version + 1, updated_at = ?
                WHERE id = ?
                  AND EXISTS (SELECT 1 FROM tasks child WHERE child.id = ? AND child.transition_token = ?)
              `)
              .bind(now, task.created_from, taskId, transitionToken),
          ]
        : []),
      db
        .prepare(`
          UPDATE tasks
          SET version = version + 1, updated_at = ?
          WHERE id IN (SELECT task_id FROM task_dependencies WHERE depends_on = ?)
            AND EXISTS (SELECT 1 FROM tasks dependency WHERE dependency.id = ? AND dependency.transition_token = ?)
        `)
        .bind(now, taskId, taskId, transitionToken),
      db
        .prepare(`
          UPDATE tasks
          SET version = version + 1, updated_at = ?
          WHERE created_from = ?
            AND EXISTS (SELECT 1 FROM tasks parent WHERE parent.id = ? AND parent.transition_token = ?)
        `)
        .bind(now, taskId, taskId, transitionToken),
      db.prepare("DELETE FROM tasks WHERE id = ? AND transition_token = ?").bind(taskId, transitionToken),
    ]);
    return (results[0]?.meta?.changes ?? 0) === 1;
  }

  const result = await db
    .prepare(`
      DELETE FROM tasks
      WHERE id = ?
        AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)
        AND status IN ('todo', 'cancelled')
    `)
    .bind(taskId, ownerId)
    .run();
  if (result.meta.changes > 0) return true;

  const current = await db
    .prepare("SELECT status FROM tasks WHERE id = ? AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)")
    .bind(taskId, ownerId)
    .first<{ status: string }>();
  if (!current) return false;
  throw new ApplicationError("conflict", `Cannot delete task in ${current.status} status`);
}

export async function addTaskAction(
  db: D1,
  taskId: string,
  actorType: TaskActionWriteActorType,
  actorId: string,
  action: TaskActionType,
  detail: string | null,
  sessionId: string | null = null,
  idempotency?: ResourceIdempotency<TaskAction>,
): Promise<TaskAction> {
  assertTaskActionWriteActorType(actorType);
  const actionId = newLongId();
  const now = new Date().toISOString();

  const insertion = db
    .prepare("INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(actionId, taskId, actorType, actorId, action, detail, sessionId, now);
  const taskAction: TaskAction = {
    id: actionId,
    task_id: taskId,
    actor_type: actorType,
    actor_id: actorId,
    actor_name: null,
    action,
    detail,
    session_id: sessionId,
    created_at: now,
  };
  try {
    await db.batch([
      insertion,
      db.prepare("UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ?").bind(now, taskId),
      ...(idempotency ? [completeIdempotency(db, idempotency, actionId, taskAction)] : []),
    ]);
  } catch (error) {
    if (!idempotency) throw error;
    const replay = await resolveIdempotentResponse(db, idempotency);
    if (!replay) throw error;
    throw new ResourceIdempotencyReplay(replay);
  }
  return taskAction;
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
  const base = "SELECT n.* FROM task_actions n WHERE n.task_id = ?";

  if (since) {
    const result = await db.prepare(`${base} AND n.created_at > ? ORDER BY n.created_at ASC LIMIT ?`).bind(taskId, since, limit).all<TaskAction>();
    return result.results;
  }
  const result = await db.prepare(`${base} ORDER BY n.created_at DESC LIMIT ?`).bind(taskId, limit).all<TaskAction>();
  return result.results.reverse();
}

export async function getTaskAction(db: D1, taskId: string, actionId: string): Promise<TaskAction | null> {
  return db.prepare("SELECT * FROM task_actions WHERE task_id = ? AND id = ?").bind(taskId, actionId).first<TaskAction>();
}

export async function getTaskNotes(db: D1, taskId: string, since?: string, limit: number = MAX_TASK_PARTITION_ROWS): Promise<TaskAction[]> {
  const base = "SELECT n.* FROM task_actions n WHERE n.task_id = ? AND n.action = 'commented'";
  if (since) {
    const result = await db.prepare(`${base} AND n.created_at > ? ORDER BY n.created_at ASC LIMIT ?`).bind(taskId, since, limit).all<TaskAction>();
    return result.results;
  }
  const result = await db.prepare(`${base} ORDER BY n.created_at DESC LIMIT ?`).bind(taskId, limit).all<TaskAction>();
  return result.results.reverse();
}

export async function listTaskNotePage(db: D1, taskId: string, window: PageWindow, since?: string): Promise<TaskAction[]> {
  let query = "SELECT n.* FROM task_actions n WHERE n.task_id = ? AND n.action = 'commented' AND n.created_at <= ?";
  const binds: unknown[] = [taskId, window.snapshot];
  if (since) {
    query += " AND n.created_at > ?";
    binds.push(since);
  }
  if (window.afterCreatedAt && window.afterId) {
    query += " AND (n.created_at < ? OR (n.created_at = ? AND n.id < ?))";
    binds.push(window.afterCreatedAt, window.afterCreatedAt, window.afterId);
  }
  query += " ORDER BY n.created_at DESC, n.id DESC LIMIT ?";
  binds.push(window.pageSize + 1);
  const result = await db
    .prepare(query)
    .bind(...binds)
    .all<TaskAction>();
  return result.results;
}

export async function getBoardActionsByBoardId(db: D1, boardId: string, since: string): Promise<BoardAction[]> {
  const result = await db
    .prepare(`
      SELECT n.*
      FROM task_actions n
      JOIN tasks t ON n.task_id = t.id
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
      SELECT n.*
      FROM task_actions n
      JOIN tasks t ON n.task_id = t.id
      JOIN boards b ON t.board_id = b.id
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
