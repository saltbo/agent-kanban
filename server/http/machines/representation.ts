import type { ProjectedMachine } from "@shared";

export function machineRepresentation(machine: ProjectedMachine, requestUrl: string) {
  return {
    id: machine.id,
    name: machine.name,
    description: machine.description,
    status: machine.state,
    currentLoad: machine.current_load,
    maxLoad: machine.max_concurrent,
    runnerCount: machine.runner_count,
    runtimes: machine.runtimes,
    lastHeartbeatAt: machine.last_heartbeat_at,
    createdAt: machine.created_at,
    updatedAt: machine.updated_at,
    links: { self: new URL(`/api/machines/${encodeURIComponent(machine.id)}`, requestUrl).toString() },
  };
}

export function machineDetailRepresentation(machine: ProjectedMachine, requestUrl: string) {
  return {
    ...machineRepresentation(machine, requestUrl),
    runners: machine.runners.map((runner) => ({
      id: runner.id,
      name: runner.name,
      status: runner.state,
      currentLoad: runner.current_load,
      maxLoad: runner.max_concurrent,
      runtimes: runner.runtimes,
      runtimeUsage: runner.runtime_usage.map((usage) => ({
        runtime: usage.runtime,
        windows: usage.windows.map((window) => ({
          label: window.label,
          utilization: window.utilization,
          resetsAt: window.resets_at,
        })),
      })),
      lastHeartbeatAt: runner.last_heartbeat_at,
    })),
  };
}
