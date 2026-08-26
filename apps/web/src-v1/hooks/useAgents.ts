import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useAgents() {
  const {
    data: agents = [],
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents.list(),
    refetchInterval: 15_000,
  });

  return { agents, loading, refresh: refetch };
}

export function useSubagents() {
  const {
    data: subagents = [],
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ["subagents"],
    queryFn: () => api.subagents.list(),
    refetchInterval: 15_000,
  });

  return { subagents, loading, refresh: refetch };
}

export function useAgent(id: string | undefined) {
  const {
    data: agent = null,
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ["agent", id],
    queryFn: () => api.agents.get(id!),
    enabled: !!id,
    refetchInterval: 15_000,
  });

  return { agent, loading, refresh: refetch };
}

export function useAgentSessions(agentId: string | undefined) {
  const { data: sessions = [] } = useQuery({
    queryKey: ["agent-sessions", agentId],
    queryFn: () => api.agents.sessions(agentId!),
    enabled: !!agentId,
    refetchInterval: 15_000,
  });

  return { sessions };
}

export function useAgentTasks(agentId: string | undefined) {
  const { data: tasks = [] } = useQuery({
    queryKey: ["tasks", { assigned_to: agentId }],
    queryFn: () => api.tasks.list({ assigned_to: agentId! }),
    enabled: !!agentId,
    refetchInterval: 15_000,
  });

  return { tasks };
}

export function useCreateAgent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.agents.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}

export function useUpdateAgent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.agents.update(id, body),
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["agent", id] });
    },
  });
}

export function useDeleteAgent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.agents.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}

export function useCreateSubagent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.subagents.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subagents"] });
    },
  });
}

export function useUpdateSubagent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.subagents.update>[1] }) => api.subagents.update(id, body),
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: ["subagents"] });
      queryClient.invalidateQueries({ queryKey: ["subagent", id] });
    },
  });
}

export function useDeleteSubagent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.subagents.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subagents"] });
    },
  });
}
