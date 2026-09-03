import type { MachineSetup, ProjectedMachine } from "@shared";

export interface MachineProjectionPort {
  listMachinesPage(input: {
    projectId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: ProjectedMachine[]; nextCursor: string | null }>;
  getMachine(projectId: string, machineId: string): Promise<ProjectedMachine | null>;
  createMachine(projectId: string, name: string, idempotencyKey: string): Promise<ProjectedMachine>;
  archiveMachine(projectId: string, machineId: string): Promise<boolean>;
}

export function listProjectedMachinesPage(
  port: MachineProjectionPort,
  projectId: string,
  page: { limit: number; cursor: string | null },
): Promise<{ items: ProjectedMachine[]; nextCursor: string | null }> {
  return port.listMachinesPage({ projectId, ...page });
}

export function getProjectedMachine(port: MachineProjectionPort, projectId: string, machineId: string): Promise<ProjectedMachine | null> {
  return port.getMachine(projectId, machineId);
}

export async function createProjectedMachine(
  port: MachineProjectionPort,
  projectId: string,
  idempotencyKey: string,
  runnerCommand: (projectId: string, environmentId: string) => string,
): Promise<{ machine: ProjectedMachine; setup: MachineSetup }> {
  const [name, environmentKey] = await Promise.all([generatedEnvironmentName(idempotencyKey), derivedKey(idempotencyKey, "environment")]);
  const machine = await port.createMachine(projectId, name, environmentKey);
  return {
    machine,
    setup: { command: runnerCommand(projectId, machine.id), project_id: projectId, environment_id: machine.id },
  };
}

async function generatedEnvironmentName(idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${idempotencyKey}:environment-name`));
  const suffix = Array.from(new Uint8Array(digest).slice(0, 4), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `computer-${suffix}`;
}

async function derivedKey(parent: string, stage: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${parent}:${stage}`));
  return `ak-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function archiveProjectedMachine(port: MachineProjectionPort, projectId: string, machineId: string): Promise<boolean> {
  return port.archiveMachine(projectId, machineId);
}
