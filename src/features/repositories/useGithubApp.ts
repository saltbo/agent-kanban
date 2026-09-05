import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useGithubAppConfig() {
  const { data } = useQuery({
    queryKey: ["github-app-config"],
    queryFn: () => api.githubApp.config(),
    staleTime: 5 * 60 * 1000,
  });
  return data;
}

export function useInstallableRepos(enabled: boolean) {
  return useQuery({
    queryKey: ["github-app-installable"],
    queryFn: () => api.githubApp.installableRepos(),
    enabled,
  });
}

export function useAcceptGithubInstallation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (installationId: number) => api.githubApp.acceptInstallation(installationId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["github-app-config"] }),
        queryClient.invalidateQueries({ queryKey: ["github-app-installable"] }),
        queryClient.invalidateQueries({ queryKey: ["repositories"] }),
      ]);
    },
  });
}
