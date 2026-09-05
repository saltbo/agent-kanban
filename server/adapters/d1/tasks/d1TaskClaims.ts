import { completeIdempotencyWhen, type ResourceIdempotency } from "@server/adapters/d1/resourceIdempotency";
import { type D1, newLongId } from "@server/db";
import type { TaskClaim, TaskClaimCommit, TaskClaimRepository } from "@server/usecases/tasks/replaceTaskClaim";

interface CommitTaskClaimInput {
  ownerId?: string;
  taskId: string;
  actorType: string;
  actorId: string;
  runtime: string;
  runtimeSessionId: string;
}

export async function commitTaskClaim(
  db: D1,
  input: CommitTaskClaimInput,
  idempotency?: ResourceIdempotency<TaskClaim>,
): Promise<TaskClaimCommit | null> {
  const claimedAt = new Date().toISOString();
  const actionId = newLongId();
  const ownerGuard = input.ownerId ? "AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)" : "";
  const updateBindings: unknown[] = [claimedAt, actionId, input.taskId, input.actorId];
  if (input.ownerId) updateBindings.push(input.ownerId);
  updateBindings.push(input.runtimeSessionId);

  const canonicalClaim: TaskClaim = {
    id: actionId,
    taskId: input.taskId,
    agentActorId: input.actorId,
    runtime: input.runtime,
    runtimeSessionId: input.runtimeSessionId,
    claimedAt,
  };
  const statements = [
    db
      .prepare(`
        UPDATE tasks SET
          status = 'in_progress',
          creation_token = NULL,
          updated_at = ?,
          version = version + 1,
          transition_token = ?
        WHERE id = ? AND status = 'todo' AND assigned_to = ?
          AND assignee_identity_type = 'realmroot_actor'
          AND transition_token IS NULL
          ${ownerGuard}
          AND active_claim_id IS NULL
          AND scheduled_at IS NULL
          AND json_extract(metadata, '$."agent-kanban.dev/launch".replacement_actor_id') IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM task_dependencies td JOIN tasks dep ON dep.id = td.depends_on
            WHERE td.task_id = tasks.id AND dep.status NOT IN ('done', 'cancelled')
          )
          AND (json_extract(metadata, '$."agent-kanban.dev/launch".id') IS NULL OR (
            json_extract(metadata, '$."agent-kanban.dev/launch".state') = 'started'
            AND json_extract(metadata, '$.annotations."agent-kanban.dev/session-id"') = ?
          ))
      `)
      .bind(...updateBindings),
    db
      .prepare(`
        INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at)
        SELECT ?, ?, ?, ?, 'claimed', NULL, ?, ?
        FROM tasks
        WHERE id = ? AND transition_token = ?
      `)
      .bind(actionId, input.taskId, input.actorType, input.actorId, input.runtimeSessionId, claimedAt, input.taskId, actionId),
    db
      .prepare(`
        INSERT INTO task_session_bindings (
          task_id, claim_action_id, agent_actor_id, runtime, runtime_session_id, bound_at
        )
        SELECT ?, ?, ?, ?, ?, ?
        FROM tasks
        WHERE id = ? AND transition_token = ?
      `)
      .bind(input.taskId, actionId, input.actorId, input.runtime, input.runtimeSessionId, claimedAt, input.taskId, actionId),
    ...(idempotency
      ? [
          completeIdempotencyWhen(
            db,
            idempotency,
            actionId,
            canonicalClaim,
            "SELECT 1 FROM task_actions WHERE id = ? AND task_id = ? AND action = 'claimed'",
            [actionId, input.taskId],
          ),
        ]
      : []),
    db
      .prepare(`
        UPDATE tasks SET active_claim_id = ?
        WHERE id = ? AND transition_token = ?
      `)
      .bind(actionId, input.taskId, actionId),
    db
      .prepare(`
        UPDATE tasks SET transition_token = NULL
        WHERE id = ? AND transition_token = ?
      `)
      .bind(input.taskId, actionId),
  ];
  const results = await db.batch(statements);

  return (results[0]?.meta?.changes ?? 0) === 1 && (results[2]?.meta?.changes ?? 0) === 1
    ? { actionId, claimedAt, runtime: input.runtime, runtimeSessionId: input.runtimeSessionId }
    : null;
}

export function d1TaskClaimRepository(db: D1, idempotency?: ResourceIdempotency<TaskClaim>): TaskClaimRepository {
  return {
    async findTarget(ownerId, taskId) {
      const row = await db
        .prepare(`
          SELECT t.status, t.assigned_to, t.assignee_identity_type,
            claim.id AS claim_id,
            claim.created_at AS claimed_at,
            binding.runtime,
            binding.runtime_session_id
          FROM tasks t
          JOIN boards b ON b.id = t.board_id
          LEFT JOIN task_actions claim
            ON claim.id = t.active_claim_id
            AND claim.task_id = t.id
            AND claim.action = 'claimed'
            AND claim.actor_id = t.assigned_to
          LEFT JOIN task_session_bindings binding
            ON binding.task_id = t.id
            AND binding.claim_action_id = claim.id
          WHERE t.id = ? AND b.owner_id = ?
        `)
        .bind(taskId, ownerId)
        .first<{
          status: string;
          assigned_to: string | null;
          assignee_identity_type: string | null;
          claim_id: string | null;
          claimed_at: string | null;
          runtime: string | null;
          runtime_session_id: string | null;
        }>();
      return row
        ? {
            status: row.status,
            assignedTo: row.assigned_to,
            assigneeIdentityType: row.assignee_identity_type,
            activeClaim:
              row.claim_id && row.claimed_at && row.runtime && row.runtime_session_id
                ? {
                    actionId: row.claim_id,
                    claimedAt: row.claimed_at,
                    runtime: row.runtime,
                    runtimeSessionId: row.runtime_session_id,
                  }
                : null,
          }
        : null;
    },
    create(input) {
      return commitTaskClaim(
        db,
        {
          ownerId: input.ownerId,
          taskId: input.taskId,
          actorType: "realmroot:agent",
          actorId: input.agentActorId,
          runtime: input.runtime,
          runtimeSessionId: input.runtimeSessionId,
        },
        idempotency,
      );
    },
  };
}
