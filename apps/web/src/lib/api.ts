import type { Repository } from "@agent-kanban/shared";
import { getAuthHeaders } from "./auth-client";

const API_VERSION = "2026-08-22";
const etags = new Map<string, string>();

type Page<T> = { items: T[]; pagination?: { nextPageToken?: string | null } };
type Problem = { detail?: string; title?: string; type?: string; error?: { message?: string; code?: string } };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if ((method === "PATCH" || method === "DELETE") && !etags.has(path)) await request<unknown>("GET", path);
  const authorization = await getAuthHeaders("ak");

  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      Accept: "application/json, application/problem+json",
      "Content-Type": "application/json",
      "API-Version": API_VERSION,
      ...authorization,
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

async function activeConnection(): Promise<any> {
  const id = await connectionId();
  const connection = (await connections()).find((candidate) => candidate.id === id);
  if (!connection) throw new Error(`AMA connection '${id}' is not available.`);
  return connection;
}

async function runnerCommand(environmentId: string): Promise<string> {
  const id = await connectionId();
  const values = await connections();
  const connection = values.find((candidate) => candidate.id === id);
  const apiServer = new URL(connection.resourceUrl).origin;
  const projectId = decodeURIComponent(new URL(connection.projectUri).pathname.split("/").filter(Boolean).at(-1) ?? "");
  return `ama-runner auth login --api-server "${apiServer}"\n\nama-runner --api-server "${apiServer}" --project-id "${projectId}" --environment-id "${environmentId}"`;
}

async function amaRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!path.startsWith("/api/v1/") || path.startsWith("//")) throw new Error("AMA request path is invalid.");
  const connection = await activeConnection();
  const projectId = decodeURIComponent(new URL(connection.projectUri).pathname.split("/").filter(Boolean).at(-1) ?? "");
  const authorization = await getAuthHeaders("ama");
  if (!authorization.authorization) throw new Error("Realmroot AMA authorization is required.");
  const response = await fetch(new URL(path, new URL(connection.resourceUrl).origin), {
    method,
    headers: {
      Accept: "application/json, application/problem+json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...authorization,
      "X-AMA-Project-ID": projectId,
      ...(method === "POST" ? { "Idempotency-Key": crypto.randomUUID() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 204) return undefined as T;
  let data: Problem | T;
  try {
    data = (await response.json()) as Problem | T;
  } catch {
    throw new Error(`AMA returned an invalid JSON response for ${method} ${path}.`);
  }
  if (!response.ok) {
    const problem = data as Problem;
    const error = new Error(problem?.detail || problem?.error?.message || problem?.title || `AMA HTTP ${response.status}`);
    Object.assign(error, {
      status: response.status,
      code: problem?.type || problem?.error?.code || "AMA_REQUEST_FAILED",
      requestId: response.headers.get("Request-Id") ?? undefined,
    });
    throw error;
  }
  return data as T;
}

async function amaItems<T>(path: string): Promise<T[]> {
  const values: T[] = [];
  const target = new URL(path, "http://ama.local");
  const cursors = new Set<string>();
  for (let page = 0; page < 1_000; page += 1) {
    const result = await amaRequest<{ data?: T[]; pagination?: { hasMore?: boolean; nextCursor?: string | null } }>(
      "GET",
      `${target.pathname}${target.search}`,
    );
    if (!Array.isArray(result.data)) invalidAmaRepresentation("collection");
    values.push(...result.data);
    if (!result.pagination?.hasMore) return values;
    const cursor = result.pagination.nextCursor;
    if (!cursor || cursors.has(cursor)) throw new Error("AMA returned invalid cursor pagination metadata.");
    cursors.add(cursor);
    target.searchParams.set("cursor", cursor);
  }
  throw new Error("AMA collection exceeded the pagination safety limit.");
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
  return (await amaItems<any>("/api/v1/agents?limit=100")).map(mapAgent);
}

async function createAgent(input: any): Promise<any> {
  return amaRequest<any>("POST", "/api/v1/agents", {
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
  return (await amaMachines()).map(mapMachine);
}

async function amaMachines(): Promise<any[]> {
  const [environmentResult, runnerResult, sessionResult, agentResult] = await Promise.allSettled([
    amaItems<any>("/api/v1/environments?limit=100"),
    amaItems<any>("/api/v1/runners?limit=100"),
    amaItems<any>("/api/v1/sessions?limit=100"),
    amaItems<any>("/api/v1/agents?limit=100"),
  ]);
  if (environmentResult.status === "rejected") throw environmentResult.reason;
  const environments = environmentResult.value;
  const runners = runnerResult.status === "fulfilled" ? runnerResult.value : [];
  const sessions = sessionResult.status === "fulfilled" ? sessionResult.value : [];
  const agents = agentResult.status === "fulfilled" ? agentResult.value : [];
  const warnings = [
    ...(runnerResult.status === "rejected" ? ["AMA Runners are temporarily unavailable."] : []),
    ...(sessionResult.status === "rejected" ? ["AMA Sessions are temporarily unavailable."] : []),
    ...(agentResult.status === "rejected" ? ["AMA Agents are temporarily unavailable."] : []),
  ];
  const machine = (environment: any | null, attached: any[]) => {
    const relatedSessions = sessions.filter((session) => session.spec?.environmentId === environment?.metadata?.uid);
    const heartbeats = attached
      .map((runner) => runner.lastHeartbeatAt)
      .filter((value): value is string => typeof value === "string")
      .sort();
    return {
      id: environment?.metadata?.uid ?? `runner-${attached[0].id}`,
      name: environment?.metadata?.name ?? attached[0]?.name ?? "Unbound runner",
      description: environment?.metadata?.description ?? null,
      type: environment?.spec?.type ?? "self_hosted",
      phase: environment?.status?.phase ?? "active",
      status: attached.some((runner) => runner.state === "active") ? "online" : "offline",
      lastHeartbeatAt: heartbeats.at(-1) ?? null,
      sessionCount: relatedSessions.length,
      activeSessionCount: relatedSessions.filter((session) => ["pending", "running", "idle"].includes(session.status?.phase)).length,
      runtimes: attached.flatMap((runner) => runner.runtimes ?? []),
      runners: attached,
      sessions: relatedSessions,
      agents: agents.filter((agent) => relatedSessions.some((session) => session.spec?.agentId === agent.metadata?.uid)),
      warnings,
      environment,
    };
  };
  const result = environments.map((environment) =>
    machine(
      environment,
      runners.filter((runner) => runner.environmentId === environment.metadata?.uid),
    ),
  );
  for (const runner of runners.filter((item) => !item.environmentId)) result.push(machine(null, [runner]));
  return result;
}

function createAmaEnvironment(name: string, type: "cloud" | "self_hosted") {
  return amaRequest<any>("POST", "/api/v1/environments", {
    metadata: { name, description: null },
    spec: {
      scope: "project",
      type,
      networking: { type: "open", allowMcpServers: true, allowPackageManagers: true },
      packages: { type: "packages", apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
      variables: {},
    },
  });
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
    get: async (id: string) => mapAgent(await amaRequest<any>("GET", `/api/v1/agents/${encodeURIComponent(id)}`)),
    create: createAgent,
    update: async (id: string, body: Record<string, unknown>) => {
      return amaRequest<any>("PATCH", `/api/v1/agents/${encodeURIComponent(id)}`, {
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
      return amaRequest<void>("DELETE", `/api/v1/agents/${encodeURIComponent(id)}`);
    },
    inbox: async (_id?: string): Promise<any> => ({ emails: [] }),
    inboxEmail: async (_id?: string, _emailId?: string): Promise<any> => null,
    sessions: async (agentId: string) => {
      return (await amaItems<any>("/api/v1/sessions?limit=100")).filter((session) => session.spec?.agentId === agentId);
    },
  },
  machines: {
    list: listMachines,
    get: async (id: string) => {
      const machine = (await amaMachines()).find((candidate) => candidate.id === id);
      if (!machine) throw new Error("AMA has no matching Machine.");
      return mapMachine(machine);
    },
    createCloud: async (input: { name?: string } = {}) => {
      return createAmaEnvironment(input.name ?? "Cloud Sandbox", "cloud");
    },
    createSelfHosted: async (input: { name: string }) => {
      return createAmaEnvironment(input.name, "self_hosted");
    },
    runnerCommand,
    delete: async (id: string) => {
      return amaRequest<void>("DELETE", `/api/v1/environments/${encodeURIComponent(id)}`);
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
