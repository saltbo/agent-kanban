import { type GithubAppConfig, type InstallableRepo, type Repository, V2_API_VERSION } from "@shared";
import { getCsrfToken, getSession } from "./auth-client";

const API_BASE = "/api";

function apiError(response: Response, data: any): Error {
  const error = new Error(data.error?.message || data.detail || `HTTP ${response.status}`);
  (error as any).code = data.error?.code || data.type || "UNKNOWN";
  (error as any).status = response.status;
  return error;
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let csrf = getCsrfToken();
  if (!csrf && method !== "GET") csrf = (await getSession())?.session.csrfToken ?? null;

  const requestHeaders = { ...headers };
  if (requiresIdempotencyKey(method, path)) {
    const supplied = requestHeaders["Idempotency-Key"];
    requestHeaders["Idempotency-Key"] = supplied?.startsWith('"') ? supplied : `"${supplied ?? crypto.randomUUID()}"`;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "API-Version": V2_API_VERSION,
      ...requestHeaders,
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    },
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = res.status === 204 ? undefined : ((await res.json()) as any);

  if (!res.ok) throw apiError(res, data);

  return data as T;
}

function requiresIdempotencyKey(method: string, path: string): boolean {
  return method === "POST" && (path === "/tasks" || path === "/agents" || path === "/machines" || /^\/tasks\/[^/]+\/(?:notes|claims)$/.test(path));
}

async function allPageItems<T>(path: string, params?: URLSearchParams): Promise<T[]> {
  const query = new URLSearchParams(params);
  const items: T[] = [];
  while (true) {
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const page = await request<{ items: T[]; pagination: { nextPageToken?: string } }>("GET", `${path}${suffix}`);
    items.push(...page.items);
    if (!page.pagination.nextPageToken) return items;
    query.set("pageToken", page.pagination.nextPageToken);
  }
}

function fromBoard(board: any): any {
  return {
    ...board,
    owner_id: board.ownerId,
    share_slug: board.shareSlug,
    tasks: board.tasks?.map(fromTask),
    created_at: board.createdAt,
    updated_at: board.updatedAt,
  };
}

function fromTaskNote(note: any): any {
  return {
    ...note,
    task_id: note.taskId,
    actor_type: note.actorType,
    actor_id: note.actorId,
    actor_name: note.actorName,
    created_at: note.createdAt,
  };
}

function fromTask(task: any): any {
  return {
    ...task,
    status: task.status?.replaceAll("-", "_"),
    board_id: task.boardId,
    repository_id: task.repositoryId,
    repository_name: task.repositoryName,
    created_by: task.createdBy,
    assigned_to: task.assignedTo,
    assignee_name: task.assigneeName,
    board_type: task.boardType,
    pr_url: task.pullRequestUrl,
    created_from: task.createdFrom,
    scheduled_at: task.scheduledAt,
    depends_on: task.dependsOn,
    duration_minutes: task.durationMinutes,
    subtask_count: task.subtaskCount,
    session_binding: task.sessionBinding
      ? {
          agent_actor_id: task.sessionBinding.agentActorId,
          runtime: task.sessionBinding.runtime,
          runtime_session_id: task.sessionBinding.runtimeSessionId,
          bound_at: task.sessionBinding.boundAt,
        }
      : null,
    notes: task.notes?.map(fromTaskNote),
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

function fromRepository(repository: any): Repository {
  return {
    ...repository,
    owner_id: repository.ownerId,
    full_name: repository.fullName,
    created_at: repository.createdAt,
    task_count: repository.taskCount,
    app_status: repository.appStatus,
  };
}

function taskWrite(input: Record<string, unknown>): Record<string, unknown> {
  const result = { ...input };
  for (const [legacy, canonical] of Object.entries({
    board_id: "boardId",
    repository_id: "repositoryId",
    pr_url: "pullRequestUrl",
    depends_on: "dependsOn",
    created_from: "createdFrom",
    scheduled_at: "scheduledAt",
  })) {
    if (result[legacy] !== undefined) result[canonical] = result[legacy];
    delete result[legacy];
  }
  return result;
}

async function currentTaskEtag(taskId: string): Promise<string> {
  const response = await fetch(`${API_BASE}/tasks/${encodeURIComponent(taskId)}`, {
    headers: { "API-Version": V2_API_VERSION },
    credentials: "include",
  });
  const data = (await response.json()) as any;
  if (!response.ok) throw apiError(response, data);
  const etag = response.headers.get("etag");
  if (!etag) throw new Error("Task response is missing its ETag");
  return etag;
}

async function patchTask(taskId: string, body: Record<string, unknown>): Promise<any> {
  return request<any>("PATCH", `/tasks/${encodeURIComponent(taskId)}`, body, {
    "Content-Type": "application/merge-patch+json",
  });
}

export const api = {
  tasks: {
    list: (params?: Record<string, string>) => {
      const query = new URLSearchParams(params);
      for (const [legacy, canonical] of Object.entries({ repository_id: "repositoryId", board_id: "boardId", assigned_to: "assignedTo" })) {
        const value = query.get(legacy);
        if (value !== null) query.set(canonical, value);
        query.delete(legacy);
      }
      return allPageItems<any>("/tasks", query).then((items) => items.map(fromTask));
    },
    get: (id: string) => request<any>("GET", `/tasks/${id}`).then(fromTask),
    session: (id: string) => request<any>("GET", `/tasks/${id}/session`),
    sessionWs: (id: string) => request<{ url: string }>("GET", `/tasks/${id}/session/ws`),
    create: (input: Record<string, unknown>) => request<any>("POST", "/tasks", taskWrite(input)).then(fromTask),
    update: (id: string, body: Record<string, unknown>) => patchTask(id, taskWrite(body)).then(fromTask),
    delete: async (id: string) => {
      const etag = await currentTaskEtag(id);
      return request<void>("DELETE", `/tasks/${id}`, undefined, { "If-Match": etag });
    },
    complete: (id: string) => patchTask(id, { status: "done" }).then(fromTask),
    reject: (id: string, reason?: string) => patchTask(id, { status: "in-progress", ...(reason ? { statusReason: reason } : {}) }).then(fromTask),
    addNote: (id: string, detail: string) => request<any>("POST", `/tasks/${id}/notes`, { detail }).then(fromTaskNote),
    getNotes: (id: string, since?: string) => {
      const query = new URLSearchParams(since ? { since } : {});
      return allPageItems<any>(`/tasks/${id}/notes`, query).then((items) => items.map(fromTaskNote));
    },
  },
  boards: {
    list: () => allPageItems<any>("/boards").then((items) => items.map(fromBoard)),
    get: (id: string) => request<any>("GET", `/boards/${id}`).then(fromBoard),
    create: (input: { name: string; type: "dev" | "ops"; description?: string }) => request<any>("POST", "/boards", input).then(fromBoard),
    update: (id: string, body: { name?: string; description?: string; visibility?: "private" | "public"; labels?: any[] }) =>
      request<any>("PATCH", `/boards/${id}`, body).then(fromBoard),
    createLabel: (id: string, body: { name: string; color: string; description?: string }) =>
      request<any>("POST", `/boards/${id}/labels`, body).then(fromBoard),
    updateLabel: (id: string, name: string, body: { name?: string; color?: string; description?: string }) =>
      request<any>("PATCH", `/boards/${id}/labels/${encodeURIComponent(name)}`, body).then(fromBoard),
    deleteLabel: (id: string, name: string) => request<any>("DELETE", `/boards/${id}/labels/${encodeURIComponent(name)}`).then(fromBoard),
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
    list: () => allPageItems<any>("/repositories").then((items) => items.map(fromRepository)),
    create: (input: { name: string; url: string }) => request<any>("POST", "/repositories", input).then(fromRepository),
    delete: (id: string) => request<void>("DELETE", `/repositories/${id}`),
  },
  agents: {
    list: (params?: { search?: string; runtime?: string; schedulable?: boolean }) => {
      const query = new URLSearchParams();
      if (params?.search) query.set("search", params.search);
      if (params?.runtime) query.set("runtime", params.runtime);
      if (params?.schedulable !== undefined) query.set("schedulable", String(params.schedulable));
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return request<{ items: any[] }>("GET", `/agents${suffix}`);
    },
    get: (id: string) => request<any>("GET", `/agents/${encodeURIComponent(id)}`),
  },
  machines: {
    list: () => request<{ items: any[] }>("GET", "/machines"),
    get: (id: string) => request<any>("GET", `/machines/${encodeURIComponent(id)}`),
    create: (idempotencyKey: string) => request<any>("POST", "/machines", undefined, { "Idempotency-Key": idempotencyKey }),
    delete: (id: string) => request<void>("DELETE", `/machines/${encodeURIComponent(id)}`),
  },
  githubApp: {
    config: () => request<any>("GET", "/github-app/config").then((config): GithubAppConfig => ({ ...config, install_url: config.installUrl })),
    installableRepos: () =>
      request<{ installed: boolean; repositories: any[] }>("GET", "/github-app/repositories").then(
        (result): { installed: boolean; repositories: InstallableRepo[] } => ({
          installed: result.installed,
          repositories: result.repositories.map((repository) => ({
            ...repository,
            full_name: repository.fullName,
            clone_url: repository.cloneUrl,
            already_added: repository.alreadyAdded,
          })),
        }),
      ),
    acceptInstallation: (installationId: number) => request<void>("PUT", `/repository-installations/${installationId}`),
  },
};
