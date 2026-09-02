import { type D1, newLongId } from "@server/db";
import type { TaskReviewSubmissionRepository } from "@server/usecases/tasks/replaceTaskReviewSubmission";

export function d1TaskReviewSubmissionRepository(db: D1): TaskReviewSubmissionRepository {
  return {
    async findTarget(ownerId, taskId) {
      const row = await db
        .prepare(`
          SELECT t.status, t.assigned_to, t.assignee_identity_type, t.pr_url,
            submission.id AS submission_id,
            submission.created_at AS submitted_at,
            submission.detail AS submitted_pr_url
          FROM tasks t
          JOIN boards b ON b.id = t.board_id
          LEFT JOIN task_actions submission ON submission.id = (
            SELECT action.id
            FROM task_actions action
            JOIN task_review_submission_order submission_order ON submission_order.submission_id = action.id
            WHERE action.task_id = t.id
              AND action.action = 'review_requested'
              AND action.actor_type = 'realmroot:agent'
              AND action.actor_id = t.assigned_to
            ORDER BY submission_order.ordinal DESC
            LIMIT 1
          )
          WHERE t.id = ? AND b.owner_id = ?
        `)
        .bind(taskId, ownerId)
        .first<{
          status: string;
          assigned_to: string | null;
          assignee_identity_type: string | null;
          pr_url: string | null;
          submission_id: string | null;
          submitted_at: string | null;
          submitted_pr_url: string | null;
        }>();
      return row
        ? {
            status: row.status,
            assignedTo: row.assigned_to,
            assigneeIdentityType: row.assignee_identity_type,
            pullRequestUrl: row.pr_url,
            activeSubmission:
              row.submission_id && row.submitted_at
                ? {
                    actionId: row.submission_id,
                    submittedAt: row.submitted_at,
                    pullRequestUrl: row.submitted_pr_url,
                  }
                : null,
          }
        : null;
    },
    async create(input) {
      const actionId = newLongId();
      const submittedAt = new Date().toISOString();
      const results = await db.batch([
        db
          .prepare(`
            UPDATE tasks SET
              status = 'in_review',
              pr_url = ?,
              updated_at = ?,
              transition_token = ?
            WHERE id = ?
              AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)
              AND status = 'in_progress'
              AND assigned_to = ?
              AND assignee_identity_type = 'realmroot_actor'
              AND transition_token IS NULL
              AND ((pr_url IS NULL AND ? IS NULL) OR pr_url = ?)
              AND NOT EXISTS (
                SELECT 1 FROM task_review_decisions decision
                WHERE decision.task_id = tasks.id AND decision.effect_state = 'pending'
              )
          `)
          .bind(
            input.pullRequestUrl,
            submittedAt,
            actionId,
            input.taskId,
            input.ownerId,
            input.agentActorId,
            input.expectedPullRequestUrl,
            input.expectedPullRequestUrl,
          ),
        db
          .prepare(`
            INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at)
            SELECT ?, ?, 'realmroot:agent', ?, 'review_requested', ?, NULL, ?
            FROM tasks
            WHERE id = ? AND transition_token = ?
          `)
          .bind(actionId, input.taskId, input.agentActorId, input.pullRequestUrl, submittedAt, input.taskId, actionId),
        db
          .prepare(`
            INSERT INTO task_review_submission_order (submission_id)
            SELECT id FROM task_actions WHERE id = ?
          `)
          .bind(actionId),
        db
          .prepare(`
            UPDATE tasks SET transition_token = NULL
            WHERE id = ? AND transition_token = ?
          `)
          .bind(input.taskId, actionId),
      ]);
      return (results[0]?.meta?.changes ?? 0) === 1 ? { actionId, submittedAt, pullRequestUrl: input.pullRequestUrl } : null;
    },
  };
}
