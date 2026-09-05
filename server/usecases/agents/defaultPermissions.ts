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

export interface PermissionContext {
  id: string | null;
  name: string;
  authorizationDetail: Record<string, unknown>;
  requestableScopes: string[];
  authorizedScopes: string[];
}
export interface AgentPermissionGateway {
  contexts(agentId: string, resource: string): Promise<{ resourceServerId: string; items: PermissionContext[] }>;
  grant(
    agentId: string,
    input: { resourceServerId: string; scope: string; authorizationDetails: Record<string, unknown>[]; mode: "persistent" },
  ): Promise<void>;
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
  input: { akResource: string; githubResource: string; tenantContextId: string; akScopes: readonly string[] },
): Promise<void> {
  const ak = await gateway.contexts(agentId, input.akResource);
  const tenant = ak.items.find((context) => context.id === input.tenantContextId);
  if (!tenant) throw new Error("The creating user cannot authorize the AK tenant Context");
  const github = await gateway.contexts(agentId, input.githubResource);
  if (github.items.length === 0) throw new Error("Connect a GitHub account in Realmroot before creating an AK Agent");
  const targets = [
    { resourceServerId: ak.resourceServerId, context: tenant, scopes: input.akScopes },
    ...github.items.map((context) => ({ resourceServerId: github.resourceServerId, context, scopes: DEFAULT_GITHUB_SCOPES })),
  ];
  // Validate the complete plan before writing any permissions.
  for (const target of targets) {
    const missing = target.scopes.filter(
      (scope) => !target.context.requestableScopes.includes(scope) && !target.context.authorizedScopes.includes(scope),
    );
    if (missing.length)
      throw new Error(`Context ${target.context.name} cannot grant ${missing.join(", ")}. Update the user's resource authorization first`);
  }
  for (const target of targets) {
    for (const scope of target.scopes) {
      await gateway.grant(agentId, {
        resourceServerId: target.resourceServerId,
        scope,
        authorizationDetails: [target.context.authorizationDetail],
        mode: "persistent",
      });
    }
  }
}
