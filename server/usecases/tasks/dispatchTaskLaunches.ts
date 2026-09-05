import type { CreateSessionRequest } from "@realmroot/enbor-sdk";

export interface TaskLaunchLease {
  id: string;
  task_id: string;
  owner_id: string;
  assignee_actor_id: string;
  repository_id: string | null;
  repository_url: string | null;
  lease_token: string;
  lease_expires_at: string;
  attempts: number;
}

export interface PreparedTaskLaunch {
  projectId: string;
  request: CreateSessionRequest;
}

export interface TaskLaunchStore {
  acquireRunnable(now: Date, limit?: number): Promise<TaskLaunchLease[]>;
  acquireRequested(now: Date, limit?: number): Promise<TaskLaunchLease[]>;
  saveRequest(lease: TaskLaunchLease, input: PreparedTaskLaunch, now: Date): Promise<boolean>;
  findRequested(ownerId: string, launchId: string): Promise<(PreparedTaskLaunch & { sessionId: string | null }) | null>;
  recordSession(lease: TaskLaunchLease, sessionId: string, now: Date): Promise<boolean>;
  recordFailure(lease: TaskLaunchLease, phase: "preparation" | "creation", now: Date): Promise<void>;
}

export interface TaskLaunchExecution {
  beforeCreate?: (lease: TaskLaunchLease, input: PreparedTaskLaunch) => Promise<void>;
  prepare(lease: TaskLaunchLease): Promise<PreparedTaskLaunch>;
  create(ownerId: string, input: PreparedTaskLaunch, idempotencyKey: string): Promise<{ uid: string }>;
}

export async function dispatchTaskLaunches(
  store: TaskLaunchStore,
  execution: TaskLaunchExecution,
  now: () => Date = () => new Date(),
): Promise<void> {
  const failures: unknown[] = [];
  const recordFailure = async (lease: TaskLaunchLease, phase: "preparation" | "creation", error: unknown) => {
    failures.push(error);
    try {
      await store.recordFailure(lease, phase, now());
    } catch (recordingError) {
      // Drain the other in-flight requests before returning from the Worker.
      // Keep both causes when persisting the failure also fails.
      failures.push(recordingError);
    }
  };
  const deliver = async (lease: TaskLaunchLease) => {
    try {
      const saved = await store.findRequested(lease.owner_id, lease.id);
      if (!saved) throw new Error("Committed launch request is missing");
      await execution.beforeCreate?.(lease, saved);
      const session = await execution.create(lease.owner_id, saved, lease.id);
      // Failure to win this write is safe: the next lease replays the same
      // persisted request and key, and receives the same remote Session.
      await store.recordSession(lease, session.uid, now());
    } catch (error) {
      await recordFailure(lease, "creation", error);
    }
  };

  // Bound each batch to avoid holding leases that expire before they are used.
  await Promise.all((await store.acquireRequested(now(), 4)).map(deliver));
  await Promise.all(
    (await store.acquireRunnable(now(), 4)).map(async (lease) => {
      let prepared: PreparedTaskLaunch;
      try {
        prepared = await execution.prepare(lease);
        if (!(await store.saveRequest(lease, prepared, now()))) return;
      } catch (error) {
        await recordFailure(lease, "preparation", error);
        return;
      }
      await deliver(lease);
    }),
  );
  if (failures.length) throw new AggregateError(failures, "Task launch dispatch failed");
}
