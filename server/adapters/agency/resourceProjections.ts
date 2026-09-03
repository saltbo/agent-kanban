import { type Agent, type Environment, type Runner, type RuntimeName, type RuntimeUsage } from "@realmroot/enbor-sdk";
import { createAgencyClient, isAgencyNotFound, toAmaProjectionError } from "@server/adapters/agency/client";
import type { Env } from "@server/env";
import type { AgentProjectionPort } from "@server/usecases/agents/projectAgents";
import { AmaProjectionError } from "@server/usecases/ama/failures";
import type { MachineProjectionPort } from "@server/usecases/machines/projectMachines";
import type { MachineRuntime, MachineRuntimeUsage, ProjectedAgent, ProjectedMachine, ProjectedMachineRunner } from "@shared";

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
    return this.call(async () => {
      const page = await this.client(input.projectId).agents.list({
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.filters.runtime ? { runtime: input.filters.runtime as RuntimeName } : {}),
        ...(input.filters.schedulable !== undefined ? { schedulable: String(input.filters.schedulable) as "true" | "false" } : {}),
        ...(input.filters.search ? { search: input.filters.search } : {}),
      });
      assertPage(page.data, page.pagination, input.limit);
      page.data.forEach(assertAgent);
      return {
        items: page.data.map(projectAgent),
        nextCursor: page.pagination.hasMore ? page.pagination.nextCursor : null,
      };
    });
  }

  async getAgent(projectId: string, agentId: string): Promise<ProjectedAgent | null> {
    return this.callOrNotFound(async () => projectAgent(await this.client(projectId).agents.get(agentId)));
  }

  async createIdentity(projectId: string, input: { name: string; username: string; runtime: string; idempotencyKey: string }): Promise<string> {
    return this.call(async () => {
      const identity = await this.client(projectId).identities.create(
        { metadata: { name: input.name }, spec: { username: input.username, runtime: input.runtime as RuntimeName } },
        input.idempotencyKey,
      );
      assertMetadata(identity.metadata);
      return identity.metadata.uid;
    });
  }

  async archiveIdentity(projectId: string, identityId: string): Promise<void> {
    await this.call(() => this.client(projectId).identities.delete(identityId));
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
    return this.call(async () => {
      const agent = await this.client(projectId).agents.create(
        {
          metadata: { name: input.name, description: input.description },
          spec: {
            systemPrompt: input.systemPrompt,
            provider: input.provider,
            model: input.model,
            skills: input.skills,
            identityRef: input.identityRef,
          },
        },
        input.idempotencyKey,
      );
      if (!agent.spec.identity) throw invalidResponse("AMA created an Agent without a bound identity");
      return projectAgent(agent);
    });
  }

  async listMachinesPage(input: {
    projectId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: ProjectedMachine[]; nextCursor: string | null }> {
    return this.call(async () => {
      const page = await this.client(input.projectId).environments.list({
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      assertPage(page.data, page.pagination, input.limit);
      page.data.forEach(assertEnvironment);
      const environments = page.data.filter((environment) => environment.spec.type === "self_hosted");
      const relevant = new Set(environments.map((environment) => environment.metadata.uid));
      const runnersByEnvironment = new Map<string, Runner[]>();
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
    });
  }

  async getMachine(projectId: string, machineId: string): Promise<ProjectedMachine | null> {
    const environment = await this.callOrNotFound(() => this.client(projectId).environments.get(machineId));
    if (!environment) return null;
    return this.call(async () => {
      assertEnvironment(environment);
      if (environment.spec.type !== "self_hosted") return null;
      return projectMachine(environment, await this.listAllRunners(projectId, machineId));
    });
  }

  async createMachine(projectId: string, name: string, idempotencyKey: string): Promise<ProjectedMachine> {
    return this.call(async () => {
      const environment = await this.client(projectId).environments.create(
        { metadata: { name }, spec: { scope: "project", type: "self_hosted" } },
        idempotencyKey,
      );
      return projectMachine(environment, []);
    });
  }

  async archiveMachine(projectId: string, machineId: string): Promise<boolean> {
    const deleted = await this.callOrNotFound(async () => {
      await this.client(projectId).environments.delete(machineId);
      return true;
    });
    return deleted ?? false;
  }

  private client(projectId: string) {
    return createAgencyClient(required(this.env.AMA_ORIGIN, "AMA_ORIGIN"), {
      token: this.token,
      projectId,
      traceparent: this.traceparent,
    });
  }

  private async listAllRunners(projectId: string, environmentId?: string): Promise<Runner[]> {
    const rows: Runner[] = [];
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = await this.client(projectId).runners.list({
        limit: 100,
        ...(cursor ? { cursor } : {}),
        ...(environmentId ? { environmentId } : {}),
      });
      assertPage(page.data, page.pagination, 100);
      page.data.forEach(assertRunner);
      rows.push(...page.data);
      if (rows.length > 10_000) throw invalidResponse("Enbor Runner result exceeded the safety bound");
      const next = page.pagination.hasMore ? page.pagination.nextCursor : null;
      if (!next) return rows;
      if (next === cursor) throw invalidResponse("Enbor Runner pagination did not advance");
      cursor = next;
    }
    throw invalidResponse("Enbor Runner pagination exceeded the safety bound");
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw toAmaProjectionError(error);
    }
  }

  private async callOrNotFound<T>(operation: () => Promise<T>): Promise<T | null> {
    try {
      return await operation();
    } catch (error) {
      if (isAgencyNotFound(error)) return null;
      throw toAmaProjectionError(error);
    }
  }
}

function projectAgent(agent: Agent): ProjectedAgent {
  assertAgent(agent);
  return {
    id: agent.metadata.uid,
    subject: agent.spec.identity?.subject ?? null,
    name: agent.metadata.name,
    description: agent.metadata.description,
    username: agent.spec.identity?.username ?? null,
    runtime: agent.spec.identity?.runtime ?? null,
    phase: "active",
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

function projectMachine(environment: Environment, runners: Runner[]): ProjectedMachine {
  assertEnvironment(environment);
  runners.forEach(assertRunner);
  const active = runners.filter((runner) => runner.state === "active");
  const state =
    active.length > 0
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

function projectMachineRunner(runner: Runner): ProjectedMachineRunner {
  return {
    id: runner.id,
    name: runner.name.trim(),
    state: runner.state,
    current_load: runner.currentLoad,
    max_concurrent: runner.maxConcurrent,
    runtimes: runner.runtimes,
    runtime_usage: runner.runtimeUsage.map(projectRuntimeUsage),
    last_heartbeat_at: runner.lastHeartbeatAt,
  };
}

function projectRuntimeUsage(usage: RuntimeUsage): MachineRuntimeUsage {
  return {
    runtime: usage.runtime,
    windows: usage.windows.map((window) => ({
      label: window.label,
      utilization: window.utilization,
      resets_at: window.resetsAt,
    })),
  };
}

function projectedMachineName(runners: Runner[]): string {
  if (runners.length === 0) return "Waiting for computer";
  const names = runners.map((runner) => runner.name.trim()).sort();
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

function assertPage(data: unknown[], pagination: { nextCursor: string | null; hasMore: boolean }, requestedLimit: number): void {
  if (!Array.isArray(data) || data.length > requestedLimit) throw invalidResponse("AMA returned more resources than requested");
  if (
    typeof pagination?.hasMore !== "boolean" ||
    (pagination.nextCursor !== null && typeof pagination.nextCursor !== "string") ||
    (pagination.hasMore && !pagination.nextCursor)
  ) {
    throw invalidResponse();
  }
}

function assertAgent(agent: Agent): void {
  assertMetadata(agent?.metadata);
  const identity = agent.spec?.identity;
  if (
    typeof agent.spec?.systemPrompt !== "string" ||
    !nullableString(agent.spec.provider) ||
    !nullableString(agent.spec.model) ||
    !stringArray(agent.spec.skills) ||
    !stringArray(agent.spec.allowedTools) ||
    agent.status?.phase !== "active" ||
    typeof agent.status?.schedulable !== "boolean" ||
    (identity !== null && (!nonEmptyString(identity?.subject) || !nonEmptyString(identity.username) || !nonEmptyString(identity.runtime)))
  ) {
    throw invalidResponse();
  }
}

function assertEnvironment(environment: Environment): void {
  assertMetadata(environment?.metadata);
  if ((environment.spec?.type !== "self_hosted" && environment.spec?.type !== "cloud") || environment.status?.phase !== "active") {
    throw invalidResponse();
  }
}

function assertRunner(runner: Runner): void {
  if (
    !nonEmptyString(runner?.id) ||
    !nonBlankString(runner.name) ||
    !nullableString(runner.environmentId) ||
    !["active", "draining", "disabled", "offline"].includes(runner.state) ||
    !Number.isInteger(runner.currentLoad) ||
    !Number.isInteger(runner.maxConcurrent) ||
    !Array.isArray(runner.runtimes) ||
    !Array.isArray(runner.runtimeUsage) ||
    !nullableString(runner.lastHeartbeatAt)
  ) {
    throw invalidResponse();
  }
  for (const runtime of runner.runtimes) {
    if (!nonEmptyString(runtime?.runtime) || !stringArray(runtime.models) || !nonEmptyString(runtime.state)) throw invalidResponse();
  }
  for (const usage of runner.runtimeUsage) {
    if (!nonEmptyString(usage?.runtime) || !Array.isArray(usage.windows)) throw invalidResponse();
    for (const window of usage.windows) {
      if (
        !nonEmptyString(window?.label) ||
        !Number.isFinite(window.utilization) ||
        !nonEmptyString(window.resetsAt) ||
        Number.isNaN(Date.parse(window.resetsAt))
      ) {
        throw invalidResponse();
      }
    }
  }
}

function assertMetadata(metadata: Agent["metadata"]): void {
  if (
    !nonEmptyString(metadata?.uid) ||
    !nonEmptyString(metadata.name) ||
    !nullableString(metadata.description) ||
    !nonEmptyString(metadata.createdAt) ||
    !nonEmptyString(metadata.updatedAt)
  ) {
    throw invalidResponse();
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function invalidResponse(message = "AMA returned an invalid resource representation"): AmaProjectionError {
  return new AmaProjectionError("invalid-response", message);
}
