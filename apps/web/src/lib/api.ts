import type { Repository } from "@agent-kanban/shared";
import { getCsrfToken, getSession } from "./auth-client";

const API_VERSION = "2026-08-22";
const etags = new Map<string, string>();

type Page<T> = { items: T[]; pagination?: { nextPageToken?: string | null } };
type Problem = { detail?: string; title?: string; type?: string; error?: { message?: string; code?: string } };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let csrf = getCsrfToken();
  if (!csrf && method !== "GET") csrf = (await getSession())?.session.csrfToken ?? null;
  if ((method === "PATCH" || method === "DELETE") && !etags.has(path)) await request<unknown>("GET", path);

  const response = await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: {
      Accept: "application/json, application/problem+json",
      "Content-Type": "application/json",
      "API-Version": API_VERSION,
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...(method === "POST" ? { "Idempotency-Key": crypto.randomUUID() } : {}),
      ...(method === "PATCH" || method === "DELETE" ? { "If-Match": etags.get(path)! } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const responseEtag = response.headers.get("ETag");
  if (responseEtag) etags.set(path, responseEtag);
  if (response.status === 204) return undefined as T;
  let data: Problem | T;
  try {
    data = (await response.json()) as Problem | T;
  } catch {
    throw new Error(`The server returned an invalid JSON response for ${method} ${path}.`);
  }
  if (!response.ok) {
    const problem = data as Problem;
    const error = new Error(problem?.detail || problem?.error?.message || problem?.title || `HTTP ${response.status}`);
    Object.assign(error, {
      status: response.status,
      code: problem?.type || problem?.error?.code || "UNKNOWN",
      requestId: response.headers.get("Request-Id") ?? undefined,
    });
    throw error;
  }
  return data as T;
}

async function items<T>(path: string): Promise<T[]> {
  const result: T[] = [];
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;
  let pageCount = 0;
  do {
    if (pageToken && seenPageTokens.has(pageToken)) throw new Error(`The server repeated a pagination token for GET ${path}.`);
    if (pageToken) seenPageTokens.add(pageToken);
    pageCount += 1;
    if (pageCount > 1_000) throw new Error(`The collection for GET ${path} exceeded the pagination safety limit.`);
    const url = new URL(path, "http://ak.local");
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await request<Page<T>>("GET", `${url.pathname}${url.search}`);
    if (!Array.isArray(page.items)) throw new Error(`The server returned an invalid collection for GET ${path}.`);
    result.push(...page.items);
    pageToken = page.pagination?.nextPageToken ?? undefined;
  } while (pageToken);
  return result;
}

function connections(): Promise<any[]> {
  return items<any>("/ama-connections");
}
export function selectedAmaConnection(): string | null {
  return new URLSearchParams(window.location.search).get("connection");
}
async function connectionId(): Promise<string> {
  const explicit = selectedAmaConnection();
  const values = await connections();
  const active = values.filter((connection) => connection.status === "active");
  if (explicit) {
    if (!active.some((connection) => connection.id === explicit)) throw new Error(`AMA connection '${explicit}' is not available.`);
    return explicit;
  }
  if (active.length === 0) throw new Error("No active AMA connection is configured.");
  return active[0].id;
}

async function runnerCommand(environmentId: string): Promise<string> {
  const id = await connectionId();
  const values = await connections();
  const connection = values.find((candidate) => candidate.id === id);
  const apiServer = new URL(connection.resourceUrl).origin;
  const projectId = decodeURIComponent(new URL(connection.projectUri).pathname.split("/").filter(Boolean).at(-1) ?? "");
  return `ama-runner auth login --api-server "${apiServer}"\n\nama-runner --api-server "${apiServer}" --project-id "${projectId}" --environment-id "${environmentId}"`;
}

function amaPath(connection: string, suffix: string): string {
  return `/console/ama-connections/${encodeURIComponent(connection)}${suffix}`;
}

function invalidAmaRepresentation(kind: string): never {
  const error = new Error(`AMA returned an invalid ${kind} representation.`);
  Object.assign(error, { code: "https://agent-kanban.dev/problems/ama-invalid-response" });
  throw error;
}

function mapAgent(agent: any): any {
  if (
    !agent ||
    typeof agent !== "object" ||
    typeof agent.metadata?.uid !== "string" ||
    typeof agent.metadata?.name !== "string" ||
    typeof agent.identity?.issuer !== "string" ||
    typeof agent.identity?.subject !== "string" ||
    typeof agent.spec?.runtime !== "string" ||
    typeof agent.status?.ready !== "boolean"
  )
    invalidAmaRepresentation("Agent");
  const identitySeed = `${agent.identity?.issuer ?? ""}|${agent.identity?.subject ?? agent.metadata.uid}`;
  return {
    id: agent.metadata.uid,
    owner_id: agent.metadata.projectId,
    name: agent.metadata.name,
    username: agent.identity?.username ?? agent.metadata.uid,
    bio: agent.metadata.description ?? null,
    soul: agent.spec?.systemPrompt ?? null,
    runtime: agent.spec?.runtime === "claude-code" ? "claude" : (agent.spec?.runtime ?? "ama"),
    model: agent.spec?.model ?? null,
    skills: agent.spec?.skills ?? [],
    version: "latest",
    identity_key: identitySeed,
    ama_agent_id: agent.metadata.uid,
    metadata: agent.metadata,
    identity: agent.identity,
    spec: agent.spec,
    phase: agent.status?.phase,
    created_at: agent.metadata.createdAt,
    updated_at: agent.metadata.updatedAt,
    email: "",
    status: {
      ready: agent.status?.ready === true,
      phase: agent.status?.phase,
    },
    logs: [],
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_micro_usd: 0,
  };
}

function mapMachine(machine: any) {
  if (
    !machine ||
    typeof machine !== "object" ||
    typeof machine.id !== "string" ||
    typeof machine.name !== "string" ||
    typeof machine.status !== "string" ||
    !Array.isArray(machine.runners) ||
    !Array.isArray(machine.sessions) ||
    !Array.isArray(machine.agents)
  )
    invalidAmaRepresentation("Machine");
  const environment = machine.environment;
  const runtimes = (machine.runtimes ?? []).map((runtime: any) => ({
    name: runtime.runtime,
    status: runtime.state === "ready" ? "ready" : runtime.state === "missing" ? "missing" : "unhealthy",
    detail: [runtime.version, ...(runtime.models ?? [])].filter(Boolean).join(" · "),
    checked_at: machine.lastHeartbeatAt ?? environment?.metadata?.updatedAt ?? new Date(0).toISOString(),
  }));
  const sessions = machine.sessions ?? [];
  return {
    ...machine,
    status: machine.status,
    os:
      machine.runners
        ?.map((runner: any) => runner.metadata?.os)
        .filter(Boolean)
        .join(", ") || null,
    version: machine.runners?.flatMap((runner: any) => runner.runtimes?.map((runtime: any) => runtime.version).filter(Boolean)).join(", ") || null,
    last_heartbeat_at: machine.lastHeartbeatAt,
    session_count: machine.sessionCount,
    active_session_count: machine.activeSessionCount,
    created_at: environment?.metadata?.createdAt ?? machine.runners?.[0]?.createdAt ?? null,
    runtimes,
    usage_info: { windows: [], updated_at: machine.lastHeartbeatAt },
    agents: (machine.agents ?? []).map((agent: any) => {
      const agentSessions = sessions.filter((session: any) => session.spec?.agentId === agent.metadata.uid);
      const lastSession = [...agentSessions].sort((left, right) => {
        const leftTime = Date.parse(left.metadata?.createdAt ?? left.createdAt ?? "1970-01-01");
        const rightTime = Date.parse(right.metadata?.createdAt ?? right.createdAt ?? "1970-01-01");
        return rightTime - leftTime;
      })[0];
      return {
        ...mapAgent(agent),
        active_session_count: agentSessions.filter((session: any) => ["pending", "running"].includes(session.status?.phase)).length,
        last_session_at: lastSession?.metadata?.createdAt ?? lastSession?.createdAt ?? null,
      };
    }),
    runner_only: environment == null,
  };
}

async function listAgents(_params?: Record<string, string>): Promise<any[]> {
  const connection = await connectionId();
  const page = await request<Page<any>>("GET", amaPath(connection, "/agents"));
  return page.items.map(mapAgent);
}

async function createAgent(input: any): Promise<any> {
  const connection = await connectionId();
  return request<any>("POST", amaPath(connection, "/agents"), {
    username: input.username,
    metadata: { name: input.name || input.username, description: input.bio ?? null },
    spec: {
      runtime: input.runtime === "claude" ? "claude-code" : input.runtime,
      systemPrompt: input.soul?.trim() || `Work as ${input.name || input.username}.`,
      ...("provider" in input ? { provider: input.provider ?? null } : {}),
      ...("model" in input ? { model: input.model ?? null } : {}),
      ...(Array.isArray(input.skills) ? { skills: input.skills } : {}),
      ...(Array.isArray(input.subagents) ? { subagents: input.subagents } : {}),
      ...(Array.isArray(input.allowedTools) ? { allowedTools: input.allowedTools } : {}),
      ...(Array.isArray(input.mcpConnectors) ? { mcpConnectors: input.mcpConnectors } : {}),
    },
  });
}

async function listMachines() {
  const connection = await connectionId();
  return (await request<Page<any>>("GET", amaPath(connection, "/machines"))).items.map(mapMachine);
}

async function boardView(id: string) {
  const [board, tasks, labels, repositories] = await Promise.all([
    request<any>("GET", `/boards/${id}`),
    items<any>(`/boards/${id}/tasks`),
    items<any>(`/boards/${id}/labels`),
    items<any>("/repositories"),
  ]);
  const repos = new Map(repositories.map((repository) => [repository.id, repository.name]));
  return {
    ...board,
    tasks: tasks.map((task, index) => ({
      ...task,
      seq: index + 1,
      board_id: task.boardId,
      repository_id: task.repositoryId,
      repository_name: task.repositoryId ? repos.get(task.repositoryId) : null,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      labels: (task.labels ?? []).map((label: any) => label.name),
      assigned_to: task.assignment?.agentId ?? null,
      agent_name: task.assignment?.agentId ?? null,
      assignee_identity_key: task.assignment?.agentId ?? null,
      assignee: task.assignment,
    })),
    labels: labels.map((label) => ({ ...label, description: label.description ?? "" })),
  };
}

async function taskView(id: string): Promise<any> {
  const [task, dependencies, assignments, messages, submissions, runs, taskLabels] = await Promise.all([
    request<any>("GET", `/tasks/${id}`),
    items<any>(`/tasks/${id}/dependencies`),
    items<any>(`/tasks/${id}/assignments`),
    items<any>(`/tasks/${id}/messages`),
    items<any>(`/tasks/${id}/submissions`),
    items<any>(`/tasks/${id}/runs`),
    items<any>(`/tasks/${id}/labels`),
  ]);
  const assignment = assignments.find((candidate) => candidate.status === "active") ?? null;
  const [progressGroups, reviewGroups] = await Promise.all([
    Promise.all(runs.map((run) => items<any>(`/task-runs/${run.id}/progress-entries`))),
    Promise.all(submissions.map((submission) => items<any>(`/task-submissions/${submission.id}/reviews`))),
  ]);
  const progress = progressGroups.flat();
  const reviews = reviewGroups.flat();
  const artifacts = submissions.flatMap((submission) =>
    (submission.artifactUrls ?? []).map((url: string) => ({ submissionId: submission.id, summary: submission.summary, url })),
  );
  const firstRunAt = runs
    .map((run) => Date.parse(run.createdAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0];
  const finishedAt = ["done"].includes(task.status) ? Date.parse(task.updatedAt) : Number.NaN;
  const notes = [
    ...messages.map((message) => ({
      id: message.id,
      action: "commented",
      detail: message.body,
      actor_name: message.senderSubject,
      created_at: message.createdAt,
    })),
    ...progress.map((entry) => ({
      id: entry.id,
      action: entry.kind === "started" ? "claimed" : "commented",
      detail: entry.body,
      actor_name: assignment?.agentId ?? null,
      created_at: entry.createdAt,
    })),
    ...runs.map((run) => ({
      id: `started-${run.id}`,
      action: "claimed",
      detail: `Run ${run.id} ${run.status}.`,
      actor_name: assignment?.agentId ?? null,
      created_at: run.createdAt,
    })),
    ...reviews.map((review) => ({
      id: review.id,
      action: review.decision === "accepted" ? "completed" : "rejected",
      detail: review.body,
      actor_name: review.reviewerSubject,
      created_at: review.createdAt,
    })),
  ].sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
  return {
    ...task,
    seq: task.id,
    board_id: task.boardId,
    repository_id: task.repositoryId,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    depends_on: dependencies.map((dependency) => dependency.dependsOnTaskId),
    assigned_to: assignment?.agentId ?? null,
    agent_name: assignment?.agentId ?? null,
    assignee_identity_key: assignment?.agentId ?? null,
    labels: taskLabels.map((label) => label.name),
    notes,
    submissions,
    artifacts,
    pr_url: artifacts.find((artifact) => /\/pull\/\d+(?:[/?#]|$)/.test(artifact.url))?.url ?? null,
    runs,
    reviews,
    subtask_count: 0,
    duration_minutes: Number.isFinite(firstRunAt) && Number.isFinite(finishedAt) ? Math.max(0, (finishedAt - firstRunAt) / 60_000) : null,
  };
}

async function reviewTask(id: string, decision: "accepted" | "rejected", body: string) {
  const submissions = await items<any>(`/tasks/${id}/submissions`);
  const submission = submissions.find((candidate) => candidate.status === "pending_review");
  if (!submission) throw new Error("This task has no submission to review.");
  return request<any>("POST", `/task-submissions/${submission.id}/reviews`, {
    decision,
    body,
  });
}

export const api = {
  tasks: {
    list: async (params?: Record<string, string>) => {
      if (!params?.board_id) return [];
      return items<any>(`/boards/${params.board_id}/tasks`);
    },
    get: taskView,
    session: async (_id?: string) => null,
    sessionWs: async (_id?: string) => ({ url: "" }),
    create: (input: Record<string, unknown>) => request<any>("POST", `/boards/${input.board_id}/tasks`, input),
    update: (id: string, body: Record<string, unknown>) => request<any>("PATCH", `/tasks/${id}`, body),
    delete: (id: string) => request<void>("DELETE", `/tasks/${id}`),
    claim: async (_id?: string) => null,
    complete: (id: string, body = "Accepted from Agent Kanban.") => reviewTask(id, "accepted", body),
    release: async (_id?: string) => null,
    cancel: async (_id?: string) => null,
    review: async (_id?: string) => null,
    reject: (id: string, body: string) => reviewTask(id, "rejected", body),
    assign: async (_id?: string, _agentId?: string) => null,
    addNote: (id: string, detail: string) => request<any>("POST", `/tasks/${id}/messages`, { body: detail }),
    getNotes: async (_id?: string, _since?: string) => [],
  },
  messages: {
    list: (taskId: string) => items<any>(`/tasks/${taskId}/messages`),
    create: (taskId: string, body: { content: string }) => request<any>("POST", `/tasks/${taskId}/messages`, { body: body.content }),
  },
  sessions: {
    list: async (_params?: unknown): Promise<any> => ({ data: [], pagination: {} }),
    get: async (_id?: string): Promise<any> => null,
    sessionWs: async (_id?: string) => ({ url: "" }),
  },
  agents: {
    list: listAgents,
    get: async (id: string) => {
      const connection = await connectionId();
      return mapAgent(await request<any>("GET", amaPath(connection, `/agents/${encodeURIComponent(id)}`)));
    },
    create: createAgent,
    update: async (id: string, body: Record<string, unknown>) => {
      const connection = await connectionId();
      return request<any>("PATCH", amaPath(connection, `/agents/${encodeURIComponent(id)}`), {
        metadata: {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.bio === "string" ? { description: body.bio } : {}),
        },
        spec: {
          ...(typeof body.soul === "string" ? { systemPrompt: body.soul } : {}),
          ...(typeof body.runtime === "string" ? { runtime: body.runtime === "claude" ? "claude-code" : body.runtime } : {}),
          ...("provider" in body ? { provider: body.provider ?? null } : {}),
          ...("model" in body ? { model: body.model ?? null } : {}),
          ...(Array.isArray(body.skills) ? { skills: body.skills } : {}),
          ...(Array.isArray(body.subagents) ? { subagents: body.subagents } : {}),
          ...(Array.isArray(body.allowedTools) ? { allowedTools: body.allowedTools } : {}),
          ...(Array.isArray(body.mcpConnectors) ? { mcpConnectors: body.mcpConnectors } : {}),
        },
      });
    },
    delete: async (id: string) => {
      const connection = await connectionId();
      return request<void>("DELETE", amaPath(connection, `/agents/${encodeURIComponent(id)}`));
    },
    inbox: async (_id?: string): Promise<any> => ({ emails: [] }),
    inboxEmail: async (_id?: string, _emailId?: string): Promise<any> => null,
    sessions: async (agentId: string) => {
      const connection = await connectionId();
      const page = await request<Page<any>>("GET", amaPath(connection, "/sessions"));
      return page.items.filter((session) => session.spec?.agentId === agentId);
    },
  },
  machines: {
    list: listMachines,
    get: async (id: string) => {
      const connection = await connectionId();
      return mapMachine(await request<any>("GET", amaPath(connection, `/machines/${encodeURIComponent(id)}`)));
    },
    createCloud: async (input: { name?: string } = {}) => {
      const connection = await connectionId();
      return request<any>("POST", amaPath(connection, "/machines"), { name: input.name ?? "Cloud Sandbox", type: "cloud" });
    },
    createSelfHosted: async (input: { name: string }) => {
      const connection = await connectionId();
      return request<any>("POST", amaPath(connection, "/machines"), { ...input, type: "self_hosted" });
    },
    runnerCommand,
    delete: async (id: string) => {
      const connection = await connectionId();
      return request<void>("DELETE", amaPath(connection, `/machines/${encodeURIComponent(id)}`));
    },
  },
  ama: { provision: async () => ({ ok: true, project_id: await connectionId() }) },
  boards: {
    list: () => items<any>("/boards"),
    get: boardView,
    create: (input: { name: string; description?: string }) => request<any>("POST", "/boards", input),
    update: (id: string, body: Record<string, unknown>) => request<any>("PATCH", `/boards/${id}`, body),
    createLabel: (id: string, body: { name: string; color: string }) => request<any>("POST", `/boards/${id}/labels`, body),
    updateLabel: async (id: string, name: string, body: any): Promise<any> => {
      const label = (await items<any>(`/boards/${id}/labels`)).find((candidate) => candidate.name === name);
      if (!label) throw new Error(`Label '${name}' was not found.`);
      return request<any>("PATCH", `/labels/${label.id}`, body);
    },
    deleteLabel: async (id: string, name: string): Promise<any> => {
      const label = (await items<any>(`/boards/${id}/labels`)).find((candidate) => candidate.name === name);
      if (!label) throw new Error(`Label '${name}' was not found.`);
      return request<any>("DELETE", `/labels/${label.id}`);
    },
    delete: (id: string) => request<void>("DELETE", `/boards/${id}`),
  },
  share: { getBoard: async (_slug?: string): Promise<any> => null },
  repositories: {
    list: async () =>
      (await items<any>("/repositories")).map((repo) => ({ ...repo, owner_id: repo.tenantId, created_at: repo.createdAt, full_name: repo.name })),
    create: (input: { name: string; url: string }) => request<Repository>("POST", "/repositories", input),
    delete: (id: string) => request<void>("DELETE", `/repositories/${id}`),
  },
};
