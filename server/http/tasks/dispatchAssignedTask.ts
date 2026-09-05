import { taskLaunchResources } from "@server/adapters/agency/taskLaunchResources";
import { listTaskBootstrapCredentials, taskRepositoryWorkspace } from "@server/adapters/agency/taskRepositoryWorkspace";
import { getTask } from "@server/adapters/d1/taskRepo";
import { d1TaskLaunchRepository, listReadyDependentLaunches } from "@server/adapters/d1/tasks/d1TaskLaunches";
import type { Env } from "@server/env";
import { agencyDependencies, userAgencyDependencies } from "@server/http/resource-server/agencyDependencies";
import { RealmrootDelegationFailure } from "@server/usecases/agency/failures";
import { dispatchTaskLaunches } from "@server/usecases/tasks/dispatchTaskLaunches";
import { prepareTaskLaunch } from "@server/usecases/tasks/prepareTaskLaunch";
import { settleTaskLaunches } from "@server/usecases/tasks/settleTaskLaunches";
import type { TaskContext } from "./workflowSupport";

export async function dispatchAssignedTask(c: TaskContext, taskId: string): Promise<void> {
  return executeTaskLaunch(c.env, c.get("ownerId"), taskId, false, (scopes) => agencyDependencies(c, scopes));
}

export async function settleAssignedTask(c: TaskContext, taskId: string): Promise<void> {
  return executeTaskLaunch(c.env, c.get("ownerId"), taskId, true, (scopes) => agencyDependencies(c, scopes));
}

export async function dispatchTaskDependents(c: TaskContext, taskId: string): Promise<void> {
  return dispatchDependents(c.env, c.get("ownerId"), taskId, (id) => dispatchUserTask(c.env, c.get("ownerId"), id, false, c.get("traceparent")));
}

export async function finishWebhookTask(env: Env, ownerId: string, taskId: string, traceparent?: string): Promise<void> {
  await dispatchUserTask(env, ownerId, taskId, true, traceparent);
  await dispatchDependents(env, ownerId, taskId, (id) => dispatchUserTask(env, ownerId, id, false, traceparent));
}

async function dispatchUserTask(env: Env, ownerId: string, taskId: string, settle: boolean, traceparent?: string) {
  return executeTaskLaunch(env, ownerId, taskId, settle, async (scopes) => {
    const task = await getTask(env.DB, taskId, ownerId);
    const subjectId = task?.metadata["agent-kanban.dev/authorization-subject"];
    if (typeof subjectId !== "string" || !subjectId)
      throw new RealmrootDelegationFailure(
        "user-login-required",
        "The Task has no user authorization binding. Sign in to Agent Kanban and assign the Task before background execution.",
      );
    return userAgencyDependencies(env, { tenantId: ownerId, subjectId }, scopes, traceparent);
  });
}

async function dispatchDependents(env: Env, ownerId: string, taskId: string, dispatch: (id: string) => Promise<void>) {
  let cursor = "";
  const failures: unknown[] = [];
  for (;;) {
    const ids = await listReadyDependentLaunches(env.DB, ownerId, taskId, cursor);
    if (!ids.length) break;
    // Dependents may share a rotating user grant. Dispatch them sequentially
    // so this webhook does not contend with its own token refresh.
    for (const id of ids) {
      try {
        await dispatch(id);
      } catch (error) {
        failures.push(error);
      }
    }
    cursor = ids[ids.length - 1]!;
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Dependent Task dispatch failed");
}

async function executeTaskLaunch(
  env: Env,
  ownerId: string,
  taskId: string,
  settle: boolean,
  connect: (scopes: readonly string[]) => ReturnType<typeof agencyDependencies>,
): Promise<void> {
  const task = await getTask(env.DB, taskId, ownerId);
  if (!task) throw new Error("Assigned Task is missing");
  const store = d1TaskLaunchRepository(env.DB, { ownerId, taskId });
  const snapshot = task.metadata["agent-kanban.dev/launch"] as { repository_id?: string | null } | undefined;
  const needsRepository = Boolean(snapshot?.repository_id);
  let agency: Awaited<ReturnType<typeof agencyDependencies>> | undefined;
  const connection = async () =>
    (agency ??= await connect([...(settle ? [] : ["agents:read"]), "sessions:write", ...(needsRepository ? ["vaults:read", "vaults:write"] : [])]));
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
        await taskRepositoryWorkspace(env, selected.client, selected.projectId, store, lease);
      },
      async prepare(lease) {
        const selected = await connection();
        return prepareTaskLaunch({
          lease,
          projectId: selected.projectId,
          client: selected.client,
          issuer: env.OIDC_ISSUER,
          publicOrigin: env.AK_PUBLIC_ORIGIN,
          prepareWorkspace: (input) => taskRepositoryWorkspace(env, selected.client, selected.projectId, store, input),
        });
      },
    });
    const current = await getTask(env.DB, taskId, ownerId);
    const replacement = (current?.metadata["agent-kanban.dev/launch"] as { replacement_actor_id?: string } | undefined)?.replacement_actor_id;
    if (settle || replacement || current?.status === "cancelled" || current?.status === "done")
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
