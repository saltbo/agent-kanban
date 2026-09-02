import { type D1, newLongId } from "@server/db";
import type { StoredTaskCancellation, TaskCancellationActor, TaskCancellationRepository } from "@server/usecases/tasks/replaceTaskCancellation";

export function d1TaskCancellationRepository(db: D1): TaskCancellationRepository {
  return {
    async findTarget(ownerId, taskId) {
      const row = await db
        .prepare(`
          SELECT t.status, t.assigned_to, t.assignee_identity_type,
            cancellation.id AS cancellation_id,
            cancellation.actor_type AS cancellation_actor_type,
            cancellation.actor_id AS cancellation_actor_id,
            cancellation.detail AS cancellation_assignee_actor_id,
            cancellation.created_at AS cancelled_at
          FROM tasks t
          JOIN boards b ON b.id = t.board_id
          LEFT JOIN task_actions cancellation ON cancellation.id = (
            SELECT action.id
            FROM task_actions action
            WHERE action.task_id = t.id AND action.action = 'cancelled'
            LIMIT 1
          )
          WHERE t.id = ? AND b.owner_id = ?
        `)
        .bind(taskId, ownerId)
        .first<{
          status: string;
          assigned_to: string | null;
          assignee_identity_type: string | null;
          cancellation_id: string | null;
          cancellation_actor_type: string | null;
          cancellation_actor_id: string | null;
          cancellation_assignee_actor_id: string | null;
          cancelled_at: string | null;
        }>();
      if (!row) return null;
      return {
        status: row.status,
        assignedTo: row.assigned_to,
        assigneeIdentityType: row.assignee_identity_type,
        cancellation:
          row.cancellation_id && row.cancellation_actor_type && row.cancellation_actor_id && row.cancelled_at
            ? {
                actionId: row.cancellation_id,
                actorType: cancellationActorType(row.cancellation_actor_type),
                actorId: row.cancellation_actor_id,
                cancelledAt: row.cancelled_at,
                assigneeActorId: row.cancellation_assignee_actor_id,
              }
            : null,
      };
    },
    async create(input) {
      const actionId = newLongId();
      const cancelledAt = new Date().toISOString();
      const actorType = storedActorType(input.actor);
      const results = await db.batch([
        db
          .prepare(`
            UPDATE tasks
            SET status = 'cancelled',
              assigned_to = NULL,
              assignee_identity_type = NULL,
              creation_token = NULL,
              active_claim_id = NULL,
              updated_at = ?,
              transition_token = ?
            WHERE id = ?
              AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)
              AND status IN ('todo', 'in_progress', 'in_review')
              AND transition_token IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM task_review_decisions decision
                WHERE decision.task_id = tasks.id AND decision.effect_state = 'pending'
              )
          `)
          .bind(cancelledAt, actionId, input.taskId, input.ownerId),
        db
          .prepare(`
            INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at)
            SELECT ?, ?, ?, ?, 'cancelled', ?, NULL, ?
            FROM tasks
            WHERE id = ? AND transition_token = ?
          `)
          .bind(actionId, input.taskId, actorType, input.actor.id, input.assigneeActorId, cancelledAt, input.taskId, actionId),
        db.prepare("UPDATE tasks SET transition_token = NULL WHERE id = ? AND transition_token = ?").bind(input.taskId, actionId),
      ]);
      return (results[0]?.meta?.changes ?? 0) === 1
        ? {
            actionId,
            actorType: input.actor.type,
            actorId: input.actor.id,
            cancelledAt,
            assigneeActorId: input.assigneeActorId,
          }
        : null;
    },
  };
}

function storedActorType(actor: TaskCancellationActor): "realmroot:agent" | "user" | "system" {
  if (actor.type === "agent") return "realmroot:agent";
  if (actor.type === "human") return "user";
  return "system";
}

function cancellationActorType(actorType: string): StoredTaskCancellation["actorType"] {
  if (actorType === "realmroot:agent") return "agent";
  if (actorType === "user") return "human";
  return "system";
}
