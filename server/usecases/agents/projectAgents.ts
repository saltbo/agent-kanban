import type { ProjectedAgent } from "@shared";

export interface AgentProjectionPort {
  listAgentsPage(input: {
    projectId: string;
    limit: number;
    cursor: string | null;
    filters: { runtime?: string; schedulable?: boolean; search?: string };
  }): Promise<{ items: ProjectedAgent[]; nextCursor: string | null }>;
  getAgent(projectId: string, agentId: string): Promise<ProjectedAgent | null>;
  createIdentity(projectId: string, input: { name: string; username: string; runtime: string; idempotencyKey: string }): Promise<string>;
  archiveIdentity(projectId: string, identityId: string): Promise<void>;
  isPermanentFailure(error: unknown): boolean;
  createAgent(
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
  ): Promise<ProjectedAgent>;
}

export function listProjectedAgentsPage(
  port: AgentProjectionPort,
  projectId: string,
  page: { limit: number; cursor: string | null },
  filters: { runtime?: string; schedulable?: boolean; search?: string },
): Promise<{ items: ProjectedAgent[]; nextCursor: string | null }> {
  return port.listAgentsPage({ projectId, limit: page.limit, cursor: page.cursor, filters });
}

export function getProjectedAgent(port: AgentProjectionPort, projectId: string, agentId: string): Promise<ProjectedAgent | null> {
  return port.getAgent(projectId, agentId);
}

export interface CreateProjectedAgentInput {
  name: string;
  description?: string | null;
  username: string;
  runtime: string;
  systemPrompt: string;
  provider?: string | null;
  model?: string | null;
  skills?: string[];
  idempotencyKey: string;
}

export async function createProjectedAgent(port: AgentProjectionPort, projectId: string, input: CreateProjectedAgentInput): Promise<ProjectedAgent> {
  const identityRef = await port.createIdentity(projectId, {
    name: input.name,
    username: input.username,
    runtime: input.runtime,
    idempotencyKey: await derivedKey(input.idempotencyKey, "identity"),
  });
  try {
    return await port.createAgent(projectId, {
      name: input.name,
      description: input.description ?? null,
      systemPrompt: input.systemPrompt,
      provider: input.provider ?? null,
      model: input.model ?? null,
      skills: input.skills ?? [],
      identityRef,
      idempotencyKey: await derivedKey(input.idempotencyKey, "agent"),
    });
  } catch (error) {
    if (port.isPermanentFailure(error)) await port.archiveIdentity(projectId, identityRef);
    throw error;
  }
}

async function derivedKey(parent: string, stage: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${parent}:${stage}`));
  return `ak-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
