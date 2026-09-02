import { type D1, newLongId } from "@server/db";
import type { TaskClaimDeletionRepository, TaskClaimDeletionTarget } from "@server/usecases/tasks/deleteTaskClaim";

interface TaskClaimDeletionRow {
  status: string;
  assigned_to: string | null;
  assignee_identity_type: string | null;
  active_claim_id: string | null;
  deletion_claim_id: string | null;
  deletion_action_id: string | null;
  deleted_at: string | null;
}

export function d1TaskClaimDeletionRepository(db: D1): TaskClaimDeletionRepository {
  return {
    async findTarget(ownerId, taskId, expectedClaimVersion) {
      const row = await db
        .prepare(`
          SELECT task.status, task.assigned_to, task.assignee_identity_type,
            active_claim.id AS active_claim_id,
            deletion.claim_id AS deletion_claim_id,
            deletion.action_id AS deletion_action_id,
            deletion.deleted_at
          FROM tasks task
          JOIN boards board ON board.id = task.board_id
          LEFT JOIN task_actions active_claim
            ON active_claim.id = task.active_claim_id
            AND active_claim.task_id = task.id
            AND active_claim.action = 'claimed'
            AND active_claim.actor_type = 'realmroot:agent'
            AND active_claim.actor_id = task.assigned_to
          LEFT JOIN task_claim_deletions deletion
            ON deletion.task_id = task.id AND deletion.claim_id = ?
          WHERE task.id = ? AND board.owner_id = ?
        `)
        .bind(expectedClaimVersion, taskId, ownerId)
        .first<TaskClaimDeletionRow>();
      return row ? targetFromRow(row) : null;
    },
    async delete(input) {
      const actionId = newLongId();
      const deletedAt = new Date().toISOString();
      const results = await db.batch([
        db
          .prepare(`
            UPDATE tasks
            SET status = 'todo',
              scheduled_at = NULL,
              creation_token = NULL,
              active_claim_id = NULL,
              updated_at = ?,
              transition_token = ?
            WHERE id = ?
              AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)
              AND status = 'in_progress'
              AND assignee_identity_type = 'realmroot_actor'
              AND assigned_to = ?
              AND active_claim_id = ?
              AND EXISTS (
                SELECT 1 FROM task_actions claim
                WHERE claim.id = tasks.active_claim_id
                  AND claim.task_id = tasks.id
                  AND claim.action = 'claimed'
                  AND claim.actor_type = 'realmroot:agent'
                  AND claim.actor_id = tasks.assigned_to
              )
              AND transition_token IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM task_review_decisions decision
                WHERE decision.task_id = tasks.id AND decision.effect_state = 'pending'
              )
          `)
          .bind(deletedAt, actionId, input.taskId, input.ownerId, input.deletedByActorId, input.expectedClaimVersion),
        db
          .prepare(`
            INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at)
            SELECT ?, ?, 'realmroot:agent', ?, 'released', NULL, NULL, ?
            FROM tasks
            WHERE id = ? AND transition_token = ?
          `)
          .bind(actionId, input.taskId, input.deletedByActorId, deletedAt, input.taskId, actionId),
        db
          .prepare(`
            INSERT INTO task_claim_deletions (claim_id, task_id, action_id, actor_type, actor_id, deleted_at)
            SELECT ?, ?, ?, 'realmroot:agent', ?, ?
            FROM task_actions
            WHERE id = ? AND task_id = ? AND action = 'released'
          `)
          .bind(input.expectedClaimVersion, input.taskId, actionId, input.deletedByActorId, deletedAt, actionId, input.taskId),
        db
          .prepare(`
            DELETE FROM task_session_bindings
            WHERE task_id = ? AND claim_action_id = ?
              AND EXISTS (
                SELECT 1 FROM tasks
                WHERE id = ? AND transition_token = ?
              )
          `)
          .bind(input.taskId, input.expectedClaimVersion, input.taskId, actionId),
        db.prepare("UPDATE tasks SET transition_token = NULL WHERE id = ? AND transition_token = ?").bind(input.taskId, actionId),
      ]);
      return (results[0]?.meta?.changes ?? 0) === 1 ? { claimVersion: input.expectedClaimVersion, actionId, deletedAt } : null;
    },
  };
}

function targetFromRow(row: TaskClaimDeletionRow): TaskClaimDeletionTarget {
  return {
    status: row.status,
    assignedTo: row.assigned_to,
    assigneeIdentityType: row.assignee_identity_type,
    activeClaimVersion: row.active_claim_id,
    matchingDeletion:
      row.deletion_claim_id && row.deletion_action_id && row.deleted_at
        ? { claimVersion: row.deletion_claim_id, actionId: row.deletion_action_id, deletedAt: row.deleted_at }
        : null,
  };
}
