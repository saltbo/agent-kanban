import { AGENT_RUNTIMES, type AgentRuntime, MACHINE_STALE_TIMEOUT_MS } from "@agent-kanban/shared";
import { getAmaProjectId } from "./amaOwnerIntegrationRepo";
import { type AmaRunner, isAmaTaskDispatchConfigured, listAmaRunners } from "./amaRuntime";
import type { D1 } from "./db";
import { legacyRuntimeAvailableOnMachines } from "./legacyRuntime";
import { createLogger } from "./logger";
import { listMachinesForRuntimeRouting } from "./machineRepo";
import type { TaskRuntimeSource } from "./runtimeBinding";
import type { Env } from "./types";

const logger = createLogger("runtime-router");

export interface RuntimeSourceAvailability {
  ama: boolean;
  legacy: boolean;
}

export function amaRuntimeName(runtime: string): string {
  return runtime === "claude" ? "claude-code" : runtime;
}

export function amaRunnerHeartbeatFresh(runner: AmaRunner, now = Date.now()): boolean {
  if (!runner.lastHeartbeatAt) return false;
  const heartbeatAt = Date.parse(runner.lastHeartbeatAt);
  return Number.isFinite(heartbeatAt) && heartbeatAt >= now - MACHINE_STALE_TIMEOUT_MS;
}

export function amaRunnerOwnsRuntime(runner: AmaRunner, runtime: string, model: string | null = null): boolean {
  if (runner.status !== "active" || !amaRunnerHeartbeatFresh(runner)) return false;
  return runner.runtimes.some(
    (entry) =>
      entry.runtime === runtime &&
      (entry.state === "ready" || entry.state === "limited") &&
      (!model || runtime === "ama" || entry.models.includes(model)),
  );
}

export function amaRunnerCanScheduleRuntime(runner: AmaRunner, runtime: string, model: string | null = null): boolean {
  if (!amaRunnerOwnsRuntime(runner, runtime, model) || runtimeQuotaExhausted(runner, runtime)) return false;
  return runner.runtimes.some(
    (entry) => entry.runtime === runtime && entry.state === "ready" && (!model || runtime === "ama" || entry.models.includes(model)),
  );
}

function runtimeQuotaExhausted(runner: AmaRunner, runtime: string): boolean {
  const usage = (runner.runtimeUsage ?? []).find((entry) => entry.runtime === runtime);
  if (!usage) return false;
  const now = Date.now();
  return usage.windows.some((window) => window.utilization >= 100 && Date.parse(window.resetsAt) > now);
}

export async function resolveRuntimeSourceAvailability(
  db: D1,
  env: Env,
  ownerId: string,
  runtime: AgentRuntime,
  model: string | null = null,
): Promise<RuntimeSourceAvailability> {
  const machines = await listMachinesForRuntimeRouting(db, ownerId);
  const legacy = legacyRuntimeAvailableOnMachines(machines, runtime);
  if (!isAmaTaskDispatchConfigured(env)) {
    return { ama: false, legacy };
  }

  const environmentIds = [
    ...new Set(
      machines
        .filter((machine) => machine.runtimes.some((entry) => entry.name === runtime))
        .map((machine) => machine.ama_environment_id)
        .filter((environmentId): environmentId is string => Boolean(environmentId)),
    ),
  ];
  const projectId = environmentIds.length > 0 ? await getAmaProjectId(db, ownerId) : null;
  let runnerPages: Awaited<ReturnType<typeof listAmaRunners>>[] = [];
  if (projectId) {
    try {
      runnerPages = await Promise.all(environmentIds.map((environmentId) => listAmaRunners(env, ownerId, projectId, environmentId)));
    } catch (error) {
      logger.warn(`AMA runner availability unavailable for tenant ${ownerId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const amaRuntime = amaRuntimeName(runtime);
  const cloudAvailable = machines.some(
    (machine) => machine.hosting === "cloud" && machine.runtimes.some((entry) => entry.name === runtime && entry.status === "ready"),
  );
  const ama = cloudAvailable || runnerPages.some((page) => page.data.some((runner) => amaRunnerOwnsRuntime(runner, amaRuntime, model)));
  return { ama, legacy };
}

export async function listAvailableRuntimeSources(db: D1, env: Env, ownerId: string): Promise<Map<AgentRuntime, RuntimeSourceAvailability>> {
  const machines = await listMachinesForRuntimeRouting(db, ownerId);
  const projectId = isAmaTaskDispatchConfigured(env) ? await getAmaProjectId(db, ownerId) : null;
  const environmentIds = [...new Set(machines.map((machine) => machine.ama_environment_id).filter((id): id is string => Boolean(id)))];
  let runnerPages: Awaited<ReturnType<typeof listAmaRunners>>[] = [];
  if (projectId) {
    try {
      runnerPages = await Promise.all(environmentIds.map((environmentId) => listAmaRunners(env, ownerId, projectId, environmentId)));
    } catch (error) {
      logger.warn(`AMA runner availability unavailable for tenant ${ownerId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const entries = await Promise.all(
    AGENT_RUNTIMES.map(async (runtime) => {
      const amaRuntime = amaRuntimeName(runtime);
      const cloudAvailable = machines.some(
        (machine) => machine.hosting === "cloud" && machine.runtimes.some((entry) => entry.name === runtime && entry.status === "ready"),
      );
      const ama = cloudAvailable || runnerPages.some((page) => page.data.some((runner) => amaRunnerCanScheduleRuntime(runner, amaRuntime)));
      const legacy = legacyRuntimeAvailableOnMachines(machines, runtime);
      return [runtime, { ama, legacy }] as const;
    }),
  );
  return new Map(entries);
}

export function selectRuntimeSource(availability: RuntimeSourceAvailability): TaskRuntimeSource | null {
  if (availability.ama) return "ama";
  if (availability.legacy) return "legacy";
  return null;
}
