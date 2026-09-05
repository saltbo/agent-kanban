import { useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { discoverAgentProfile, fetchAgentProfile } from "./agentProfileApi";
import { LocalAgentProfiles } from "./LocalAgentProfiles";

const PROFILE_STALE_TIME_MS = 60_000;
const DISCOVERY_STALE_TIME_MS = 15 * 60_000;

export function useAgentProfile(subject: string | null | undefined) {
  const localProfile = useContext(LocalAgentProfiles)[subject ?? ""];
  const discovery = useQuery({
    queryKey: ["agent-profile-discovery"],
    queryFn: ({ signal }) => discoverAgentProfile(signal),
    enabled: Boolean(subject && !localProfile),
    staleTime: DISCOVERY_STALE_TIME_MS,
    retry: 1,
  });

  return useQuery({
    queryKey: ["agent-profile", subject],
    queryFn: ({ signal }) => fetchAgentProfile(discovery.data!, subject!, signal),
    enabled: Boolean(subject && !localProfile && discovery.data?.template),
    initialData: localProfile,
    staleTime: PROFILE_STALE_TIME_MS,
    retry: 1,
  });
}
