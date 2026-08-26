import { useQuery, useQueryClient } from "@tanstack/react-query";

export type RealmrootSession = {
  session: { id: string; expiresAt: string; csrfToken: string };
  user: { id: string; tenantId: string; name: string; email: string; image?: string | null; role: string };
};

let csrfToken: string | null = null;

export async function getSession(): Promise<RealmrootSession | null> {
  const response = await fetch("/api/auth/session", { credentials: "include" });
  if (response.status === 401) {
    csrfToken = null;
    return null;
  }
  if (!response.ok) throw new Error(`Session request failed with HTTP ${response.status}`);
  const session = (await response.json()) as RealmrootSession;
  csrfToken = session.session.csrfToken;
  return session;
}

export function useSession() {
  const query = useQuery({ queryKey: ["realmroot-session"], queryFn: getSession, staleTime: 30_000, retry: false });
  return { data: query.data ?? null, isPending: query.isPending, refetch: query.refetch };
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

export async function signOut(): Promise<boolean> {
  const response = await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "include",
    headers: csrfToken ? { "x-csrf-token": csrfToken } : {},
  });
  if (!response.ok && response.status !== 401) throw new Error(`Sign out failed with HTTP ${response.status}`);
  csrfToken = null;
  if (response.ok && response.status !== 204) {
    const body = (await response.json()) as { logoutUrl?: string };
    if (body.logoutUrl) {
      window.location.assign(body.logoutUrl);
      return true;
    }
  }
  return false;
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return async () => {
    await signOut();
    queryClient.setQueryData(["realmroot-session"], null);
  };
}
