import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type User, UserManager, WebStorageStateStore } from "oidc-client-ts";

export type RealmrootSession = {
  user: { id: string; tenantId: string; name: string; email: string; image?: string | null; role: string };
};

type BrowserConfig = {
  issuer: string;
  clientId: string;
  ak: { resource: string; scopes: string[] };
  ama: { resource: string; scopes: string[] };
};

type CachedResourceToken = { accessToken: string; expiresAt: number };

const AMA_TOKEN_KEY = "ak:ama-resource-token";
let configPromise: Promise<BrowserConfig> | undefined;
let managerPromise: Promise<UserManager> | undefined;
let refreshTail: Promise<void> = Promise.resolve();

async function browserConfig(): Promise<BrowserConfig> {
  configPromise ??= fetch("/api/configz")
    .then(async (response) => {
      if (!response.ok) throw new Error(`Browser configuration failed with HTTP ${response.status}`);
      return response.json() as Promise<BrowserConfig>;
    })
    .then((config) => {
      if (!config.issuer || !config.clientId || !config.ak?.resource || !config.ama?.resource) {
        throw new Error("Realmroot browser configuration is incomplete.");
      }
      return config;
    });
  return configPromise;
}

async function manager(): Promise<UserManager> {
  managerPromise ??= browserConfig().then(
    (config) =>
      new UserManager({
        authority: config.issuer,
        client_id: config.clientId,
        redirect_uri: `${window.location.origin}/auth/callback`,
        post_logout_redirect_uri: `${window.location.origin}/`,
        response_type: "code",
        scope: ["openid", "profile", "email", "offline_access", ...config.ak.scopes, ...config.ama.scopes].join(" "),
        resource: [config.ak.resource, config.ama.resource],
        extraTokenParams: { resource: config.ak.resource },
        automaticSilentRenew: false,
        userStore: new WebStorageStateStore({ store: window.sessionStorage }),
      }),
  );
  return managerPromise;
}

function tenantId(user: User): string {
  const profile = user.profile as Record<string, unknown>;
  const organization = profile["urn:realmroot:params:oauth:org"] ?? profile.org_id ?? profile.organization_id;
  return typeof organization === "string" && organization ? organization : `user:${user.profile.sub}`;
}

function e2eToken(resource: "ak" | "ama"): string | null {
  return window.localStorage.getItem(resource === "ak" ? "ak:e2e-access-token" : "ak:e2e-ama-access-token");
}

async function currentUser(): Promise<User | null> {
  const user = await (await manager()).getUser();
  return user?.profile.sub ? user : null;
}

async function serializeRefresh<T>(operation: () => Promise<T>): Promise<T> {
  const previous = refreshTail;
  let release!: () => void;
  refreshTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

function readAmaToken(): CachedResourceToken | null {
  const raw = window.sessionStorage.getItem(AMA_TOKEN_KEY);
  if (!raw) return null;
  try {
    const token = JSON.parse(raw) as CachedResourceToken;
    return token.accessToken && token.expiresAt > Date.now() ? token : null;
  } catch {
    window.sessionStorage.removeItem(AMA_TOKEN_KEY);
    return null;
  }
}

async function refreshResourceToken(resource: "ak" | "ama"): Promise<string | null> {
  return serializeRefresh(async () => {
    const config = await browserConfig();
    const oidc = await manager();
    const user = await oidc.getUser();
    if (!user?.refresh_token) return null;
    if (resource === "ak" && !user.expired) return user.access_token;
    if (resource === "ama") {
      const cached = readAmaToken();
      if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.accessToken;
    }
    const discovery = await fetch(`${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    const metadata = (await discovery.json()) as { token_endpoint?: string };
    if (!discovery.ok || !metadata.token_endpoint) throw new Error("Realmroot discovery did not return a token endpoint.");
    const target = config[resource];
    const response = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: user.refresh_token,
        client_id: config.clientId,
        resource: target.resource,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => null)) as {
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number;
      error?: string;
    } | null;
    if (!response.ok || !body?.access_token || body.token_type?.toLowerCase() !== "bearer") {
      if (body?.error === "invalid_grant") {
        await oidc.removeUser();
        window.sessionStorage.removeItem(AMA_TOKEN_KEY);
      }
      return null;
    }
    if (body.refresh_token) user.refresh_token = body.refresh_token;
    const expiresAt = Date.now() + Math.max(1, body.expires_in ?? 300) * 1000;
    if (resource === "ak") {
      user.access_token = body.access_token;
      user.expires_at = Math.floor(expiresAt / 1000);
    } else {
      window.sessionStorage.setItem(AMA_TOKEN_KEY, JSON.stringify({ accessToken: body.access_token, expiresAt } satisfies CachedResourceToken));
    }
    await oidc.storeUser(user);
    return body.access_token;
  });
}

export async function getResourceAccessToken(resource: "ak" | "ama"): Promise<string | null> {
  const fixture = e2eToken(resource);
  if (fixture) return fixture;
  if (resource === "ama") {
    const cached = readAmaToken();
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.accessToken;
  }
  const user = await currentUser();
  if (!user) return null;
  if (resource === "ak" && !user.expired) return user.access_token;
  return refreshResourceToken(resource);
}

export async function getAuthHeaders(resource: "ak" | "ama" = "ak"): Promise<Record<string, string>> {
  const token = await getResourceAccessToken(resource);
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function getSession(): Promise<RealmrootSession | null> {
  if (e2eToken("ak")) {
    return {
      user: { id: "e2e-user", tenantId: "e2e-tenant", name: "E2E User", email: "e2e@example.com", role: "member" },
    };
  }
  if (!(await getResourceAccessToken("ak"))) return null;
  const user = await currentUser();
  if (!user) return null;
  const profile = user.profile;
  return {
    user: {
      id: profile.sub,
      tenantId: tenantId(user),
      name: profile.name ?? profile.email ?? profile.sub,
      email: profile.email ?? "",
      image: profile.picture ?? null,
      role: Array.isArray(profile.roles) && profile.roles.includes("admin") ? "admin" : "member",
    },
  };
}

export function useSession() {
  const query = useQuery({ queryKey: ["realmroot-session"], queryFn: getSession, staleTime: 30_000, retry: false });
  return { data: query.data ?? null, isPending: query.isPending, refetch: query.refetch };
}

export async function signIn(returnTo: string): Promise<void> {
  await (await manager()).signinRedirect({ state: { returnTo } });
}

export async function completeSignIn(): Promise<string> {
  const user = await (await manager()).signinRedirectCallback();
  window.sessionStorage.removeItem(AMA_TOKEN_KEY);
  const returnTo = (user.state as { returnTo?: string } | undefined)?.returnTo;
  return returnTo?.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
}

export async function signOut(): Promise<boolean> {
  window.localStorage.removeItem("ak:e2e-access-token");
  window.localStorage.removeItem("ak:e2e-ama-access-token");
  window.sessionStorage.removeItem(AMA_TOKEN_KEY);
  await (await manager()).signoutRedirect();
  return true;
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return async () => {
    await signOut();
    queryClient.setQueryData(["realmroot-session"], null);
  };
}
