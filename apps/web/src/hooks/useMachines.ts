import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, selectedAmaConnection } from "../lib/api";

export function useMachines() {
  const {
    data: machines = [],
    isLoading: loading,
    refetch,
    error,
  } = useQuery({
    queryKey: ["machines", selectedAmaConnection()],
    queryFn: () => api.machines.list(),
    refetchInterval: 15_000,
    retry: false,
  });

  return { machines, loading, error, refresh: refetch };
}

export function useMachine(id: string | undefined) {
  const {
    data: machine = null,
    isLoading: loading,
    refetch,
    error,
  } = useQuery({
    queryKey: ["machine", selectedAmaConnection(), id],
    queryFn: () => api.machines.get(id!),
    enabled: !!id,
    refetchInterval: 5_000,
    retry: false,
  });

  return { machine, loading, error, refresh: refetch };
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
