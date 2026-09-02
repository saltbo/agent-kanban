export interface TaskReviewSubmissionCommit {
  actionId: string;
  submittedAt: string;
  pullRequestUrl: string | null;
}

export interface TaskReviewSubmissionTarget {
  status: string;
  assignedTo: string | null;
  assigneeIdentityType: string | null;
  pullRequestUrl: string | null;
  activeSubmission: TaskReviewSubmissionCommit | null;
}

export interface TaskReviewSubmissionRepository {
  findTarget(ownerId: string, taskId: string): Promise<TaskReviewSubmissionTarget | null>;
  create(input: {
    ownerId: string;
    taskId: string;
    agentActorId: string;
    expectedPullRequestUrl: string | null;
    pullRequestUrl: string | null;
  }): Promise<TaskReviewSubmissionCommit | null>;
}

export interface TaskReviewSubmission {
  id: string;
  taskId: string;
  agentActorId: string;
  reviewSubmissionVersion: string;
  pullRequestUrl: string | null;
  submittedAt: string;
}

export type TaskReviewSubmissionFailureCode =
  | "TASK_NOT_FOUND"
  | "TASK_REVIEW_SUBMISSION_NOT_FOUND"
  | "TASK_REVIEW_FORBIDDEN"
  | "TASK_REVIEW_CONFLICT";

export class TaskReviewSubmissionFailure extends Error {
  constructor(
    readonly code: TaskReviewSubmissionFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskReviewSubmissionFailure";
  }
}

export async function readTaskReviewSubmission(
  repository: Pick<TaskReviewSubmissionRepository, "findTarget">,
  input: { ownerId: string; taskId: string },
): Promise<{ submission: TaskReviewSubmission; version: string }> {
  const target = await repository.findTarget(input.ownerId, input.taskId);
  if (!target) throw new TaskReviewSubmissionFailure("TASK_NOT_FOUND", "Task not found");
  if (target.assigneeIdentityType !== "realmroot_actor" || !target.assignedTo || !target.activeSubmission) {
    throw new TaskReviewSubmissionFailure("TASK_REVIEW_SUBMISSION_NOT_FOUND", "Task has no current Realmroot Agent Review Submission");
  }
  const result = submissionResult(input.taskId, target.assignedTo, target.activeSubmission, false);
  return { submission: result.submission, version: result.version };
}

export async function replaceTaskReviewSubmission(
  repository: TaskReviewSubmissionRepository,
  input: { ownerId: string; taskId: string; agentActorId: string; pullRequestUrl: string | null },
): Promise<{ submission: TaskReviewSubmission; version: string; created: boolean }> {
  const target = await repository.findTarget(input.ownerId, input.taskId);
  if (!target) throw new TaskReviewSubmissionFailure("TASK_NOT_FOUND", "Task not found");
  if (target.assigneeIdentityType !== "realmroot_actor" || target.assignedTo !== input.agentActorId) {
    throw new TaskReviewSubmissionFailure("TASK_REVIEW_FORBIDDEN", "Only the assigned Agent may submit this Task for review");
  }
  if (target.status === "in_review" && target.activeSubmission) {
    if (input.pullRequestUrl !== null && input.pullRequestUrl !== target.activeSubmission.pullRequestUrl) {
      throw new TaskReviewSubmissionFailure("TASK_REVIEW_CONFLICT", "Task already has a different active review submission");
    }
    return submissionResult(input.taskId, input.agentActorId, target.activeSubmission, false);
  }
  if (target.status !== "in_progress") {
    throw new TaskReviewSubmissionFailure("TASK_REVIEW_CONFLICT", `Task cannot be submitted for review from ${target.status}`);
  }

  const committed = await repository.create({
    ...input,
    expectedPullRequestUrl: target.pullRequestUrl,
    pullRequestUrl: input.pullRequestUrl ?? target.pullRequestUrl,
  });
  if (!committed) {
    const winner = await repository.findTarget(input.ownerId, input.taskId);
    if (
      winner?.status === "in_review" &&
      winner.assignedTo === input.agentActorId &&
      winner.assigneeIdentityType === "realmroot_actor" &&
      winner.activeSubmission
    ) {
      if (input.pullRequestUrl !== null && input.pullRequestUrl !== winner.activeSubmission.pullRequestUrl) {
        throw new TaskReviewSubmissionFailure("TASK_REVIEW_CONFLICT", "A different review submission was committed first");
      }
      return submissionResult(input.taskId, input.agentActorId, winner.activeSubmission, false);
    }
    throw new TaskReviewSubmissionFailure("TASK_REVIEW_CONFLICT", "Task state or assignment changed before review submission was committed");
  }

  return submissionResult(input.taskId, input.agentActorId, committed, true);
}

function submissionResult(
  taskId: string,
  agentActorId: string,
  committed: TaskReviewSubmissionCommit,
  created: boolean,
): { submission: TaskReviewSubmission; version: string; created: boolean } {
  return {
    submission: {
      id: taskId,
      taskId,
      agentActorId,
      reviewSubmissionVersion: committed.actionId,
      pullRequestUrl: committed.pullRequestUrl,
      submittedAt: committed.submittedAt,
    },
    version: committed.actionId,
    created,
  };
}
