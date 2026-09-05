import { type D1, newLongId } from "@server/db";
import type { TaskAssignmentRepository } from "@server/usecases/tasks/replaceTaskAssignment";

export function d1TaskAssignmentRepository(db: D1): TaskAssignmentRepository {
  return {
    async findTarget(ownerId, taskId) {
      const row = await db
        .prepare(`
          SELECT t.version, t.status, t.assigned_to, t.assignee_identity_type,
            assignment.id AS assignment_id,
            assignment.actor_id AS assigned_by_actor_id,
            assignment.created_at AS assigned_at
          FROM tasks t
          JOIN boards b ON b.id = t.board_id
          LEFT JOIN task_actions assignment ON assignment.id = (
            SELECT action.id
            FROM task_actions action
            WHERE action.task_id = t.id
              AND action.action = 'assigned'
              AND action.actor_type = 'realmroot:agent'
            ORDER BY action.created_at DESC, action.id DESC
            LIMIT 1
          )
          WHERE t.id = ? AND b.owner_id = ?
        `)
        .bind(taskId, ownerId)
        .first<{
          version: number;
          status: string;
          assigned_to: string | null;
          assignee_identity_type: string | null;
          assignment_id: string | null;
          assigned_by_actor_id: string | null;
          assigned_at: string | null;
        }>();
      return row
        ? {
            version: row.version,
            status: row.status,
            assignedTo: row.assigned_to,
            assigneeIdentityType: row.assignee_identity_type,
            activeAssignment:
              row.assignment_id && row.assigned_by_actor_id && row.assigned_at
                ? {
                    actionId: row.assignment_id,
                    assignedByActorId: row.assigned_by_actor_id,
                    assignedAt: row.assigned_at,
                  }
                : null,
          }
        : null;
    },
    async create(input) {
      const actionId = newLongId();
      const assignedAt = new Date().toISOString();
      const results = await db.batch([
        db
          .prepare(`
            UPDATE tasks SET
              assigned_to = ?,
              assignee_identity_type = 'realmroot_actor',
              updated_at = ?,
              version = version + 1,
              transition_token = ?
            WHERE id = ?
              AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)
              AND status = 'todo'
              AND assigned_to IS NULL
              AND transition_token IS NULL
              ${input.expectedTaskVersion !== undefined ? "AND version = ?" : ""}
          `)
          .bind(
            ...[
              input.assigneeActorId,
              assignedAt,
              actionId,
              input.taskId,
              input.ownerId,
              ...(input.expectedTaskVersion === undefined ? [] : [input.expectedTaskVersion]),
            ],
          ),
        db
          .prepare(`
            INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at)
            SELECT ?, ?, 'realmroot:agent', ?, 'assigned', ?, NULL, ?
            FROM tasks
            WHERE id = ?
              AND assigned_to = ?
              AND assignee_identity_type = 'realmroot_actor'
              AND transition_token = ?
          `)
          .bind(
            actionId,
            input.taskId,
            input.assignedByActorId,
            `Assigned to Realmroot Agent ${input.assigneeActorId}`,
            assignedAt,
            input.taskId,
            input.assigneeActorId,
            actionId,
          ),
        db
          .prepare(`
            UPDATE tasks SET transition_token = NULL
            WHERE id = ? AND transition_token = ?
              AND EXISTS (SELECT 1 FROM task_actions action WHERE action.id = ? AND action.task_id = tasks.id)
          `)
          .bind(input.taskId, actionId, actionId),
      ]);
      return (results[0]?.meta?.changes ?? 0) === 1 && (results[2]?.meta?.changes ?? 0) === 1
        ? {
            actionId,
            assignedAt,
            assignedByActorId: input.assignedByActorId,
          }
        : null;
    },
  };
}
