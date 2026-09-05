import { EnborApiError, type EnborClient, type Environment, type Runner } from "@realmroot/enbor-sdk";
import type { MachineSetup } from "@shared";

export interface MachineProjection {
  environment: Environment;
  runners: Runner[];
}

export async function listMachinesPage(
  client: EnborClient,
  page: { limit: number; cursor: string | null },
): Promise<{ items: MachineProjection[]; nextCursor: string | null }> {
  const environments = await client.environments.list({ limit: page.limit, cursor: page.cursor ?? undefined });
  const selfHostedEnvironments = environments.data.filter((environment) => environment.spec.type === "self_hosted");
  const runnersByEnvironment = await Promise.all(selfHostedEnvironments.map((environment) => listAllRunners(client, environment.metadata.uid)));
  return {
    items: selfHostedEnvironments.map((environment, index) => ({ environment, runners: runnersByEnvironment[index] ?? [] })),
    nextCursor: environments.pagination.nextCursor,
  };
}

export async function getMachine(client: EnborClient, machineId: string): Promise<MachineProjection | null> {
  const environment = await client.environments.get(machineId);
  if (environment.spec.type !== "self_hosted") return null;
  return { environment, runners: await listAllRunners(client, machineId) };
}

export async function createMachine(
  client: EnborClient,
  projectId: string,
  idempotencyKey: string,
  runnerCommand: (projectId: string, environmentId: string) => string,
): Promise<{ machine: MachineProjection; setup: MachineSetup }> {
  const [name, environmentKey] = await Promise.all([generatedEnvironmentName(idempotencyKey), derivedKey(idempotencyKey, "environment")]);
  const environment = await client.environments.create({ metadata: { name }, spec: { scope: "project", type: "self_hosted" } }, environmentKey);
  return {
    machine: { environment, runners: [] },
    setup: { command: runnerCommand(projectId, environment.metadata.uid), project_id: projectId, environment_id: environment.metadata.uid },
  };
}

async function listAllRunners(client: EnborClient, environmentId?: string): Promise<Runner[]> {
  const runners: Runner[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await client.runners.list({ limit: 100, cursor, environmentId });
    runners.push(...page.data);
    if (runners.length > 10_000) throw invalidPagination("Enbor Runner result exceeded the safety bound");
    const nextCursor = page.pagination.nextCursor ?? undefined;
    if (!nextCursor) return runners;
    if (nextCursor === cursor) throw invalidPagination("Enbor Runner pagination did not advance");
    if (pageNumber === 99) throw invalidPagination("Enbor Runner pagination exceeded the safety bound");
    cursor = nextCursor;
  }
  throw invalidPagination("Enbor Runner pagination exceeded the safety bound");
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

function invalidPagination(message: string): EnborApiError {
  return new EnborApiError(502, message, null);
}
