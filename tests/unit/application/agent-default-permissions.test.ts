import { describe, expect, it, vi } from "vitest";
import { type AgentPermissionGateway, DEFAULT_GITHUB_SCOPES, grantDefaultAgentPermissions } from "../../../server/usecases/agents/defaultPermissions";

function fixture() {
  const grant = vi.fn().mockResolvedValue(undefined);
  const gateway: AgentPermissionGateway = {
    grant,
    contexts: vi.fn(async (_id, resource) => ({
      resourceServerId: resource,
      items: [
        {
          id: resource === "ak" ? "tenant" : null,
          name: resource,
          authorizationDetail: { type: "context", id: resource },
          authorizedScopes: [],
          requestableScopes: resource === "ak" ? ["task:read", "task:write", "task:claim"] : [...DEFAULT_GITHUB_SCOPES],
        },
      ],
    })),
  };
  return {
    gateway,
    grant,
    input: { akResource: "ak", githubResource: "github", tenantContextId: "tenant", akScopes: ["task:read", "task:write", "task:claim"] },
  };
}
describe("new Agent permissions", () => {
  it("[spec: agents/default-permissions] configures AK and every required GitHub scope for the new identity", async () => {
    const { gateway, grant, input } = fixture();
    await grantDefaultAgentPermissions(gateway, "new-identity", input);
    expect(grant).toHaveBeenCalledTimes(3 + DEFAULT_GITHUB_SCOPES.length);
    for (const scope of DEFAULT_GITHUB_SCOPES)
      expect(grant).toHaveBeenCalledWith("new-identity", {
        resourceServerId: "github",
        scope,
        authorizationDetails: [{ type: "context", id: "github" }],
        mode: "persistent",
      });
    expect(DEFAULT_GITHUB_SCOPES).toEqual(
      expect.arrayContaining(["issues:read", "issues:write", "actions:read", "actions:write", "workflows:write"]),
    );
  });
  it("[spec: agents/default-permissions] resumes when earlier permissions are already authorized", async () => {
    const { gateway, input } = fixture();
    const contexts = gateway.contexts;
    gateway.contexts = async (id, resource) => {
      const result = await contexts(id, resource);
      return { ...result, items: result.items.map((item) => ({ ...item, authorizedScopes: item.requestableScopes, requestableScopes: [] })) };
    };
    await expect(grantDefaultAgentPermissions(gateway, "new-identity", input)).resolves.toBeUndefined();
  });
  it("[spec: agents/default-permissions] fails the complete plan before writing when a Context cannot grant the required scopes", async () => {
    const { gateway, grant, input } = fixture();
    gateway.contexts = vi.fn(async (_id, resource) => ({
      resourceServerId: resource,
      items: [{ id: "tenant", name: resource, authorizationDetail: { type: "context" }, authorizedScopes: [], requestableScopes: input.akScopes }],
    }));
    await expect(grantDefaultAgentPermissions(gateway, "new-identity", input)).rejects.toThrow("cannot grant");
    expect(grant).not.toHaveBeenCalled();
  });
});
