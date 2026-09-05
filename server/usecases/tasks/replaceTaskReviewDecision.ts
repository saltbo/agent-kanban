import { type TaskReviewDecisionActor, taskReviewDecisionAuthority } from "@server/domain/tasks/taskReviewDecisionAuthority";

export type TaskReviewDecisionKind = "rejection" | "completion";

export interface StoredTaskReviewDecision {
  kind: TaskReviewDecisionKind;
  reason: string | null;
  actor: TaskReviewDecisionActor;
  reservationId: string;
  state: "pending" | "accepted";
  effectState: "pending" | "delivered";
  actionId: string | null;
  createdAt: string;
  decidedAt: string | null;
  effectDeliveredAt: string | null;
}

export interface TaskReviewDecisionTarget {
  version: number;
  taskId: string;
  status: string;
  assignedTo: string | null;
  assigneeIdentityType: string | null;
  activeReviewSubmissionVersion: string | null;
  decision: StoredTaskReviewDecision | null;
}

export interface TaskReviewDecisionRepository {
  findCurrentTarget(ownerId: string, taskId: string): Promise<TaskReviewDecisionTarget | null>;
  findTarget(ownerId: string, taskId: string, reviewSubmissionVersion: string): Promise<TaskReviewDecisionTarget | null>;
  reserve(input: {
    ownerId: string;
    taskId: string;
    reviewSubmissionVersion: string;
    expectedAssignedTo: string;
    kind: TaskReviewDecisionKind;
    reason: string | null;
    actor: TaskReviewDecisionActor;
    expectedTaskVersion?: number;
  }): Promise<StoredTaskReviewDecision | null>;
  finalize(input: {
    ownerId: string;
    taskId: string;
    reviewSubmissionVersion: string;
    expectedAssignedTo: string;
    decision: StoredTaskReviewDecision;
  }): Promise<StoredTaskReviewDecision | null>;
  markEffectDelivered(input: {
    ownerId: string;
    taskId: string;
    reviewSubmissionVersion: string;
    decision: StoredTaskReviewDecision;
  }): Promise<StoredTaskReviewDecision | null>;
}

export interface TaskReviewRejection {
  id: string;
  taskId: string;
  reviewSubmissionVersion: string;
  rejectedByActorType: TaskReviewDecisionActor["type"];
  rejectedByActorId: string;
  reason: string | null;
  rejectedAt: string;
}

export interface TaskReviewCompletion {
  id: string;
  taskId: string;
  reviewSubmissionVersion: string;
  completedByActorType: TaskReviewDecisionActor["type"];
  completedByActorId: string;
  completedAt: string;
}

export type TaskReviewDecisionFailureCode =
  | "TASK_NOT_FOUND"
  | "TASK_REVIEW_DECISION_FORBIDDEN"
  | "TASK_REVIEW_PRECONDITION_FAILED"
  | "TASK_REVIEW_DECISION_CONFLICT";

export class TaskReviewDecisionFailure extends Error {
  constructor(
    readonly code: TaskReviewDecisionFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskReviewDecisionFailure";
  }
}

interface ReplaceDecisionInput {
  ownerId: string;
  taskId: string;
  reviewSubmissionVersion: string;
  actor: TaskReviewDecisionActor;
  reason: string | null;
  expectedTaskVersion?: number;
}

export async function replaceTaskReviewRejection(
  repository: TaskReviewDecisionRepository,
  input: ReplaceDecisionInput,
  deliverEffect?: (decision: StoredTaskReviewDecision) => Promise<void>,
): Promise<{ rejection: TaskReviewRejection; version: string; created: boolean; assigneeActorId: string }> {
  const result = await replaceDecision(repository, input, "rejection", deliverEffect);
  return {
    rejection: {
      id: input.taskId,
      taskId: input.taskId,
      reviewSubmissionVersion: input.reviewSubmissionVersion,
      rejectedByActorType: result.decision.actor.type,
      rejectedByActorId: result.decision.actor.id,
      reason: result.decision.reason,
      rejectedAt: result.decision.decidedAt!,
    },
    version: result.decision.actionId!,
    created: result.created,
    assigneeActorId: result.assigneeActorId,
  };
}

export async function replaceTaskReviewCompletion(
  repository: TaskReviewDecisionRepository,
  input: Omit<ReplaceDecisionInput, "reason">,
): Promise<{ completion: TaskReviewCompletion; version: string; created: boolean; assigneeActorId: string }> {
  const result = await replaceDecision(repository, { ...input, reason: null }, "completion");
  return {
    completion: {
      id: input.taskId,
      taskId: input.taskId,
      reviewSubmissionVersion: input.reviewSubmissionVersion,
      completedByActorType: result.decision.actor.type,
      completedByActorId: result.decision.actor.id,
      completedAt: result.decision.decidedAt!,
    },
    version: result.decision.actionId!,
    created: result.created,
    assigneeActorId: result.assigneeActorId,
  };
}

async function replaceDecision(
  repository: TaskReviewDecisionRepository,
  input: ReplaceDecisionInput,
  kind: TaskReviewDecisionKind,
  deliverEffect?: (decision: StoredTaskReviewDecision) => Promise<void>,
): Promise<{ decision: StoredTaskReviewDecision; created: boolean; assigneeActorId: string }> {
  let target = await repository.findTarget(input.ownerId, input.taskId, input.reviewSubmissionVersion);
  validateTarget(target, input, kind);

  let decision = target.decision;
  let created = false;
  if (!decision) {
    decision = await repository.reserve({
      ...input,
      expectedAssignedTo: target.assignedTo!,
      kind,
      expectedTaskVersion: input.expectedTaskVersion,
    });
    if (!decision) {
      target = await repository.findTarget(input.ownerId, input.taskId, input.reviewSubmissionVersion);
      validateTarget(target, input, kind);
      decision = target.decision;
      if (!decision) throw conflict("Task state changed before the review decision was reserved");
    } else {
      created = true;
    }
  }
  validateDecision(decision, kind, input.reason);
  if (decision.state === "pending") {
    const finalized = await repository.finalize({
      ownerId: input.ownerId,
      taskId: input.taskId,
      reviewSubmissionVersion: input.reviewSubmissionVersion,
      expectedAssignedTo: target.assignedTo!,
      decision,
    });
    if (finalized) {
      decision = finalized;
    } else {
      const winner = await repository.findTarget(input.ownerId, input.taskId, input.reviewSubmissionVersion);
      if (winner?.decision?.state !== "accepted") {
        throw conflict("Task state changed before the review decision was finalized");
      }
      validateDecision(winner.decision, kind, input.reason);
      decision = winner.decision;
    }
  }
  if (decision.effectState === "delivered") return { decision, created: false, assigneeActorId: target.assignedTo! };

  await deliverEffect?.(decision);
  const delivered = await repository.markEffectDelivered({
    ownerId: input.ownerId,
    taskId: input.taskId,
    reviewSubmissionVersion: input.reviewSubmissionVersion,
    decision,
  });
  if (delivered) return { decision: delivered, created, assigneeActorId: target.assignedTo! };

  const winner = await repository.findTarget(input.ownerId, input.taskId, input.reviewSubmissionVersion);
  if (winner?.decision?.effectState === "delivered") {
    validateDecision(winner.decision, kind, input.reason);
    return { decision: winner.decision, created, assigneeActorId: winner.assignedTo! };
  }
  throw conflict("The review decision effect was delivered but its acknowledgement could not be recorded");
}

function validateTarget(
  target: TaskReviewDecisionTarget | null,
  input: ReplaceDecisionInput,
  kind: TaskReviewDecisionKind,
): asserts target is TaskReviewDecisionTarget {
  if (!target) throw new TaskReviewDecisionFailure("TASK_NOT_FOUND", "Task not found");
  if (input.expectedTaskVersion !== undefined && target.version !== input.expectedTaskVersion) {
    throw new TaskReviewDecisionFailure("TASK_REVIEW_PRECONDITION_FAILED", "Task changed before the review decision was committed");
  }
  const authority = taskReviewDecisionAuthority(target.assigneeIdentityType, target.assignedTo, input.actor);
  if (authority === "self-review") {
    throw new TaskReviewDecisionFailure("TASK_REVIEW_DECISION_FORBIDDEN", "An Agent cannot decide its own assigned Task review");
  }
  if (authority === "unsupported-assignee") {
    throw new TaskReviewDecisionFailure("TASK_REVIEW_DECISION_FORBIDDEN", "The Task is not assigned in the Realmroot Agent identity domain");
  }
  if (target.activeReviewSubmissionVersion !== input.reviewSubmissionVersion) {
    throw new TaskReviewDecisionFailure("TASK_REVIEW_PRECONDITION_FAILED", "The supplied Review Submission ETag is not current");
  }
  if (target.decision) {
    validateDecision(target.decision, kind, input.reason);
    return;
  }
  if (target.status !== "in_review") throw conflict(`Task review cannot be decided from ${target.status}`);
}

function validateDecision(decision: StoredTaskReviewDecision, kind: TaskReviewDecisionKind, reason: string | null): void {
  if (decision.kind !== kind) throw conflict("The Review Submission already has a different decision");
  if (decision.reason !== reason) throw conflict("The Review Rejection already has a different reason");
}

function conflict(message: string): TaskReviewDecisionFailure {
  return new TaskReviewDecisionFailure("TASK_REVIEW_DECISION_CONFLICT", message);
}
