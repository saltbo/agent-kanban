import type { Env } from "@server/env";
import type { AgentProjectionPort } from "@server/usecases/agents/projectAgents";
import { AmaProjectionError } from "@server/usecases/ama/failures";
import type { MachineProjectionPort } from "@server/usecases/machines/projectMachines";
import type { MachineRuntime, MachineRuntimeUsage, ProjectedAgent, ProjectedMachine, ProjectedMachineRunner } from "@shared";
import { parseScheduledAt } from "@shared";

type AmaMetadata = {
  uid: string;
  projectId: string | null;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

type AmaAgent = {
  metadata: AmaMetadata;
  spec: {
    systemPrompt: string;
    provider: string | null;
    model: string | null;
    skills: string[];
    allowedTools: string[];
    identity: { subject: string; username: string; runtime: string } | null;
  };
  status: { phase: "active" | "archived"; schedulable: boolean };
};

type AmaEnvironment = {
  metadata: AmaMetadata;
  spec: { type: string };
  status: { phase: "active" | "archived" };
};

type AmaRunner = {
  id: string;
  name: string;
  environmentId: string | null;
  state: "active" | "draining" | "disabled" | "offline";
  currentLoad: number;
  maxConcurrent: number;
  runtimeUsage: Array<{
    runtime: string;
    windows: Array<{ label: string; utilization: number; resetsAt: string }>;
  }>;
  runtimes: MachineRuntime[];
  lastHeartbeatAt: string | null;
};

type AmaIdentity = { metadata: AmaMetadata };

export { AmaProjectionError } from "@server/usecases/ama/failures";

export class AmaResourceProjectionAdapter implements AgentProjectionPort, MachineProjectionPort {
  constructor(
    private readonly env: Env,
    private readonly token: string,
    private readonly traceparent?: string,
  ) {}

  async listAgentsPage(input: {
    projectId: string;
    limit: number;
    cursor: string | null;
    filters: { runtime?: string; schedulable?: boolean; search?: string };
  }): Promise<{ items: ProjectedAgent[]; nextCursor: string | null }> {
    const url = new URL("/api/v1/agents", required(this.env.AMA_ORIGIN, "AMA_ORIGIN"));
    url.searchParams.set("limit", String(input.limit));
    if (input.cursor) url.searchParams.set("cursor", input.cursor);
    if (input.filters.runtime) url.searchParams.set("runtime", input.filters.runtime);
    if (input.filters.schedulable !== undefined) url.searchParams.set("schedulable", String(input.filters.schedulable));
    if (input.filters.search) url.searchParams.set("search", input.filters.search);
    const page = decodeList(await this.request<unknown>(input.projectId, `${url.pathname}${url.search}`), decodeAgent, input.limit);
    return {
      items: page.data.map(projectAgent),
      nextCursor: page.pagination.hasMore ? page.pagination.nextCursor : null,
    };
  }

  async getAgent(projectId: string, agentId: string): Promise<ProjectedAgent | null> {
    const value = await this.request<unknown>(projectId, `/api/v1/agents/${encodeURIComponent(agentId)}`, { allowNotFound: true });
    return value ? projectAgent(decodeAgent(value)) : null;
  }

  async createIdentity(projectId: string, input: { name: string; username: string; runtime: string; idempotencyKey: string }): Promise<string> {
    const identity = decodeIdentity(
      await this.request<unknown>(projectId, "/api/v1/identities", {
        method: "POST",
        idempotencyKey: input.idempotencyKey,
        body: JSON.stringify({ metadata: { name: input.name }, spec: { username: input.username, runtime: input.runtime } }),
      }),
    );
    return identity.metadata.uid;
  }

  async archiveIdentity(projectId: string, identityId: string): Promise<void> {
    await this.request<unknown>(projectId, `/api/v1/identities/${encodeURIComponent(identityId)}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
    });
  }

  isPermanentFailure(error: unknown): boolean {
    return error instanceof AmaProjectionError && error.kind !== "unavailable" && error.kind !== "invalid-response";
  }

  async createAgent(
    projectId: string,
    input: {
      name: string;
      description: string | null;
      systemPrompt: string;
      provider: string | null;
      model: string | null;
      skills: string[];
      identityRef: string;
      idempotencyKey: string;
    },
  ): Promise<ProjectedAgent> {
    const agent = decodeAgent(
      await this.request<unknown>(projectId, "/api/v1/agents", {
        method: "POST",
        idempotencyKey: input.idempotencyKey,
        body: JSON.stringify({
          metadata: { name: input.name, description: input.description },
          spec: {
            systemPrompt: input.systemPrompt,
            provider: input.provider,
            model: input.model,
            skills: input.skills,
            identityRef: input.identityRef,
          },
        }),
      }),
    );
    if (!agent.spec.identity) throw new AmaProjectionError("invalid-response", "AMA created an Agent without a bound identity");
    return projectAgent(agent);
  }

  async listMachinesPage(input: {
    projectId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: ProjectedMachine[]; nextCursor: string | null }> {
    const url = new URL("/api/v1/environments", required(this.env.AMA_ORIGIN, "AMA_ORIGIN"));
    url.searchParams.set("limit", String(input.limit));
    if (input.cursor) url.searchParams.set("cursor", input.cursor);
    const page = decodeList(await this.request<unknown>(input.projectId, `${url.pathname}${url.search}`), decodeEnvironment, input.limit);
    const environments = page.data.filter((environment) => environment.spec.type === "self_hosted" && environment.status.phase === "active");
    const relevant = new Set(environments.map((environment) => environment.metadata.uid));
    const runnersByEnvironment = new Map<string, AmaRunner[]>();
    for (const runner of await this.listAllRunners(input.projectId)) {
      if (!runner.environmentId || !relevant.has(runner.environmentId)) continue;
      const current = runnersByEnvironment.get(runner.environmentId) ?? [];
      current.push(runner);
      runnersByEnvironment.set(runner.environmentId, current);
    }
    return {
      items: environments.map((environment) => projectMachine(environment, runnersByEnvironment.get(environment.metadata.uid) ?? [])),
      nextCursor: page.pagination.hasMore ? page.pagination.nextCursor : null,
    };
  }

  async getMachine(projectId: string, machineId: string): Promise<ProjectedMachine | null> {
    const value = await this.request<unknown>(projectId, `/api/v1/environments/${encodeURIComponent(machineId)}`, {
      allowNotFound: true,
    });
    if (!value) return null;
    const environment = decodeEnvironment(value);
    if (environment.spec.type !== "self_hosted") return null;
    const runners = await this.listAllRunners(projectId, machineId);
    return projectMachine(environment, runners);
  }

  async createMachine(projectId: string, name: string, idempotencyKey: string): Promise<ProjectedMachine> {
    const environment = decodeEnvironment(
      await this.request<unknown>(projectId, "/api/v1/environments", {
        method: "POST",
        idempotencyKey,
        body: JSON.stringify({ metadata: { name }, spec: { scope: "project", type: "self_hosted" } }),
      }),
    );
    return projectMachine(environment, []);
  }

  async archiveMachine(projectId: string, machineId: string): Promise<boolean> {
    const value = await this.request<unknown>(projectId, `/api/v1/environments/${encodeURIComponent(machineId)}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
      allowNotFound: true,
    });
    if (value === null) return false;
    const environment = decodeEnvironment(value);
    if (environment.status.phase !== "archived") throw invalidResponse("AMA did not confirm Machine archival");
    return true;
  }

  private async listAllRunners(projectId: string, environmentId?: string): Promise<AmaRunner[]> {
    const rows: AmaRunner[] = [];
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const url = new URL("/api/v1/runners", required(this.env.AMA_ORIGIN, "AMA_ORIGIN"));
      if (environmentId) url.searchParams.set("environmentId", environmentId);
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("cursor", cursor);
      const page = decodeList(await this.request<unknown>(projectId, `${url.pathname}${url.search}`), decodeRunner, 100);
      rows.push(...page.data);
      if (rows.length > 10_000) throw invalidResponse("Enbor Runner result exceeded the safety bound");
      const next = page.pagination.hasMore ? page.pagination.nextCursor : null;
      if (!next) return rows;
      if (next === cursor) throw invalidResponse("Enbor Runner pagination did not advance");
      cursor = next;
    }
    throw invalidResponse("Enbor Runner pagination exceeded the safety bound");
  }

  private async request<T>(
    projectId: string,
    path: string,
    options: { method?: string; body?: string; allowNotFound?: boolean; idempotencyKey?: string } = {},
  ): Promise<T | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(new URL(path, required(this.env.AMA_ORIGIN, "AMA_ORIGIN")), {
        method: options.method ?? "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          "x-ama-project-id": projectId,
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
          ...(this.traceparent ? { traceparent: this.traceparent } : {}),
        },
        body: options.body,
        signal: controller.signal,
      });
      if (response.status === 404 && options.allowNotFound) return null;
      if (!response.ok) {
        const kind = amaFailureKind(response.status);
        throw new AmaProjectionError(kind, kind === "unavailable" ? "AMA is unavailable" : "AMA request was rejected");
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw invalidResponse("AMA returned invalid JSON");
      }
      return value as T;
    } catch (error) {
      if (error instanceof AmaProjectionError) throw error;
      throw new AmaProjectionError("unavailable", "AMA is unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }
}

function amaFailureKind(status: number): "not-found" | "denied" | "rejected" | "invalid-response" | "unavailable" {
  if (status === 404) return "not-found";
  if (status === 401 || status === 403) return "denied";
  if (status === 408 || status === 429 || (status >= 500 && status !== 502)) return "unavailable";
  return status === 502 ? "invalid-response" : "rejected";
}

function projectAgent(agent: AmaAgent): ProjectedAgent {
  return {
    id: agent.metadata.uid,
    subject: agent.spec.identity?.subject ?? null,
    name: agent.metadata.name,
    description: agent.metadata.description,
    username: agent.spec.identity?.username ?? null,
    runtime: agent.spec.identity?.runtime ?? null,
    phase: agent.status.phase,
    schedulable: agent.status.schedulable,
    provider: agent.spec.provider,
    model: agent.spec.model,
    system_prompt: agent.spec.systemPrompt,
    skills: agent.spec.skills,
    allowed_tools: agent.spec.allowedTools,
    created_at: agent.metadata.createdAt,
    updated_at: agent.metadata.updatedAt,
  };
}

function projectMachine(environment: AmaEnvironment, runners: AmaRunner[]): ProjectedMachine {
  const active = runners.filter((runner) => runner.state === "active");
  const state =
    environment.status.phase === "archived"
      ? "disabled"
      : active.length > 0
        ? "online"
        : runners.some((runner) => runner.state === "draining")
          ? "draining"
          : runners.some((runner) => runner.state === "disabled")
            ? "disabled"
            : "offline";
  const runtimeByName = new Map<string, MachineRuntime>();
  for (const runner of runners) {
    for (const runtime of runner.runtimes) {
      const current = runtimeByName.get(runtime.runtime);
      runtimeByName.set(runtime.runtime, current ? { ...runtime, models: [...new Set([...current.models, ...runtime.models])] } : runtime);
    }
  }
  return {
    id: environment.metadata.uid,
    name: projectedMachineName(runners),
    description: environment.metadata.description,
    state,
    current_load: active.reduce((total, runner) => total + runner.currentLoad, 0),
    max_concurrent: active.reduce((total, runner) => total + runner.maxConcurrent, 0),
    runner_count: runners.length,
    runners: runners.map(projectMachineRunner),
    runtimes: [...runtimeByName.values()],
    last_heartbeat_at:
      runners
        .map((runner) => runner.lastHeartbeatAt)
        .filter(isString)
        .sort()
        .at(-1) ?? null,
    created_at: environment.metadata.createdAt,
    updated_at: environment.metadata.updatedAt,
  };
}

function projectMachineRunner(runner: AmaRunner): ProjectedMachineRunner {
  return {
    id: runner.id,
    name: runner.name,
    state: runner.state,
    current_load: runner.currentLoad,
    max_concurrent: runner.maxConcurrent,
    runtimes: runner.runtimes,
    runtime_usage: runner.runtimeUsage.map(projectRuntimeUsage),
    last_heartbeat_at: runner.lastHeartbeatAt,
  };
}

function projectRuntimeUsage(usage: AmaRunner["runtimeUsage"][number]): MachineRuntimeUsage {
  return {
    runtime: usage.runtime,
    windows: usage.windows.map((window) => ({
      label: window.label,
      utilization: window.utilization,
      resets_at: window.resetsAt,
    })),
  };
}

function projectedMachineName(runners: AmaRunner[]): string {
  if (runners.length === 0) return "Waiting for computer";
  const names = runners.map((runner) => runner.name).sort();
  if (runners.length === 1) return names[0];
  const additionalRunners = runners.length - 1;
  return `${names[0]} + ${additionalRunners} runner${additionalRunners === 1 ? "" : "s"}`;
}

function isString(value: string | null): value is string {
  return value !== null;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new AmaProjectionError("unavailable", `${name} is required`);
  return value;
}

function decodeList<T>(
  value: unknown,
  decodeItem: (value: unknown) => T,
  requestedLimit: number,
): { data: T[]; pagination: { nextCursor: string | null; hasMore: boolean } } {
  if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.pagination)) throw invalidResponse();
  if (value.data.length > requestedLimit) throw invalidResponse("AMA returned more resources than requested");
  const nextCursor = value.pagination.nextCursor;
  const hasMore = value.pagination.hasMore;
  if ((nextCursor !== null && typeof nextCursor !== "string") || typeof hasMore !== "boolean" || (hasMore && !nextCursor)) {
    throw invalidResponse();
  }
  return { data: value.data.map(decodeItem), pagination: { nextCursor, hasMore } };
}

function decodeAgent(value: unknown): AmaAgent {
  if (!isRecord(value) || !isRecord(value.metadata) || !isRecord(value.spec) || !isRecord(value.status)) throw invalidResponse();
  const identity = value.spec.identity;
  if (identity !== null && (!isRecord(identity) || !strings(identity, ["subject", "username", "runtime"]))) throw invalidResponse();
  if (
    !strings(value.spec, ["systemPrompt"]) ||
    !nullableStrings(value.spec, ["provider", "model"]) ||
    !stringArray(value.spec.skills) ||
    !stringArray(value.spec.allowedTools) ||
    (value.status.phase !== "active" && value.status.phase !== "archived") ||
    typeof value.status.schedulable !== "boolean"
  )
    throw invalidResponse();
  return {
    metadata: decodeMetadata(value.metadata),
    spec: {
      systemPrompt: value.spec.systemPrompt as string,
      provider: value.spec.provider as string | null,
      model: value.spec.model as string | null,
      skills: value.spec.skills,
      allowedTools: value.spec.allowedTools,
      identity: identity as AmaAgent["spec"]["identity"],
    },
    status: { phase: value.status.phase, schedulable: value.status.schedulable },
  };
}

function decodeIdentity(value: unknown): AmaIdentity {
  if (!isRecord(value) || !isRecord(value.metadata)) throw invalidResponse();
  return { metadata: decodeMetadata(value.metadata) };
}

function decodeEnvironment(value: unknown): AmaEnvironment {
  if (!isRecord(value) || !isRecord(value.metadata) || !isRecord(value.spec) || !isRecord(value.status) || typeof value.spec.type !== "string") {
    throw invalidResponse();
  }
  if (value.status.phase !== "active" && value.status.phase !== "archived") throw invalidResponse();
  return { metadata: decodeMetadata(value.metadata), spec: { type: value.spec.type }, status: { phase: value.status.phase } };
}

function decodeRunner(value: unknown): AmaRunner {
  if (
    !isRecord(value) ||
    !strings(value, ["id", "name"]) ||
    (value.name as string).trim().length === 0 ||
    (value.environmentId !== null && typeof value.environmentId !== "string") ||
    !["active", "draining", "disabled", "offline"].includes(String(value.state)) ||
    !Number.isInteger(value.currentLoad) ||
    !Number.isInteger(value.maxConcurrent) ||
    !Array.isArray(value.runtimeUsage) ||
    !Array.isArray(value.runtimes) ||
    (value.lastHeartbeatAt !== null && typeof value.lastHeartbeatAt !== "string")
  )
    throw invalidResponse();
  return {
    id: value.id as string,
    name: (value.name as string).trim(),
    environmentId: value.environmentId as string | null,
    state: value.state as AmaRunner["state"],
    currentLoad: value.currentLoad as number,
    maxConcurrent: value.maxConcurrent as number,
    runtimeUsage: value.runtimeUsage.map(decodeRuntimeUsage),
    runtimes: value.runtimes.map(decodeRuntime),
    lastHeartbeatAt: value.lastHeartbeatAt as string | null,
  };
}

function decodeRuntimeUsage(value: unknown): AmaRunner["runtimeUsage"][number] {
  if (!isRecord(value) || !strings(value, ["runtime"]) || !Array.isArray(value.windows)) throw invalidResponse();
  return { runtime: value.runtime as string, windows: value.windows.map(decodeRuntimeUsageWindow) };
}

function decodeRuntimeUsageWindow(value: unknown): AmaRunner["runtimeUsage"][number]["windows"][number] {
  if (
    !isRecord(value) ||
    !strings(value, ["label", "resetsAt"]) ||
    parseScheduledAt(value.resetsAt as string) === null ||
    typeof value.utilization !== "number" ||
    !Number.isFinite(value.utilization)
  ) {
    throw invalidResponse();
  }
  return { label: value.label as string, utilization: value.utilization, resetsAt: value.resetsAt as string };
}

function decodeRuntime(value: unknown): MachineRuntime {
  if (!isRecord(value) || !strings(value, ["runtime", "state"]) || !stringArray(value.models)) throw invalidResponse();
  if (value.version !== undefined && typeof value.version !== "string") throw invalidResponse();
  if (value.detail !== undefined && typeof value.detail !== "string") throw invalidResponse();
  return value as unknown as MachineRuntime;
}

function decodeMetadata(value: Record<string, unknown>): AmaMetadata {
  if (!strings(value, ["uid", "name", "createdAt", "updatedAt"]) || !nullableStrings(value, ["projectId", "description", "archivedAt"]))
    throw invalidResponse();
  return value as unknown as AmaMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => typeof value[field] === "string");
}

function nullableStrings(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => value[field] === null || typeof value[field] === "string");
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function invalidResponse(message = "AMA returned an invalid resource representation"): AmaProjectionError {
  return new AmaProjectionError("invalid-response", message);
}
