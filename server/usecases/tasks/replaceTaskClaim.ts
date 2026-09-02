export interface TaskClaimTarget {
  status: string;
  assignedTo: string | null;
  assigneeIdentityType: string | null;
  activeClaim: TaskClaimCommit | null;
}

export interface TaskClaimCommit {
  actionId: string;
  claimedAt: string;
  runtime: string;
  runtimeSessionId: string;
}

export interface TaskClaimRepository {
  findTarget(ownerId: string, taskId: string): Promise<TaskClaimTarget | null>;
  create(input: {
    ownerId: string;
    taskId: string;
    agentActorId: string;
    runtime: string;
    runtimeSessionId: string;
  }): Promise<TaskClaimCommit | null>;
}

export interface TaskClaim {
  id: string;
  taskId: string;
  agentActorId: string;
  runtime: string;
  runtimeSessionId: string;
  claimedAt: string;
}

export type TaskClaimFailureCode = "TASK_NOT_FOUND" | "TASK_CLAIM_FORBIDDEN" | "TASK_CLAIM_CONFLICT";

export class TaskClaimFailure extends Error {
  constructor(
    readonly code: TaskClaimFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskClaimFailure";
  }
}

export async function replaceTaskClaim(
  repository: TaskClaimRepository,
  input: { ownerId: string; taskId: string; agentActorId: string; runtime: string; runtimeSessionId: string },
): Promise<{ claim: TaskClaim; version: string; created: boolean }> {
  const target = await repository.findTarget(input.ownerId, input.taskId);
  if (!target) throw new TaskClaimFailure("TASK_NOT_FOUND", "Task not found");
  if (target.assigneeIdentityType !== "realmroot_actor" || target.assignedTo !== input.agentActorId) {
    throw new TaskClaimFailure("TASK_CLAIM_FORBIDDEN", "Only the assigned Agent may claim this Task");
  }
  if (target.status === "in_progress" && target.activeClaim) {
    if (target.activeClaim.runtime !== input.runtime || target.activeClaim.runtimeSessionId !== input.runtimeSessionId) {
      throw new TaskClaimFailure("TASK_CLAIM_CONFLICT", "Task is already bound to a different runtime Session");
    }
    return {
      claim: taskClaim(input, target.activeClaim.claimedAt),
      version: target.activeClaim.actionId,
      created: false,
    };
  }
  if (target.status !== "todo") {
    throw new TaskClaimFailure("TASK_CLAIM_CONFLICT", `Task cannot be claimed from ${target.status}`);
  }

  const committed = await repository.create(input);
  if (!committed) {
    const winner = await repository.findTarget(input.ownerId, input.taskId);
    if (
      winner?.status === "in_progress" &&
      winner.assignedTo === input.agentActorId &&
      winner.assigneeIdentityType === "realmroot_actor" &&
      winner.activeClaim &&
      winner.activeClaim.runtime === input.runtime &&
      winner.activeClaim.runtimeSessionId === input.runtimeSessionId
    ) {
      return {
        claim: taskClaim(input, winner.activeClaim.claimedAt),
        version: winner.activeClaim.actionId,
        created: false,
      };
    }
    throw new TaskClaimFailure("TASK_CLAIM_CONFLICT", "Task state or assignment changed before the claim was committed");
  }

  return {
    claim: taskClaim(input, committed.claimedAt),
    version: committed.actionId,
    created: true,
  };
}

function taskClaim(input: { taskId: string; agentActorId: string; runtime: string; runtimeSessionId: string }, claimedAt: string): TaskClaim {
  return {
    id: input.taskId,
    taskId: input.taskId,
    agentActorId: input.agentActorId,
    runtime: input.runtime,
    runtimeSessionId: input.runtimeSessionId,
    claimedAt,
  };
}
