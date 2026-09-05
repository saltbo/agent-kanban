import type { TaskLaunchLease } from "./dispatchTaskLaunches";
import type { TaskRepositoryWorkspace } from "./prepareTaskLaunch";

export interface TaskLaunchBootstrap extends TaskRepositoryWorkspace {
  projectId: string;
  expiresAt: string;
  installationId: number;
  githubRepositoryId: number;
}

export interface TaskLaunchBootstrapStore {
  saveBootstrapLocation(lease: TaskLaunchLease, projectId: string, vaultId: string, now: Date): Promise<boolean>;
  findBootstrap(ownerId: string, launchId: string): Promise<TaskLaunchBootstrap | null>;
  saveBootstrap(lease: TaskLaunchLease, bootstrap: TaskLaunchBootstrap, now: Date): Promise<boolean>;
  recordBootstrapRefresh(lease: TaskLaunchLease, secretRef: string, expiresAt: Date, now: Date): Promise<boolean>;
}

export async function refreshTaskLaunchBootstrap(
  store: TaskLaunchBootstrapStore,
  lease: TaskLaunchLease,
  execution: {
    mint(bootstrap: TaskLaunchBootstrap): Promise<{ token: string; expiresAt: string }>;
    refreshBootstrap(ownerId: string, projectId: string, secretRef: string, token: string, expiresAt: string): Promise<void>;
  },
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const bootstrap = await store.findBootstrap(lease.owner_id, lease.id);
  if (!bootstrap) throw new Error("Launch bootstrap reference is missing");
  if (Date.parse(bootstrap.expiresAt) > now().getTime() + 5 * 60_000) return false;
  if (Date.parse(lease.lease_expires_at) <= now().getTime()) return false;
  const credential = await execution.mint(bootstrap);
  if (Date.parse(lease.lease_expires_at) <= now().getTime()) return false;
  await execution.refreshBootstrap(lease.owner_id, bootstrap.projectId, bootstrap.secretRef, credential.token, credential.expiresAt);
  return store.recordBootstrapRefresh(lease, bootstrap.secretRef, new Date(credential.expiresAt), now());
}
