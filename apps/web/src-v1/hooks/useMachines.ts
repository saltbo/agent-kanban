import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useMachines() {
  const {
    data: machines = [],
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ["machines"],
    queryFn: () => api.machines.list(),
    refetchInterval: 15_000,
  });

  return { machines, loading, refresh: refetch };
}

export function useMachine(id: string | undefined) {
  const {
    data: machine = null,
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ["machine", id],
    queryFn: () => api.machines.get(id!),
    enabled: !!id,
    refetchInterval: 15_000,
  });

  return { machine, loading, refresh: refetch };
}

export function useDeleteMachine() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.machines.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["machines"] });
    },
  });
}
