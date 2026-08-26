import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, selectedAmaConnection } from "../lib/api";

export function useAgents() {
  const {
    data: agents = [],
    isLoading: loading,
    refetch,
    error,
  } = useQuery({
    queryKey: ["agents", selectedAmaConnection()],
    queryFn: () => api.agents.list(),
    refetchInterval: 15_000,
    retry: false,
  });

  return { agents, loading, error, refresh: refetch };
}

export function useAgent(id: string | undefined) {
  const {
    data: agent = null,
    isLoading: loading,
    refetch,
    error,
  } = useQuery({
    queryKey: ["agent", selectedAmaConnection(), id],
    queryFn: () => api.agents.get(id!),
    enabled: !!id,
    refetchInterval: 15_000,
    retry: false,
  });

  return { agent, loading, error, refresh: refetch };
}

export function useAgentSessions(agentId: string | undefined) {
  const { data: sessions = [] } = useQuery({
    queryKey: ["agent-sessions", selectedAmaConnection(), agentId],
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
      queryClient.invalidateQueries({ queryKey: ["agent", selectedAmaConnection(), id] });
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
