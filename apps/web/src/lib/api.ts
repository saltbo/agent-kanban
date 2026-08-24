import type {
  AgentRuntime,
  CreateSubagentInput,
  GithubAppConfig,
  InstallableRepo,
  RelayEndpointConfig,
  RelayEndpointInput,
  RelayUsageResponse,
  Repository,
  RuntimeModel,
  RuntimeSettings,
  SchedulingSettings,
} from "@agent-kanban/shared";
import { getAuthToken, refreshAuthToken } from "./auth-client";

const API_BASE = "/api";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getAuthToken() ?? (await refreshAuthToken());
  if (!token) throw new Error("NOT_AUTHENTICATED");

  let res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    const freshToken = await refreshAuthToken();
    if (freshToken) {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${freshToken}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    }
  }

  const data = (await res.json()) as any;

  if (!res.ok) {
    const err = new Error(data.error?.message || `HTTP ${res.status}`);
    (err as any).code = data.error?.code || "UNKNOWN";
    (err as any).status = res.status;
    throw err;
  }

  return data as T;
}

export const api = {
  tasks: {
    list: (params?: Record<string, string>) => {
      const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
      return request<any[]>("GET", `/tasks${qs}`);
    },
    get: (id: string) => request<any>("GET", `/tasks/${id}`),
    session: (id: string) => request<any>("GET", `/tasks/${id}/session`),
    sessionWs: (id: string) => request<{ url: string }>("GET", `/tasks/${id}/session/ws`),
    create: (input: Record<string, unknown>) => request<any>("POST", "/tasks", input),
    update: (id: string, body: Record<string, unknown>) => request<any>("PATCH", `/tasks/${id}`, body),
    delete: (id: string) => request<void>("DELETE", `/tasks/${id}`),
    claim: (id: string) => request<any>("POST", `/tasks/${id}/claim`),
    complete: (id: string) => request<any>("POST", `/tasks/${id}/complete`),
    release: (id: string) => request<any>("POST", `/tasks/${id}/release`),
    retry: (id: string) => request<any>("POST", `/tasks/${id}/retry`),
    errors: (id: string) => request<any[]>("GET", `/tasks/${id}/errors`),
    cancel: (id: string) => request<any>("POST", `/tasks/${id}/cancel`),
    review: (id: string) => request<any>("POST", `/tasks/${id}/review`),
    reject: (id: string) => request<any>("POST", `/tasks/${id}/reject`),
    assign: (id: string, agentId: string) => request<any>("POST", `/tasks/${id}/assign`, { agent_id: agentId }),
    addNote: (id: string, detail: string) => request<any>("POST", `/tasks/${id}/notes`, { detail }),
    getNotes: (id: string, since?: string) => {
      const qs = since ? `?since=${encodeURIComponent(since)}` : "";
      return request<any[]>("GET", `/tasks/${id}/notes${qs}`);
    },
  },
  messages: {
    list: (taskId: string, since?: string) => {
      const qs = since ? `?since=${encodeURIComponent(since)}` : "";
      return request<any[]>("GET", `/tasks/${taskId}/messages${qs}`);
    },
    create: (taskId: string, body: { sender_type: string; sender_id: string; content: string }) =>
      request<any>("POST", `/tasks/${taskId}/messages`, body),
  },
  sessions: {
    list: (params?: { limit?: number; cursor?: string; state?: string; archived?: boolean; labelSelector?: string }) => {
      const query = new URLSearchParams();
      if (params?.limit !== undefined) query.set("limit", String(params.limit));
      if (params?.cursor) query.set("cursor", params.cursor);
      if (params?.state) query.set("state", params.state);
      if (params?.archived !== undefined) query.set("archived", String(params.archived));
      if (params?.labelSelector) query.set("labelSelector", params.labelSelector);
      const qs = query.size > 0 ? `?${query.toString()}` : "";
      return request<{ data: any[]; pagination: any }>("GET", `/sessions${qs}`);
    },
    get: (id: string) => request<any>("GET", `/sessions/${id}`),
    sessionWs: (id: string) => request<{ url: string }>("GET", `/sessions/${id}/ws`),
  },
  agents: {
    list: (params?: Record<string, string>) => {
      const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
      return request<any[]>("GET", `/agents${qs}`);
    },
    get: (id: string) => request<any>("GET", `/agents/${id}`),
    create: (input: {
      name?: string;
      username: string;
      bio?: string;
      soul?: string;
      role?: string;
      handoff_to?: string[];
      runtime: AgentRuntime;
      model?: string;
      skills?: string[];
    }) => request<any>("POST", "/agents", input),
    update: (id: string, body: Record<string, unknown>) => request<any>("PATCH", `/agents/${id}`, body),
    delete: (id: string) => request<void>("DELETE", `/agents/${id}`),
    inbox: (agentId: string) => request<{ emails: any[] }>("GET", `/agents/${agentId}/inbox`),
    inboxEmail: (agentId: string, emailId: string) => request<any>("GET", `/agents/${agentId}/inbox/${emailId}`),
    sessions: (agentId: string) => request<any[]>("GET", `/agents/${agentId}/sessions`),
  },
  machines: {
    list: () => request<any[]>("GET", "/machines"),
    get: (id: string) => request<any>("GET", `/machines/${id}`),
    createCloud: (input?: { name?: string }) => request<any>("POST", "/machines/cloud", input ?? {}),
    delete: (id: string) => request<void>("DELETE", `/machines/${id}`),
  },
  ama: {
    provision: () => request<{ ok: boolean; project_id: string }>("POST", "/ama/provision"),
  },
  subagents: {
    list: () => request<any[]>("GET", "/subagents"),
    get: (id: string) => request<any>("GET", `/subagents/${id}`),
    create: (input: CreateSubagentInput) => request<any>("POST", "/subagents", input),
    update: (id: string, body: Partial<CreateSubagentInput>) => request<any>("PATCH", `/subagents/${id}`, body),
    delete: (id: string) => request<void>("DELETE", `/subagents/${id}`),
  },
  boards: {
    list: () => request<any[]>("GET", "/boards"),
    get: (id: string) => request<any>("GET", `/boards/${id}`),
    create: (input: { name: string; type: "dev" | "ops"; description?: string }) => request<any>("POST", "/boards", input),
    update: (id: string, body: { name?: string; description?: string; visibility?: "private" | "public"; labels?: any[] }) =>
      request<any>("PATCH", `/boards/${id}`, body),
    createLabel: (id: string, body: { name: string; color: string; description?: string }) => request<any>("POST", `/boards/${id}/labels`, body),
    updateLabel: (id: string, name: string, body: { name?: string; color?: string; description?: string }) =>
      request<any>("PATCH", `/boards/${id}/labels/${encodeURIComponent(name)}`, body),
    deleteLabel: (id: string, name: string) => request<any>("DELETE", `/boards/${id}/labels/${encodeURIComponent(name)}`),
    maintainers: (id: string) => request<any[]>("GET", `/boards/${id}/maintainers`),
    getMaintainer: (id: string, maintainerId: string) => request<any>("GET", `/boards/${id}/maintainers/${maintainerId}`),
    maintainerVariables: (id: string, maintainerId: string) =>
      request<{ data: { name: string }[]; credential_id: string | null; updated_at: string | null }>(
        "GET",
        `/boards/${id}/maintainers/${maintainerId}/variables`,
      ),
    updateMaintainerVariables: (id: string, maintainerId: string, body: { variables: Record<string, string> }) =>
      request<{ data: { name: string }[]; credential_id: string | null; updated_at: string | null }>(
        "PUT",
        `/boards/${id}/maintainers/${maintainerId}/variables`,
        body,
      ),
    maintainerRuns: (id: string, maintainerId: string, limit = 100) =>
      request<{ data: any[]; pagination: any }>("GET", `/boards/${id}/maintainers/${maintainerId}/runs?limit=${limit}`),
    maintainerMemories: (id: string, maintainerId: string, limit = 100) =>
      request<{ data: any[]; pagination: any }>("GET", `/boards/${id}/maintainers/${maintainerId}/memories?limit=${limit}`),
    createMaintainer: (id: string, body: Record<string, unknown>) => request<any>("POST", `/boards/${id}/maintainers`, body),
    updateMaintainer: (id: string, maintainerId: string, body: Record<string, unknown>) =>
      request<any>("PATCH", `/boards/${id}/maintainers/${maintainerId}`, body),
    deleteMaintainer: (id: string, maintainerId: string) => request<any>("DELETE", `/boards/${id}/maintainers/${maintainerId}`),
    delete: (id: string) => request<void>("DELETE", `/boards/${id}`),
  },
  share: {
    getBoard: (slug: string) =>
      fetch(`/api/share/${slug}`).then((r) => {
        if (!r.ok) throw new Error("Board not found");
        return r.json();
      }) as Promise<any>,
  },
  repositories: {
    list: () => request<Repository[]>("GET", "/repositories"),
    create: (input: { name: string; url: string }) => request<Repository>("POST", "/repositories", input),
    delete: (id: string) => request<void>("DELETE", `/repositories/${id}`),
  },
  githubApp: {
    config: () => request<GithubAppConfig>("GET", "/github-app/config"),
    installableRepos: () => request<{ installed: boolean; repositories: InstallableRepo[] }>("GET", "/github-app/repositories"),
  },
  settings: {
    getScheduling: () => request<SchedulingSettings>("GET", "/settings/scheduling"),
    putScheduling: (settings: SchedulingSettings) => request<SchedulingSettings>("PUT", "/settings/scheduling", settings),
    getRuntime: () => request<RuntimeSettings>("GET", "/settings/runtime"),
    putRuntime: (settings: RuntimeSettings) => request<RuntimeSettings>("PUT", "/settings/runtime", settings),
  },
  relays: {
    list: () => request<RelayEndpointConfig[]>("GET", "/relays"),
    create: (input: RelayEndpointInput) => request<RelayEndpointConfig>("POST", "/relays", input),
    update: (id: string, input: RelayEndpointInput) => request<RelayEndpointConfig>("PUT", `/relays/${id}`, input),
    delete: (id: string) => request<void>("DELETE", `/relays/${id}`),
    usage: (id: string) => request<RelayUsageResponse>("GET", `/relays/${id}/usage`),
  },
  models: {
    list: (runtime: AgentRuntime) => request<RuntimeModel[]>("GET", `/models?runtime=${encodeURIComponent(runtime)}`),
  },
  admin: {
    getStats: () => request<any>("GET", "/admin/stats"),
    getMachines: () => request<any[]>("GET", "/admin/machines"),
  },
};
