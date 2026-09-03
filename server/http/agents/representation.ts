import type { Agent } from "@realmroot/enbor-sdk";

export function agentRepresentation(agent: Agent, requestUrl: string) {
  return {
    id: agent.metadata.uid,
    name: agent.metadata.name,
    description: agent.metadata.description,
    username: agent.spec.identity?.username ?? null,
    runtime: agent.spec.identity?.runtime ?? null,
    model: agent.spec.model,
    skills: agent.spec.skills,
    subject: agent.spec.identity?.subject ?? null,
    schedulable: agent.status.schedulable,
    createdAt: agent.metadata.createdAt,
    updatedAt: agent.metadata.updatedAt,
    links: { self: new URL(`/api/agents/${encodeURIComponent(agent.metadata.uid)}`, requestUrl).toString() },
  };
}
