import type { BoardWithTasks, MachineRuntime, UsageInfo } from "@agent-kanban/shared";
import { getVersion } from "../version.js";

const API_REQUEST_TIMEOUT_MS = 60_000;

export class ApiError extends Error {
  public code: string;

  constructor(
    public status: number,
    message: string,
    code = `HTTP_${status}`,
  ) {
    super(message);
    this.code = code;
  }
}

export abstract class ApiClient {
  protected baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  protected abstract authorizationHeaders(method: string, url: string): Promise<Record<string, string>>;

  sessionSocketHeaders(url: string): Promise<Record<string, string>> {
    const httpUrl = url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
    return this.authorizationHeaders("GET", httpUrl);
  }

  protected async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const doFetch = async () =>
      fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-CLI-Version": getVersion(),
          ...(await this.authorizationHeaders(method, url)),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
      });

    let res: Response;
    try {
      res = await doFetch();
    } catch (err: any) {
      if (err?.cause?.code === "ECONNRESET" && (method === "GET" || method === "HEAD")) {
        res = await doFetch();
      } else {
        throw err;
      }
    }

    const data = (await res.json()) as T & { error?: { code: string; message: string } };

    if (!res.ok) {
      let msg = (data as any).error?.message || `HTTP ${res.status}`;
      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After");
        if (retryAfter) msg += ` (retry after ${retryAfter}s)`;
      }
      throw new ApiError(res.status, msg, (data as any).error?.code);
    }

    return data;
  }

  // Tasks
  createTask(input: Record<string, unknown>) {
    return this.request("POST", "/api/tasks", input);
  }
  listTasks(params?: Record<string, string>) {
    const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
    return this.request("GET", `/api/tasks${qs}`);
  }
  getTask(id: string) {
    return this.request("GET", `/api/tasks/${id}`);
  }
  getTaskSession(id: string) {
    return this.request("GET", `/api/tasks/${id}/session`);
  }
  getTaskSessionWs(id: string) {
    return this.request<{ url: string }>("GET", `/api/tasks/${id}/session/ws`);
  }
  getSession(id: string) {
    return this.request("GET", `/api/sessions/${id}`);
  }
  getSessionWs(id: string) {
    return this.request<{ url: string }>("GET", `/api/sessions/${id}/ws`);
  }
  claimTask(id: string) {
    return this.request("POST", `/api/tasks/${id}/claim`);
  }
  completeTask(id: string) {
    return this.request("POST", `/api/tasks/${id}/complete`);
  }
  updateTask(id: string, body: Record<string, unknown>) {
    return this.request("PATCH", `/api/tasks/${id}`, body);
  }
  releaseTask(id: string) {
    return this.request("POST", `/api/tasks/${id}/release`);
  }
  cancelTask(id: string, body: Record<string, unknown> = {}) {
    return this.request("POST", `/api/tasks/${id}/cancel`, body);
  }
  reviewTask(id: string, body: Record<string, unknown> = {}) {
    return this.request("POST", `/api/tasks/${id}/review`, body);
  }
  assignTask(id: string, agentId: string) {
    return this.request("POST", `/api/tasks/${id}/assign`, { agent_id: agentId });
  }
  addNote(taskId: string, detail: string) {
    return this.request("POST", `/api/tasks/${taskId}/notes`, { detail });
  }
  deleteTask(id: string) {
    return this.request("DELETE", `/api/tasks/${id}`);
  }
  rejectTask(id: string, body: Record<string, unknown> = {}) {
    return this.request("POST", `/api/tasks/${id}/reject`, body);
  }
  getTaskNotes(taskId: string, since?: string) {
    const qs = since ? `?since=${encodeURIComponent(since)}` : "";
    return this.request("GET", `/api/tasks/${taskId}/notes${qs}`);
  }
  getAgent(agentId: string) {
    return this.request("GET", `/api/agents/${agentId}`);
  }
  updateAgent(agentId: string, body: Record<string, unknown>) {
    return this.request("PATCH", `/api/agents/${agentId}`, body);
  }
  deleteAgent(agentId: string) {
    return this.request("DELETE", `/api/agents/${agentId}`);
  }

  getSubagent(subagentId: string) {
    return this.request("GET", `/api/subagents/${subagentId}`);
  }
  listSubagents() {
    return this.request("GET", "/api/subagents");
  }
  updateSubagent(subagentId: string, body: Record<string, unknown>) {
    return this.request("PATCH", `/api/subagents/${subagentId}`, body);
  }
  deleteSubagent(subagentId: string) {
    return this.request("DELETE", `/api/subagents/${subagentId}`);
  }

  // Machines
  registerMachine(info: { name: string; os: string; version: string; runtimes: MachineRuntime[]; device_id: string }) {
    return this.request<{ id: string; name: string }>("POST", "/api/machines", info);
  }
  getMachine(machineId: string) {
    return this.request<{
      id: string;
      name: string;
      status?: string;
      last_heartbeat_at?: string | null;
      runtimes?: MachineRuntime[];
      usage_info?: UsageInfo | null;
    }>("GET", `/api/machines/${machineId}`);
  }
  heartbeat(machineId: string, info: { version?: string; runtimes?: MachineRuntime[]; usage_info?: UsageInfo | null }) {
    return this.request("POST", `/api/machines/${machineId}/heartbeat`, info);
  }

  // Agent Sessions
  createSession(agentId: string, sessionId: string, sessionPublicKey: string, machineId: string) {
    return this.request<{ delegation_proof: string }>("POST", `/api/agents/${agentId}/sessions`, {
      session_id: sessionId,
      session_public_key: sessionPublicKey,
      machine_id: machineId,
    });
  }
  closeSession(agentId: string, sessionId: string) {
    return this.request("DELETE", `/api/agents/${agentId}/sessions/${sessionId}`);
  }
  reopenSession(agentId: string, sessionId: string) {
    return this.request("POST", `/api/agents/${agentId}/sessions/${sessionId}/reopen`);
  }
  listAgents(params?: Record<string, string>) {
    const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
    return this.request("GET", `/api/agents${qs}`);
  }
  listSessions(agentId: string) {
    return this.request<any[]>("GET", `/api/agents/${agentId}/sessions`);
  }
  createAgent(input: {
    name?: string;
    username: string;
    bio?: string;
    soul?: string;
    role?: string;
    kind?: "worker" | "leader";
    handoff_to?: string[];
    runtime: import("@agent-kanban/shared").AnyAgentRuntime;
    model?: string;
    skills?: string[];
    subagents?: string[];
  }) {
    return this.request("POST", "/api/agents", input);
  }
  createSubagent(input: {
    name?: string;
    username: string;
    bio?: string;
    soul?: string;
    role?: string;
    models?: Partial<Record<import("@agent-kanban/shared").AgentRuntime, string>>;
    skills?: string[];
  }) {
    return this.request("POST", "/api/subagents", input);
  }

  // Models
  listModels(runtime: string) {
    return this.request<{ id: string; name?: string; description?: string }[]>("GET", `/api/models?runtime=${encodeURIComponent(runtime)}`);
  }

  // Boards
  createBoard(input: { name: string; type: import("@agent-kanban/shared").BoardType; description?: string }) {
    return this.request("POST", "/api/boards", input);
  }
  listBoards() {
    return this.request<any[]>("GET", "/api/boards");
  }
  getBoardByName(name: string) {
    return this.request("GET", `/api/boards?name=${encodeURIComponent(name)}`);
  }
  getBoard(boardId: string) {
    return this.request<BoardWithTasks>("GET", `/api/boards/${boardId}`);
  }
  updateBoard(boardId: string, body: Record<string, unknown>) {
    return this.request("PATCH", `/api/boards/${boardId}`, body);
  }
  createBoardLabel(boardId: string, body: { name: string; color: string; description?: string }) {
    return this.request("POST", `/api/boards/${boardId}/labels`, body);
  }
  updateBoardLabel(boardId: string, name: string, body: { name?: string; color?: string; description?: string }) {
    return this.request("PATCH", `/api/boards/${boardId}/labels/${encodeURIComponent(name)}`, body);
  }
  deleteBoardLabel(boardId: string, name: string) {
    return this.request("DELETE", `/api/boards/${boardId}/labels/${encodeURIComponent(name)}`);
  }
  deleteBoard(boardId: string) {
    return this.request("DELETE", `/api/boards/${boardId}`);
  }
  createBoardMaintainer(boardId: string, input: Record<string, unknown>) {
    return this.request("POST", `/api/boards/${boardId}/maintainers`, input);
  }
  listBoardMaintainers(boardId: string) {
    return this.request<any[]>("GET", `/api/boards/${boardId}/maintainers`);
  }
  listBoardMaintainerRuns(boardId: string, maintainerId: string, options: { limit?: number } = {}) {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return this.request<any>("GET", `/api/boards/${boardId}/maintainers/${maintainerId}/runs${qs}`);
  }
  updateBoardMaintainer(boardId: string, maintainerId: string, input: Record<string, unknown>) {
    return this.request<any>("PATCH", `/api/boards/${boardId}/maintainers/${maintainerId}`, input);
  }
  deleteBoardMaintainer(boardId: string, maintainerId: string) {
    return this.request<any>("DELETE", `/api/boards/${boardId}/maintainers/${maintainerId}`);
  }

  // Repositories
  createRepository(input: { name: string; url: string }) {
    return this.request("POST", "/api/repositories", input);
  }
  listRepositories(filters?: { url?: string; board_id?: string }) {
    const params = new URLSearchParams();
    if (filters?.url) params.set("url", filters.url);
    if (filters?.board_id) params.set("board_id", filters.board_id);
    const qs = params.toString();
    return this.request<any[]>("GET", `/api/repositories${qs ? `?${qs}` : ""}`);
  }
  getRepository(repoId: string) {
    return this.request("GET", `/api/repositories/${repoId}`);
  }
  createRepositoryGithubToken(repoId: string) {
    return this.request<{ repository_id: string; full_name: string; token: string; expires_at: string }>(
      "POST",
      `/api/repositories/${repoId}/github-token`,
    );
  }
  deleteRepository(repoId: string) {
    return this.request("DELETE", `/api/repositories/${repoId}`);
  }

  // Session usage
  updateSessionUsage(
    agentId: string,
    sessionId: string,
    usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; cost_micro_usd: number },
  ) {
    return this.request("PATCH", `/api/agents/${agentId}/sessions/${sessionId}/usage`, usage);
  }

  // Messages
  sendMessage(taskId: string, body: { sender_type: string; sender_id: string; content: string }) {
    return this.request("POST", `/api/tasks/${taskId}/messages`, body);
  }
  getMessages(taskId: string, since?: string) {
    const qs = since ? `?since=${encodeURIComponent(since)}` : "";
    return this.request<any[]>("GET", `/api/tasks/${taskId}/messages${qs}`);
  }
}
