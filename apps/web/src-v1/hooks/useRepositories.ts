import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useRepositories() {
  const {
    data: repos = [],
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => api.repositories.list(),
  });

  return { repos, loading, refresh: refetch };
}

export function useCreateRepository() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { name: string; url: string }) => api.repositories.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repositories"] });
    },
  });
}

export function useDeleteRepository() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.repositories.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repositories"] });
    },
  });
}
