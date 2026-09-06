import { describe, expect, it, vi } from "vitest";
import { createAgentPermissionGateway } from "../../../server/adapters/realmroot/agentPermissions";
import { DEFAULT_GITHUB_SCOPES, grantDefaultAgentPermissions } from "../../../server/usecases/agents/defaultPermissions";

describe("new Agent permissions", () => {
  it("[spec: agents/default-permissions] grants only GitHub scopes and leaves AK to native automatic authorization", async () => {
    const grant = vi.fn().mockResolvedValue(undefined);
    await grantDefaultAgentPermissions({ grant, deleteIdentity: vi.fn() }, "new-identity", { githubResource: "https://github.test/api" });
    expect(grant.mock.calls).toEqual([["new-identity", { resource: "https://github.test/api", scopes: DEFAULT_GITHUB_SCOPES, mode: "persistent" }]]);
  });
  it("[spec: agents/default-permissions] validates all returned scopes and propagates authority failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ items: [{ agentId: "agent", scope: "issues:read", mode: "persistent", status: "active" }] }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const gateway = createAgentPermissionGateway("https://id.test/api", "user-token");
      const input = { resource: "https://github.test/api", scopes: ["issues:read"], mode: "persistent" as const };
      await gateway.grant("agent", input);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify(input) });
      fetchMock.mockResolvedValueOnce(Response.json({ items: [] }));
      await expect(gateway.grant("agent", input)).rejects.toThrow("all requested");
      fetchMock.mockResolvedValueOnce(Response.json({ error: { message: "Connect the resource account" } }, { status: 400 }));
      await expect(gateway.grant("agent", input)).rejects.toThrow("Connect the resource account");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
