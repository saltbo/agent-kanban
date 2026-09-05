import type { TaskLaunchLease } from "./dispatchTaskLaunches";

export interface TaskLaunchSettlement extends TaskLaunchLease {
  bootstrap_vault_id?: string;
  project_id: string | null;
  session_id: string | null;
  secret_ref: string | null;
}

export interface TaskLaunchSettlementStore {
  acquireSettlement(now: Date, limit?: number): Promise<TaskLaunchSettlement[]>;
  completeSettlement(lease: TaskLaunchSettlement, now: Date): Promise<boolean>;
}

export async function settleTaskLaunches(
  store: TaskLaunchSettlementStore,
  resources: {
    closeSession(ownerId: string, projectId: string, sessionId: string): Promise<void>;
    revokeBootstrap(ownerId: string, projectId: string, secretRef: string): Promise<void>;
    reconcileBootstrap?: (lease: TaskLaunchSettlement) => Promise<void>;
  },
  now: () => Date = () => new Date(),
): Promise<void> {
  const results = await Promise.allSettled(
    (await store.acquireSettlement(now(), 4)).map(async (lease) => {
      if ((lease.session_id || lease.secret_ref) && !lease.project_id) throw new Error("Launch resource has no Project binding");
      if (lease.session_id && lease.project_id) await resources.closeSession(lease.owner_id, lease.project_id, lease.session_id);
      if (lease.secret_ref && lease.project_id) await resources.revokeBootstrap(lease.owner_id, lease.project_id, lease.secret_ref);
      await resources.reconcileBootstrap?.(lease);
      if (!(await store.completeSettlement(lease, now()))) throw new Error("Task cleanup lease changed before acknowledgement");
    }),
  );
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Task launch settlement failed",
    );
}
