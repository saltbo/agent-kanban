import { EnborApiError, type EnborClient } from "@realmroot/enbor-sdk";
import { createAgencySession } from "@server/adapters/agency/client";
import type { PreparedTaskLaunch } from "@server/usecases/tasks/dispatchTaskLaunches";

export function taskLaunchResources(clientFor: (ownerId: string, projectId: string) => Promise<EnborClient>) {
  return {
    async refreshBootstrap(ownerId: string, projectId: string, secretRef: string, token: string, expiresAt: string): Promise<void> {
      const [vaultId, credentialId] = credentialIdentity(secretRef);
      const client = await clientFor(ownerId, projectId);
      const credential = await client.vaults.updateCredentialSecret(vaultId, credentialId, {
        stringData: { username: "x-access-token", password: token },
        metadata: { "agent-kanban.dev/expires-at": expiresAt },
      });
      if (credential.status.phase !== "active" || credential.status.activeVersion?.spec.metadata["agent-kanban.dev/expires-at"] !== expiresAt) {
        throw new Error("Enbor did not confirm the active bootstrap credential version");
      }
    },

    async create(ownerId: string, input: PreparedTaskLaunch, idempotencyKey: string): Promise<{ uid: string }> {
      const session = await createAgencySession(await clientFor(ownerId, input.projectId), input.request, idempotencyKey);
      if (session.metadata.projectId !== input.projectId) throw new Error("Enbor returned a Session from a different Project");
      return { uid: session.metadata.uid };
    },

    async closeSession(ownerId: string, projectId: string, sessionId: string): Promise<void> {
      const client = await clientFor(ownerId, projectId);
      try {
        await client.sessions.update(sessionId, { state: "closed" });
      } catch (error) {
        // A deleted Session is already settled. All other failures must retain
        // the launch for a later cleanup attempt.
        if (!(error instanceof EnborApiError && error.status === 404)) throw error;
      }
    },

    async revokeBootstrap(ownerId: string, projectId: string, secretRef: string): Promise<void> {
      const [vaultId, credentialId] = credentialIdentity(secretRef);
      const client = await clientFor(ownerId, projectId);
      try {
        await client.vaults.updateCredential(vaultId, credentialId, {
          state: "revoked",
          revokeReason: "Agent Kanban Task launch settled",
        });
      } catch (error) {
        if (!(error instanceof EnborApiError && error.status === 404)) throw error;
      }
    },
  };
}

function credentialIdentity(secretRef: string): [string, string] {
  const match = secretRef.match(/^enbor:\/\/vaults\/([^/?#]+)\/credentials\/([^/?#]+)$/);
  if (!match) throw new Error("Launch bootstrap must reference one unversioned Enbor credential");
  return [decodeURIComponent(match[1]), decodeURIComponent(match[2])];
}
