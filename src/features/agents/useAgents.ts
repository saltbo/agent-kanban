import type { Task } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface AgentProjection {
  id: string;
  name: string;
  description: string | null;
  username: string | null;
  runtime: string | null;
  model: string | null;
  skills: string[];
  subject: string | null;
  schedulable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentFilters {
  search?: string;
  runtime?: string;
  schedulable?: boolean;
}

export function useAgents(filters: AgentFilters = {}) {
  return useQuery({
    queryKey: ["agents", filters],
    queryFn: async () => (await api.agents.list(filters)).items as AgentProjection[],
  });
}

export function useAgent(agentId: string | undefined) {
  return useQuery({
    queryKey: ["agents", agentId],
    queryFn: () => api.agents.get(agentId!) as Promise<AgentProjection>,
    enabled: Boolean(agentId),
  });
}

export function useAgentTasks(subject: string | null | undefined) {
  return useQuery({
    queryKey: ["agent-tasks", subject],
    queryFn: () => api.tasks.list({ assigned_to: subject! }) as Promise<Task[]>,
    enabled: Boolean(subject),
  });
}
