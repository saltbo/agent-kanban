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

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "API-Version": V2_API_VERSION,
      ...headers,
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    },
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = res.status === 204 ? undefined : ((await res.json()) as any);

  if (!res.ok) throw apiError(res, data);

  return data as T;
}

async function currentTaskReviewSubmissionEtag(taskId: string): Promise<string> {
  const response = await fetch(`${API_BASE}/task-review-submissions/${encodeURIComponent(taskId)}`, {
    headers: { "API-Version": V2_API_VERSION },
    credentials: "include",
  });
  const data = (await response.json()) as any;
  if (!response.ok) throw apiError(response, data);
  const etag = response.headers.get("etag");
  if (!etag) throw new Error("Task Review Submission response is missing its ETag");
  return etag;
}

async function replaceTaskReviewDecision(taskId: string, decision: "rejection" | "completion", reason?: string): Promise<any> {
  const etag = await currentTaskReviewSubmissionEtag(taskId);
  const reviewSubmissionVersion = etag.replace(/^"|"$/g, "");
  const body = decision === "rejection" && reason ? { reviewSubmissionVersion, reason } : { reviewSubmissionVersion };
  return request<any>("PUT", `/task-review-${decision}s/${encodeURIComponent(taskId)}`, body);
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
    complete: (id: string) => replaceTaskReviewDecision(id, "completion"),
    reject: (id: string, reason?: string) => replaceTaskReviewDecision(id, "rejection", reason),
    addNote: (id: string, detail: string) => request<any>("POST", `/tasks/${id}/notes`, { detail }),
    getNotes: (id: string, since?: string) => {
      const qs = since ? `?since=${encodeURIComponent(since)}` : "";
      return request<any[]>("GET", `/tasks/${id}/notes${qs}`);
    },
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
    config: () => request<GithubAppConfig>("GET", "/github-app/config"),
    installableRepos: () => request<{ installed: boolean; repositories: InstallableRepo[] }>("GET", "/github-app/repositories"),
  },
};
