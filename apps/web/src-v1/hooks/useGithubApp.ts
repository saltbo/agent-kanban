import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

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
