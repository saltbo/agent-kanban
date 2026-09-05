import type { PreparedTaskLaunch } from "./dispatchTaskLaunches";

export interface TaskClaimSessionRecoveryStore {
  findClaimRequest(ownerId: string, taskId: string, agentActorId: string): Promise<(PreparedTaskLaunch & { launchId: string }) | null>;
  recordRecoveredSession(ownerId: string, launchId: string, projectId: string, sessionId: string, now: Date): Promise<boolean>;
}

export async function recoverTaskClaimSession(
  store: TaskClaimSessionRecoveryStore,
  create: (ownerId: string, request: PreparedTaskLaunch, key: string) => Promise<{ uid: string }>,
  input: { ownerId: string; taskId: string; agentActorId: string },
): Promise<void> {
  const request = await store.findClaimRequest(input.ownerId, input.taskId, input.agentActorId);
  if (!request) return;
  // Replay the server's persisted request, never a Session id supplied by the
  // claiming Agent. Both the original creator and this replay receive one id.
  const session = await create(input.ownerId, request, request.launchId);
  await store.recordRecoveredSession(input.ownerId, request.launchId, request.projectId, session.uid, new Date());
  // Claim still rechecks signed provenance and current Task state atomically.
}
