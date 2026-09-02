export interface TaskAssignmentTarget {
  status: string;
  assignedTo: string | null;
  assigneeIdentityType: string | null;
  activeAssignment: TaskAssignmentCommit | null;
}

export interface TaskAssignmentCommit {
  actionId: string;
  assignedAt: string;
  assignedByActorId: string;
}

export interface TaskAssignmentRepository {
  findTarget(ownerId: string, taskId: string): Promise<TaskAssignmentTarget | null>;
  create(input: { ownerId: string; taskId: string; assigneeActorId: string; assignedByActorId: string }): Promise<TaskAssignmentCommit | null>;
}

export interface TaskAssignment {
  id: string;
  taskId: string;
  agentActorId: string;
  assignedByActorId: string;
  assignedAt: string;
}

export type TaskAssignmentFailureCode = "TASK_NOT_FOUND" | "TASK_ASSIGNMENT_CONFLICT";

export class TaskAssignmentFailure extends Error {
  constructor(
    readonly code: TaskAssignmentFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskAssignmentFailure";
  }
}

export async function replaceTaskAssignment(
  repository: TaskAssignmentRepository,
  input: { ownerId: string; taskId: string; assigneeActorId: string; assignedByActorId: string },
): Promise<{ assignment: TaskAssignment; version: string; created: boolean }> {
  const target = await repository.findTarget(input.ownerId, input.taskId);
  if (!target) throw new TaskAssignmentFailure("TASK_NOT_FOUND", "Task not found");
  if (target.assignedTo === input.assigneeActorId && target.assigneeIdentityType === "realmroot_actor" && target.activeAssignment) {
    return assignmentResult(input.taskId, input.assigneeActorId, target.activeAssignment, false);
  }
  if (target.status !== "todo" || target.assignedTo !== null) {
    throw new TaskAssignmentFailure("TASK_ASSIGNMENT_CONFLICT", "Task is not available for assignment");
  }

  const committed = await repository.create(input);
  if (!committed) {
    const winner = await repository.findTarget(input.ownerId, input.taskId);
    if (winner?.assignedTo === input.assigneeActorId && winner.assigneeIdentityType === "realmroot_actor" && winner.activeAssignment) {
      return assignmentResult(input.taskId, input.assigneeActorId, winner.activeAssignment, false);
    }
    throw new TaskAssignmentFailure("TASK_ASSIGNMENT_CONFLICT", "Task state or assignment changed before the assignment was committed");
  }
  return assignmentResult(input.taskId, input.assigneeActorId, committed, true);
}

function assignmentResult(
  taskId: string,
  agentActorId: string,
  committed: TaskAssignmentCommit,
  created: boolean,
): { assignment: TaskAssignment; version: string; created: boolean } {
  return {
    assignment: {
      id: taskId,
      taskId,
      agentActorId,
      assignedByActorId: committed.assignedByActorId,
      assignedAt: committed.assignedAt,
    },
    version: committed.actionId,
    created,
  };
}
