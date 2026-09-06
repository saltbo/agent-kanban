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
  grant(agentId: string, input: { resource: string; scopes: readonly string[]; mode: "persistent" }): Promise<void>;
}

export class AgentPermissionProvisioningError extends Error {
  constructor(
    readonly agentId: string,
    cause: unknown,
  ) {
    super(
      `Agent ${agentId} was created, but permission configuration failed: ${cause instanceof Error ? cause.message : String(cause)}. Retry creation with the same Idempotency-Key to finish configuring this Agent.`,
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
