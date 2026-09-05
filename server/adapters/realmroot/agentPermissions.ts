import type { AgentPermissionGateway, PermissionContext } from "@server/usecases/agents/defaultPermissions";

export function createAgentPermissionGateway(origin: string, token: string): AgentPermissionGateway {
  async function request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, origin), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      const problem = value as { error?: { message?: unknown }; detail?: unknown } | null;
      const detail = problem?.error?.message ?? problem?.detail;
      const message = typeof detail === "string" ? detail : `HTTP ${response.status}`;
      throw new Error(`Realmroot Agent permissions: ${message}`);
    }
    return value;
  }
  return {
    async contexts(agentId, resource) {
      const items: PermissionContext[] = [];
      let resourceServerId = "";
      for (let page = 1; ; page++) {
        const query = new URLSearchParams({ resource, page: String(page), pageSize: "100" });
        const value = (await request(`/api/agents/${encodeURIComponent(agentId)}/permission-contexts?${query}`)) as {
          resourceServerId?: unknown;
          items?: unknown;
          pagination?: { totalPages?: unknown };
        } | null;
        if (
          !value ||
          typeof value.resourceServerId !== "string" ||
          !Array.isArray(value.items) ||
          typeof value.pagination?.totalPages !== "number" ||
          !value.items.every(validContext)
        ) {
          throw new Error("Realmroot returned invalid Agent permission Contexts");
        }
        resourceServerId = value.resourceServerId;
        items.push(...value.items);
        if (page >= value.pagination.totalPages) break;
      }
      return { resourceServerId, items };
    },
    async grant(agentId, input) {
      const value = (await request(`/api/agents/${encodeURIComponent(agentId)}/permissions`, input)) as {
        agentId?: unknown;
        scope?: unknown;
        mode?: unknown;
        status?: unknown;
      } | null;
      if (value?.agentId !== agentId || value.scope !== input.scope || value.mode !== "persistent" || value.status !== "active") {
        throw new Error("Realmroot did not confirm the requested active Agent permission");
      }
    },
  };
}
function validContext(value: unknown): value is PermissionContext {
  if (!value || typeof value !== "object") return false;
  const context = value as PermissionContext;
  return (
    (context.id === null || typeof context.id === "string") &&
    typeof context.name === "string" &&
    !!context.authorizationDetail &&
    typeof context.authorizationDetail === "object" &&
    Array.isArray(context.authorizedScopes) &&
    context.authorizedScopes.every((scope) => typeof scope === "string") &&
    Array.isArray(context.requestableScopes) &&
    context.requestableScopes.every((scope) => typeof scope === "string")
  );
}
