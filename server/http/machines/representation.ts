import type { Runner, RunnerRuntime } from "@realmroot/enbor-sdk";
import type { MachineProjection } from "@server/usecases/machines/projectMachines";

export function machineRepresentation(machine: MachineProjection, requestUrl: string) {
  const { environment, runners } = machine;
  const active = runners.filter((runner) => runner.state === "active");
  return {
    id: environment.metadata.uid,
    name: machineName(runners),
    description: environment.metadata.description,
    status: machineStatus(runners),
    currentLoad: active.reduce((total, runner) => total + runner.currentLoad, 0),
    maxLoad: active.reduce((total, runner) => total + runner.maxConcurrent, 0),
    runnerCount: runners.length,
    runtimes: machineRuntimes(runners),
    lastHeartbeatAt:
      runners
        .map((runner) => runner.lastHeartbeatAt)
        .filter(isString)
        .sort()
        .at(-1) ?? null,
    createdAt: environment.metadata.createdAt,
    updatedAt: environment.metadata.updatedAt,
    links: { self: new URL(`/api/machines/${encodeURIComponent(environment.metadata.uid)}`, requestUrl).toString() },
  };
}

export function machineDetailRepresentation(machine: MachineProjection, requestUrl: string) {
  return {
    ...machineRepresentation(machine, requestUrl),
    runners: machine.runners.map((runner) => ({
      id: runner.id,
      name: runner.name,
      status: runner.state,
      currentLoad: runner.currentLoad,
      maxLoad: runner.maxConcurrent,
      runtimes: runner.runtimes,
      runtimeUsage: runner.runtimeUsage,
      lastHeartbeatAt: runner.lastHeartbeatAt,
    })),
  };
}

function machineStatus(runners: Runner[]): "online" | "offline" | "draining" | "disabled" {
  if (runners.some((runner) => runner.state === "active")) return "online";
  if (runners.some((runner) => runner.state === "draining")) return "draining";
  if (runners.some((runner) => runner.state === "disabled")) return "disabled";
  return "offline";
}

function machineRuntimes(runners: Runner[]): RunnerRuntime[] {
  const runtimes = new Map<string, RunnerRuntime>();
  for (const runner of runners) {
    for (const runtime of runner.runtimes) {
      const current = runtimes.get(runtime.runtime);
      runtimes.set(runtime.runtime, current ? { ...runtime, models: [...new Set([...current.models, ...runtime.models])] } : runtime);
    }
  }
  return [...runtimes.values()];
}

function machineName(runners: Runner[]): string {
  if (runners.length === 0) return "Waiting for computer";
  const names = runners.map((runner) => runner.name).sort();
  if (runners.length === 1) return names[0];
  const remaining = runners.length - 1;
  return `${names[0]} + ${remaining} runner${remaining === 1 ? "" : "s"}`;
}

function isString(value: string | null): value is string {
  return value !== null;
}
