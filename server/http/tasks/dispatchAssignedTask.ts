import { taskLaunchResources } from "@server/adapters/agency/taskLaunchResources";
import { listTaskBootstrapCredentials, taskRepositoryWorkspace } from "@server/adapters/agency/taskRepositoryWorkspace";
import { getTask } from "@server/adapters/d1/taskRepo";
import { d1TaskLaunchRepository, listReadyDependentLaunches } from "@server/adapters/d1/tasks/d1TaskLaunches";
import { agencyDependencies } from "@server/http/resource-server/agencyDependencies";
import { dispatchTaskLaunches } from "@server/usecases/tasks/dispatchTaskLaunches";
import { prepareTaskLaunch } from "@server/usecases/tasks/prepareTaskLaunch";
import { settleTaskLaunches } from "@server/usecases/tasks/settleTaskLaunches";
import type { TaskContext } from "./workflowSupport";

export async function dispatchAssignedTask(c: TaskContext, taskId: string): Promise<void> {
  return executeTaskLaunch(c, taskId, false);
}

export async function settleAssignedTask(c: TaskContext, taskId: string): Promise<void> {
  return executeTaskLaunch(c, taskId, true);
}

export async function dispatchTaskDependents(c: TaskContext, taskId: string): Promise<void> {
  let cursor = "";
  const failures: unknown[] = [];
  for (;;) {
    const ids = await listReadyDependentLaunches(c.env.DB, c.get("ownerId"), taskId, cursor);
    if (!ids.length) break;
    const results = await Promise.allSettled(ids.map((id) => dispatchAssignedTask(c, id)));
    for (const result of results) if (result.status === "rejected") failures.push(result.reason);
    cursor = ids[ids.length - 1]!;
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Dependent Task dispatch failed");
}

async function executeTaskLaunch(c: TaskContext, taskId: string, settle: boolean): Promise<void> {
  const ownerId = c.get("ownerId");
  const task = await getTask(c.env.DB, taskId, ownerId);
  if (!task) throw new Error("Assigned Task is missing");
  const store = d1TaskLaunchRepository(c.env.DB, { ownerId, taskId });
  const snapshot = task.metadata["agent-kanban.dev/launch"] as { repository_id?: string | null } | undefined;
  const needsRepository = Boolean(snapshot?.repository_id);
  let agency: Awaited<ReturnType<typeof agencyDependencies>> | undefined;
  const connection = async () =>
    (agency ??= await agencyDependencies(c, [
      ...(settle ? [] : ["agents:read"]),
      "sessions:write",
      ...(needsRepository ? ["vaults:read", "vaults:write"] : []),
    ]));
  const resources = taskLaunchResources(async (owner, projectId) => {
    if (owner !== ownerId) throw new Error("Task dispatch tenant mismatch");
    const selected = await connection();
    if (selected.projectId !== projectId) throw new Error("Task dispatch Project mismatch");
    return selected.client;
  });
  try {
    // Recover an acknowledged-but-unrecorded Session with the original key
    // before cleanup; a terminal Task cannot acquire a new runnable launch.
    await dispatchTaskLaunches(store, {
      create: resources.create,
      async beforeCreate(lease, saved) {
        if (settle || !lease.repository_id) return;
        if (!(await store.findBootstrap(lease.owner_id, lease.id))) throw new Error("Committed repository launch has no bootstrap reference");
        const selected = await connection();
        if (selected.projectId !== saved.projectId) throw new Error("Task bootstrap refresh Project mismatch");
        await taskRepositoryWorkspace(c.env, selected.client, selected.projectId, store, lease);
      },
      async prepare(lease) {
        const selected = await connection();
        return prepareTaskLaunch({
          lease,
          projectId: selected.projectId,
          client: selected.client,
          issuer: c.env.OIDC_ISSUER,
          publicOrigin: c.env.AK_PUBLIC_ORIGIN,
          prepareWorkspace: (input) => taskRepositoryWorkspace(c.env, selected.client, selected.projectId, store, input),
        });
      },
    });
    if (settle)
      await settleTaskLaunches(store, {
        ...resources,
        async reconcileBootstrap(lease) {
          if (!lease.bootstrap_vault_id || !lease.project_id) return;
          const selected = await connection();
          if (selected.projectId !== lease.project_id) throw new Error("Bootstrap cleanup Project mismatch");
          const credentials = await listTaskBootstrapCredentials(selected.client, lease.project_id, lease.bootstrap_vault_id, lease);
          for (const credential of credentials)
            await resources.revokeBootstrap(
              lease.owner_id,
              lease.project_id,
              `enbor://vaults/${lease.bootstrap_vault_id}/credentials/${credential.metadata.uid}`,
            );
        },
      });
  } catch (error) {
    if (error instanceof AggregateError && error.errors.length === 1) throw error.errors[0];
    throw error;
  }
}
