export const DEFAULT_GITHUB_SCOPES = [
  "metadata:read",
  "contents:read",
  "contents:write",
  "pull_requests:read",
  "pull_requests:write",
  "checks:read",
  "statuses:read",
  "actions:read",
  "actions:write",
  "workflows:write",
  "issues:read",
  "issues:write",
] as const;

export interface AgentPermissionGateway {
  deleteIdentity(agentId: string): Promise<void>;
  grant(agentId: string, input: { resource: string; scopes: readonly string[]; mode: "persistent" }): Promise<void>;
}

export class AgentPermissionProvisioningError extends Error {
  constructor(cause: unknown) {
    super(
      `GitHub permission configuration failed: ${cause instanceof Error ? cause.message : String(cause)}. Identity cleanup completed; connect GitHub or correct its permissions, then create again with a new username and Idempotency-Key (deleted identity usernames remain reserved).`,
      { cause },
    );
  }
}

export class AgentCreationCleanupError extends Error {
  constructor(
    readonly identityId: string,
    readonly realmrootAgentId: string,
    cause: unknown,
    readonly cleanupCause: unknown,
  ) {
    super(
      `Agent creation failed: ${cause instanceof Error ? cause.message : String(cause)}. Cleanup failed for Enbor identity ${identityId} / Realmroot identity ${realmrootAgentId}: ${cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause)}. Identity cleanup requires attention.`,
      { cause },
    );
  }
}

export async function grantDefaultAgentPermissions(
  gateway: AgentPermissionGateway,
  agentId: string,
  input: { githubResource: string },
): Promise<void> {
  await gateway.grant(agentId, { resource: input.githubResource, scopes: DEFAULT_GITHUB_SCOPES, mode: "persistent" });
}
