export type TaskCancellationActor = { type: "agent" | "human" | "machine" | "service" | "system"; id: string };

export interface StoredTaskCancellation {
  actionId: string;
  actorType: TaskCancellationActor["type"];
  actorId: string;
  cancelledAt: string;
  assigneeActorId: string | null;
}

export interface TaskCancellationTarget {
  version: number;
  status: string;
  assignedTo: string | null;
  assigneeIdentityType: string | null;
  cancellation: StoredTaskCancellation | null;
}

export interface TaskCancellationRepository {
  findTarget(ownerId: string, taskId: string): Promise<TaskCancellationTarget | null>;
  create(input: {
    ownerId: string;
    taskId: string;
    actor: TaskCancellationActor;
    assigneeActorId: string | null;
    expectedTaskVersion?: number;
  }): Promise<StoredTaskCancellation | null>;
}

export interface TaskCancellation {
  id: string;
  taskId: string;
  cancelledByActorType: TaskCancellationActor["type"];
  cancelledByActorId: string;
  cancelledAt: string;
}

export type TaskCancellationFailureCode = "TASK_NOT_FOUND" | "TASK_CANCELLATION_CONFLICT";

export class TaskCancellationFailure extends Error {
  constructor(
    readonly code: TaskCancellationFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskCancellationFailure";
  }
}

export async function replaceTaskCancellation(
  repository: TaskCancellationRepository,
  input: { ownerId: string; taskId: string; actor: TaskCancellationActor; expectedTaskVersion?: number },
): Promise<{ cancellation: TaskCancellation; version: string; created: boolean; assigneeActorId: string | null }> {
  let target = await repository.findTarget(input.ownerId, input.taskId);
  if (!target) throw new TaskCancellationFailure("TASK_NOT_FOUND", "Task not found");
  assertTaskVersion(target.version, input.expectedTaskVersion);
  let assigneeActorId = target.cancellation?.assigneeActorId ?? (target.assigneeIdentityType === "realmroot_actor" ? target.assignedTo : null);

  let cancellation = target.cancellation;
  let created = false;
  if (!cancellation) {
    if (!isCancellable(target.status)) {
      throw new TaskCancellationFailure("TASK_CANCELLATION_CONFLICT", `Task cannot be cancelled from ${target.status}`);
    }
    cancellation = await repository.create({ ...input, assigneeActorId });
    if (!cancellation) {
      target = await repository.findTarget(input.ownerId, input.taskId);
      if (!target) throw new TaskCancellationFailure("TASK_NOT_FOUND", "Task not found");
      assertTaskVersion(target.version, input.expectedTaskVersion);
      cancellation = target.cancellation;
      if (!cancellation) {
        throw new TaskCancellationFailure("TASK_CANCELLATION_CONFLICT", "Task state changed before the cancellation was committed");
      }
      assigneeActorId = cancellation.assigneeActorId;
    } else {
      created = true;
    }
  }

  return {
    cancellation: {
      id: input.taskId,
      taskId: input.taskId,
      cancelledByActorType: cancellation.actorType,
      cancelledByActorId: cancellation.actorId,
      cancelledAt: cancellation.cancelledAt,
    },
    version: cancellation.actionId,
    created,
    assigneeActorId,
  };
}

function assertTaskVersion(actual: number, expected?: number): void {
  if (expected !== undefined && actual !== expected) {
    throw new TaskCancellationFailure("TASK_CANCELLATION_CONFLICT", "Task changed before the cancellation was committed");
  }
}

function isCancellable(status: string): boolean {
  return status === "todo" || status === "in_progress" || status === "in_review";
}
