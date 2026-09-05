import type { EnborClient, VaultCredential } from "@realmroot/enbor-sdk";
import { repositoryBootstrap } from "@server/adapters/github/repositoryBootstrap";
import type { Env } from "@server/env";
import type { TaskLaunchLease } from "@server/usecases/tasks/dispatchTaskLaunches";
import type { TaskLaunchBootstrapStore } from "@server/usecases/tasks/taskLaunchBootstrap";
import { refreshTaskLaunchBootstrap } from "@server/usecases/tasks/taskLaunchBootstrap";
import { taskLaunchResources } from "./taskLaunchResources";

export async function taskRepositoryWorkspace(
  env: Env,
  client: EnborClient,
  projectId: string,
  store: TaskLaunchBootstrapStore,
  lease: TaskLaunchLease,
) {
  const saved = await store.findBootstrap(lease.owner_id, lease.id);
  if (saved) {
    if (saved.projectId !== projectId) throw new Error("Task bootstrap Project mismatch");
    await refreshTaskLaunchBootstrap(store, lease, {
      async mint(snapshot) {
        if (!lease.repository_id || !lease.repository_url) throw new Error("Task repository snapshot is missing");
        const fresh = await repositoryBootstrap(env, lease.owner_id, lease.repository_id, lease.repository_url);
        if (fresh.githubRepositoryId !== snapshot.githubRepositoryId || fresh.installationId !== snapshot.installationId) {
          throw new Error("Task repository installation changed before bootstrap refresh");
        }
        return fresh;
      },
      refreshBootstrap: taskLaunchResources(async () => client).refreshBootstrap,
    });
    return saved;
  }
  if (!lease.repository_id || !lease.repository_url) throw new Error("Task repository snapshot is missing");
  const bootstrap = await repositoryBootstrap(env, lease.owner_id, lease.repository_id, lease.repository_url);
  const binding = await env.DB.prepare("SELECT session_secret_vault_id FROM agency_owner_integrations WHERE tenant_id = ? AND agency_project_id = ?")
    .bind(lease.owner_id, projectId)
    .first<{ session_secret_vault_id: string | null }>();
  if (!binding) throw new Error("Task tenant Project binding is missing");
  let vaultId = binding.session_secret_vault_id;
  if (!vaultId) {
    const created = await client.vaults.create({
      metadata: {
        name: "Agent Kanban repository bootstrap",
        description: "Temporary read-only GitHub App credentials for Task repository preparation.",
      },
      spec: { scope: "project" },
    });
    if (created.metadata.projectId !== projectId || created.spec.scope !== "project") throw new Error("Bootstrap Vault Project mismatch");
    await env.DB.prepare(
      "UPDATE agency_owner_integrations SET session_secret_vault_id = ? WHERE tenant_id = ? AND agency_project_id = ? AND session_secret_vault_id IS NULL",
    )
      .bind(created.metadata.uid, lease.owner_id, projectId)
      .run();
    const winner = await env.DB.prepare("SELECT session_secret_vault_id FROM agency_owner_integrations WHERE tenant_id = ? AND agency_project_id = ?")
      .bind(lease.owner_id, projectId)
      .first<{ session_secret_vault_id: string | null }>();
    vaultId = winner?.session_secret_vault_id ?? null;
    if (vaultId !== created.metadata.uid) await client.vaults.delete(created.metadata.uid);
    if (!vaultId) throw new Error("Bootstrap Vault binding changed during preparation");
  }
  const vault = await client.vaults.get(vaultId);
  if (vault.metadata.projectId !== projectId || vault.spec.scope !== "project") throw new Error("Bootstrap Vault Project mismatch");
  if (!(await store.saveBootstrapLocation(lease, projectId, vaultId, new Date())))
    throw new Error("Task bootstrap lease changed before credential creation");
  const matches = await listTaskBootstrapCredentials(client, projectId, vaultId, lease);
  const name = `ak-task-${lease.id}`;
  if (matches.length > 1) throw new Error("Multiple bootstrap credentials require reconciliation before starting the Task");
  const credential =
    matches[0] ??
    (await client.vaults.createCredential(vaultId, {
      name,
      type: "enbor.dev/basic-auth",
      metadata: { managedBy: "agent-kanban", taskId: lease.task_id, launchId: lease.id, repositoryId: lease.repository_id },
      secret: {
        stringData: { username: "x-access-token", password: bootstrap.token },
        metadata: { "agent-kanban.dev/expires-at": bootstrap.expiresAt },
      },
    }));
  if (credential.metadata.projectId !== projectId || credential.spec.vaultId !== vaultId) throw new Error("Bootstrap credential Project mismatch");
  if (matches.length)
    await client.vaults.updateCredentialSecret(vaultId, credential.metadata.uid, {
      stringData: { username: "x-access-token", password: bootstrap.token },
      metadata: { "agent-kanban.dev/expires-at": bootstrap.expiresAt },
    });
  const confirmed = await client.vaults.getCredential(vaultId, credential.metadata.uid);
  if (confirmed.status.phase !== "active" || confirmed.status.activeVersion?.spec.metadata["agent-kanban.dev/expires-at"] !== bootstrap.expiresAt) {
    throw new Error("Enbor did not confirm the active bootstrap credential version");
  }
  const reference = {
    projectId,
    url: bootstrap.url,
    ref: bootstrap.ref,
    mountPath: bootstrap.mountPath,
    secretRef: `enbor://vaults/${vaultId}/credentials/${credential.metadata.uid}`,
    expiresAt: bootstrap.expiresAt,
    installationId: bootstrap.installationId,
    githubRepositoryId: bootstrap.githubRepositoryId,
  };
  if (!(await store.saveBootstrap(lease, reference, new Date()))) throw new Error("Task bootstrap lease changed before its reference was recorded");
  return reference;
}

export async function listTaskBootstrapCredentials(
  client: EnborClient,
  projectId: string,
  vaultId: string,
  lease: TaskLaunchLease,
): Promise<VaultCredential[]> {
  const matches: VaultCredential[] = [];
  let cursor: string | undefined;
  const name = `ak-task-${lease.id}`;
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    const page = await client.vaults.listCredentials(vaultId, { search: name, state: "active", limit: 100, cursor });
    matches.push(
      ...page.data.filter(
        (credential) =>
          credential.metadata.name === name &&
          credential.spec.metadata.managedBy === "agent-kanban" &&
          credential.spec.metadata.launchId === lease.id &&
          credential.spec.metadata.taskId === lease.task_id &&
          credential.metadata.projectId === projectId &&
          credential.spec.vaultId === vaultId,
      ),
    );
    const next = page.pagination.nextCursor ?? undefined;
    if (!next) break;
    if (next === cursor || pageIndex === 99) throw new Error("Bootstrap credential pagination did not complete");
    cursor = next;
  }
  return matches;
}
