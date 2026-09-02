import type { ProjectedAgent } from "@shared";

export function agentRepresentation(agent: ProjectedAgent, requestUrl: string) {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    username: agent.username,
    runtime: agent.runtime,
    model: agent.model,
    skills: agent.skills,
    subject: agent.subject,
    schedulable: agent.schedulable,
    createdAt: agent.created_at,
    updatedAt: agent.updated_at,
    links: { self: new URL(`/api/agents/${encodeURIComponent(agent.id)}`, requestUrl).toString() },
  };
}
