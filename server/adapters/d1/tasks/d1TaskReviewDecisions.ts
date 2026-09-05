import { type D1, newLongId } from "@server/db";
import type { TaskReviewDecisionActor } from "@server/domain/tasks/taskReviewDecisionAuthority";
import type { StoredTaskReviewDecision, TaskReviewDecisionRepository } from "@server/usecases/tasks/replaceTaskReviewDecision";

interface DecisionRow {
  kind: "rejection" | "completion";
  reason: string | null;
  actor_type: "user" | "machine" | "service" | "realmroot:agent" | "system";
  actor_id: string;
  reservation_id: string;
  state: "pending" | "accepted";
  effect_state: "pending" | "delivered";
  action_id: string | null;
  created_at: string;
  decided_at: string | null;
  effect_delivered_at: string | null;
}

export function d1TaskReviewDecisionRepository(db: D1): TaskReviewDecisionRepository {
  const repository: TaskReviewDecisionRepository = {
    async findCurrentTarget(ownerId, taskId) {
      const current = await db
        .prepare(`
          SELECT action.id
          FROM task_actions action
          JOIN task_review_submission_order submission_order ON submission_order.submission_id = action.id
          JOIN tasks task ON task.id = action.task_id
          JOIN boards board ON board.id = task.board_id
          WHERE task.id = ?
            AND board.owner_id = ?
            AND action.action = 'review_requested'
            AND action.actor_type = 'realmroot:agent'
            AND action.actor_id = task.assigned_to
          ORDER BY submission_order.ordinal DESC
          LIMIT 1
        `)
        .bind(taskId, ownerId)
        .first<{ id: string }>();
      return repository.findTarget(ownerId, taskId, current?.id ?? "__no_review_submission__");
    },
    async findTarget(ownerId, taskId, reviewSubmissionVersion) {
      const row = await db
        .prepare(`
          SELECT t.id, t.version, t.status, t.assigned_to, t.assignee_identity_type,
            active_submission.id AS active_submission_version,
            decision.kind, decision.reason, decision.actor_type, decision.actor_id,
            decision.reservation_id, decision.state, decision.effect_state,
            decision.action_id, decision.created_at, decision.decided_at,
            decision.effect_delivered_at
          FROM tasks t
          JOIN boards b ON b.id = t.board_id
          LEFT JOIN task_actions active_submission ON active_submission.id = (
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
          LEFT JOIN task_review_decisions decision
            ON decision.review_submission_id = ? AND decision.task_id = t.id
          WHERE t.id = ? AND b.owner_id = ?
        `)
        .bind(reviewSubmissionVersion, taskId, ownerId)
        .first<{
          id: string;
          version: number;
          status: string;
          assigned_to: string | null;
          assignee_identity_type: string | null;
          active_submission_version: string | null;
          kind: DecisionRow["kind"] | null;
          reason: string | null;
          actor_type: DecisionRow["actor_type"] | null;
          actor_id: string | null;
          reservation_id: string | null;
          state: DecisionRow["state"] | null;
          effect_state: DecisionRow["effect_state"] | null;
          action_id: string | null;
          created_at: string | null;
          decided_at: string | null;
          effect_delivered_at: string | null;
        }>();
      if (!row) return null;
      return {
        taskId: row.id,
        version: row.version,
        status: row.status,
        assignedTo: row.assigned_to,
        assigneeIdentityType: row.assignee_identity_type,
        activeReviewSubmissionVersion: row.active_submission_version,
        decision:
          row.kind && row.actor_type && row.actor_id && row.reservation_id && row.state && row.effect_state && row.created_at
            ? storedDecision({
                kind: row.kind,
                reason: row.reason,
                actor_type: row.actor_type,
                actor_id: row.actor_id,
                reservation_id: row.reservation_id,
                state: row.state,
                effect_state: row.effect_state,
                action_id: row.action_id,
                created_at: row.created_at,
                decided_at: row.decided_at,
                effect_delivered_at: row.effect_delivered_at,
              })
            : null,
      };
    },
    async reserve(input) {
      const reservationId = newLongId();
      const createdAt = new Date().toISOString();
      const actorType = storedActorType(input.actor);
      const results = await db.batch([
        db
          .prepare(`
            UPDATE tasks SET transition_token = ?
            WHERE id = ?
              AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)
              AND status = 'in_review'
              AND assigned_to = ?
              AND assignee_identity_type = 'realmroot_actor'
              AND transition_token IS NULL
              AND ? = (
                SELECT action.id
                FROM task_actions action
                JOIN task_review_submission_order submission_order ON submission_order.submission_id = action.id
                WHERE action.task_id = tasks.id
                  AND action.action = 'review_requested'
                  AND action.actor_type = 'realmroot:agent'
                  AND action.actor_id = tasks.assigned_to
                ORDER BY submission_order.ordinal DESC
                LIMIT 1
              )
              ${input.expectedTaskVersion !== undefined ? "AND version = ?" : ""}
          `)
          .bind(
            ...[
              reservationId,
              input.taskId,
              input.ownerId,
              input.expectedAssignedTo,
              input.reviewSubmissionVersion,
              ...(input.expectedTaskVersion === undefined ? [] : [input.expectedTaskVersion]),
            ],
          ),
        db
          .prepare(`
            INSERT INTO task_review_decisions (
              review_submission_id, task_id, kind, reason, actor_type, actor_id,
              reservation_id, state, created_at
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?
            FROM tasks
            WHERE id = ? AND transition_token = ?
          `)
          .bind(
            input.reviewSubmissionVersion,
            input.taskId,
            input.kind,
            input.reason,
            actorType,
            input.actor.id,
            reservationId,
            createdAt,
            input.taskId,
            reservationId,
          ),
      ]);
      return (results[0]?.meta?.changes ?? 0) === 1
        ? {
            kind: input.kind,
            reason: input.reason,
            actor: input.actor,
            reservationId,
            state: "pending",
            effectState: "pending",
            actionId: null,
            createdAt,
            decidedAt: null,
            effectDeliveredAt: null,
          }
        : null;
    },
    async finalize(input) {
      const actionId = newLongId();
      const decidedAt = new Date().toISOString();
      const status = input.decision.kind === "rejection" ? "in_progress" : "done";
      const action = input.decision.kind === "rejection" ? "rejected" : "completed";
      const actorType = storedActorType(input.decision.actor);
      const results = await db.batch([
        db
          .prepare(`
            UPDATE tasks
            SET status = ?,
              active_claim_id = CASE WHEN ? = 'done' THEN NULL ELSE active_claim_id END,
              updated_at = ?,
              version = version + 1
            WHERE id = ?
              AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)
              AND status = 'in_review'
              AND assigned_to = ?
              AND assignee_identity_type = 'realmroot_actor'
              AND transition_token = ?
              AND EXISTS (
                SELECT 1 FROM task_review_decisions decision
                WHERE decision.review_submission_id = ?
                  AND decision.task_id = tasks.id
                  AND decision.reservation_id = tasks.transition_token
                  AND decision.state = 'pending'
              )
          `)
          .bind(
            status,
            status,
            decidedAt,
            input.taskId,
            input.ownerId,
            input.expectedAssignedTo,
            input.decision.reservationId,
            input.reviewSubmissionVersion,
          ),
        db
          .prepare(`
            INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at)
            SELECT ?, ?, ?, ?, ?, ?, NULL, ?
            FROM tasks
            WHERE id = ? AND status = ? AND transition_token = ?
          `)
          .bind(
            actionId,
            input.taskId,
            actorType,
            input.decision.actor.id,
            action,
            input.decision.reason,
            decidedAt,
            input.taskId,
            status,
            input.decision.reservationId,
          ),
        db
          .prepare(`
            UPDATE task_review_decisions
            SET state = 'accepted', action_id = ?, decided_at = ?
            WHERE review_submission_id = ?
              AND task_id = ?
              AND reservation_id = ?
              AND state = 'pending'
              AND EXISTS (SELECT 1 FROM task_actions WHERE id = ?)
          `)
          .bind(actionId, decidedAt, input.reviewSubmissionVersion, input.taskId, input.decision.reservationId, actionId),
        db
          .prepare(`
            UPDATE tasks
            SET version = version + 1, updated_at = ?
            WHERE id IN (SELECT task_id FROM task_dependencies WHERE depends_on = ?)
              AND EXISTS (
                SELECT 1 FROM tasks completed
                WHERE completed.id = ? AND completed.status = 'done' AND completed.transition_token = ?
              )
          `)
          .bind(decidedAt, input.taskId, input.taskId, input.decision.reservationId),
        db.prepare("UPDATE tasks SET transition_token = NULL WHERE id = ? AND transition_token = ?").bind(input.taskId, input.decision.reservationId),
      ]);
      return (results[0]?.meta?.changes ?? 0) === 1
        ? {
            ...input.decision,
            state: "accepted",
            actionId,
            decidedAt,
          }
        : null;
    },
    async markEffectDelivered(input) {
      const effectDeliveredAt = new Date().toISOString();
      const result = await db
        .prepare(`
          UPDATE task_review_decisions
          SET effect_state = 'delivered', effect_delivered_at = ?
          WHERE review_submission_id = ?
            AND task_id = ?
            AND reservation_id = ?
            AND state = 'accepted'
            AND effect_state = 'pending'
            AND task_id IN (
              SELECT task.id
              FROM tasks task
              JOIN boards board ON board.id = task.board_id
              WHERE board.owner_id = ?
            )
        `)
        .bind(effectDeliveredAt, input.reviewSubmissionVersion, input.taskId, input.decision.reservationId, input.ownerId)
        .run();
      return (result.meta?.changes ?? 0) === 1
        ? {
            ...input.decision,
            effectState: "delivered",
            effectDeliveredAt,
          }
        : null;
    },
  };
  return repository;
}

function storedDecision(row: DecisionRow): StoredTaskReviewDecision {
  return {
    kind: row.kind,
    reason: row.reason,
    actor: publicActor(row.actor_type, row.actor_id),
    reservationId: row.reservation_id,
    state: row.state,
    effectState: row.effect_state,
    actionId: row.action_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    effectDeliveredAt: row.effect_delivered_at,
  };
}

function storedActorType(actor: TaskReviewDecisionActor): DecisionRow["actor_type"] {
  if (actor.type === "agent") return "realmroot:agent";
  if (actor.type === "human") return "user";
  return actor.type;
}

function publicActor(type: DecisionRow["actor_type"], id: string): TaskReviewDecisionActor {
  if (type === "realmroot:agent") return { type: "agent", id };
  if (type === "user") return { type: "human", id };
  return { type, id };
}
