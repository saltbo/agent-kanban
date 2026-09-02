import type { ProjectedMachine } from "@shared";

export function machineRepresentation(machine: ProjectedMachine, requestUrl: string) {
  return {
    id: machine.id,
    name: machine.name,
    description: machine.description,
    status: machine.state,
    currentLoad: machine.current_load,
    maxLoad: machine.max_concurrent,
    runnerCount: machine.runners,
    runtimes: machine.runtimes,
    lastHeartbeatAt: machine.last_heartbeat_at,
    createdAt: machine.created_at,
    updatedAt: machine.updated_at,
    links: { self: new URL(`/api/machines/${encodeURIComponent(machine.id)}`, requestUrl).toString() },
  };
}
