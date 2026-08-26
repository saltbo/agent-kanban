import { type AgentRuntime, MACHINE_STALE_TIMEOUT_MS } from "@agent-kanban/shared";
import type { D1 } from "./db";
import { listMachines, type MachineRecord, type MachineWithAgentsRecord } from "./machineRepo";

export async function legacyRuntimeAvailable(db: D1, ownerId: string, runtime: AgentRuntime): Promise<boolean> {
  const machines = await listMachines(db, ownerId);
  return legacyRuntimeAvailableOnMachines(machines, runtime);
}

export function legacyRuntimeAvailableOnMachines(machines: Array<MachineRecord | MachineWithAgentsRecord>, runtime: AgentRuntime): boolean {
  return machines.some(
    (machine) =>
      machine.hosting === "local" &&
      legacyMachineHeartbeatFresh(machine) &&
      machine.runtimes.some((entry) => entry.name === runtime && entry.status === "ready"),
  );
}

export function legacyMachineHeartbeatFresh(machine: MachineRecord | MachineWithAgentsRecord, now = Date.now()): boolean {
  if (machine.status !== "online" || !machine.last_heartbeat_at) return false;
  const heartbeatAt = Date.parse(machine.last_heartbeat_at);
  return Number.isFinite(heartbeatAt) && heartbeatAt >= now - MACHINE_STALE_TIMEOUT_MS;
}
