export interface StoredTaskClaimDeletion {
  claimVersion: string;
  actionId: string;
  deletedAt: string;
}

export interface TaskClaimDeletionTarget {
  status: string;
  assignedTo: string | null;
  assigneeIdentityType: string | null;
  activeClaimVersion: string | null;
  matchingDeletion: StoredTaskClaimDeletion | null;
}

export interface TaskClaimDeletionRepository {
  findTarget(ownerId: string, taskId: string, expectedClaimVersion: string): Promise<TaskClaimDeletionTarget | null>;
  delete(input: { ownerId: string; taskId: string; expectedClaimVersion: string; deletedByActorId: string }): Promise<StoredTaskClaimDeletion | null>;
}

export type TaskClaimDeletionFailureCode =
  | "TASK_NOT_FOUND"
  | "TASK_CLAIM_DELETION_FORBIDDEN"
  | "TASK_CLAIM_PRECONDITION_FAILED"
  | "TASK_CLAIM_DELETION_CONFLICT";

export class TaskClaimDeletionFailure extends Error {
  constructor(
    readonly code: TaskClaimDeletionFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskClaimDeletionFailure";
  }
}

export async function deleteTaskClaim(
  repository: TaskClaimDeletionRepository,
  input: { ownerId: string; taskId: string; expectedClaimVersion: string; deletedByActorId: string },
): Promise<void> {
  let target = await repository.findTarget(input.ownerId, input.taskId, input.expectedClaimVersion);
  validateTarget(target, input.expectedClaimVersion, input.deletedByActorId);
  if (target.matchingDeletion) return;

  const deletion = await repository.delete(input);
  if (deletion) return;

  target = await repository.findTarget(input.ownerId, input.taskId, input.expectedClaimVersion);
  validateTarget(target, input.expectedClaimVersion, input.deletedByActorId);
  if (target.matchingDeletion) return;
  throw new TaskClaimDeletionFailure("TASK_CLAIM_DELETION_CONFLICT", "Task state changed before the Claim was deleted");
}

function validateTarget(
  target: TaskClaimDeletionTarget | null,
  expectedClaimVersion: string,
  deletedByActorId: string,
): asserts target is TaskClaimDeletionTarget {
  if (!target) throw new TaskClaimDeletionFailure("TASK_NOT_FOUND", "Task not found");
  if (target.assigneeIdentityType !== "realmroot_actor" || target.assignedTo !== deletedByActorId) {
    throw new TaskClaimDeletionFailure("TASK_CLAIM_DELETION_FORBIDDEN", "Only the assigned Agent may release its Task Claim");
  }
  if (!target.activeClaimVersion && target.matchingDeletion) return;
  if (target.status === "in_progress" && target.activeClaimVersion === expectedClaimVersion) return;
  throw new TaskClaimDeletionFailure("TASK_CLAIM_PRECONDITION_FAILED", "If-Match does not identify the current Task Claim");
}
