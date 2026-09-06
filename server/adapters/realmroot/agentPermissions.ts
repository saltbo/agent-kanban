import type { AgentPermissionGateway } from "@server/usecases/agents/defaultPermissions";

export function createAgentPermissionGateway(origin: string, token: string): AgentPermissionGateway {
  return {
    async grant(agentId, input) {
      const response = await fetch(new URL(`/api/agents/${encodeURIComponent(agentId)}/permissions`, origin), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(60_000),
      });
      const value = await response.json().catch(() => null);
      if (!response.ok) {
        const problem = value as { error?: { message?: unknown }; detail?: unknown } | null;
        const detail = problem?.error?.message ?? problem?.detail;
        throw new Error(`Realmroot Agent permissions: ${typeof detail === "string" ? detail : `HTTP ${response.status}`}`);
      }
      const items = (value as { items?: unknown } | null)?.items;
      if (
        !Array.isArray(items) ||
        items.length === 0 ||
        !items.every(
          (item) => item?.agentId === agentId && input.scopes.includes(item.scope) && item.mode === "persistent" && item.status === "active",
        ) ||
        !input.scopes.every((scope) => items.some((item) => item.scope === scope))
      ) {
        throw new Error("Realmroot did not confirm all requested active Agent permissions");
      }
    },
  };
}
