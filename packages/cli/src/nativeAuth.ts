import { Entry } from "@napi-rs/keyring";
import { decodeJwt, exportJWK, generateKeyPair, importJWK, type JWK, SignJWT } from "jose";
import { getCredentials, saveEnvironment } from "./config.js";

const KEYCHAIN_SERVICE = "agent-kanban.realmroot";
const DEFAULT_ISSUER = "https://id.realmroot.dev/api/auth";
const AK_NATIVE_SCOPES =
  "openid profile email offline_access ak:read ak:write task:claim task:assign task:release task:review task:complete task:reject task:cancel task:log task:message agent:usage";

type StoredAuthority = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenType: "Bearer" | "DPoP";
  privateJwk: JWK;
  publicJwk: JWK;
};

type Discovery = {
  issuer: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
};

const refreshInFlight = new Map<string, Promise<StoredAuthority>>();

export async function loginWithRealmroot(input: { apiUrl: string; clientId: string; issuer?: string }): Promise<void> {
  const apiUrl = input.apiUrl.replace(/\/$/, "");
  const issuer = (input.issuer ?? DEFAULT_ISSUER).replace(/\/$/, "");
  const resourceMetadataResponse = await fetch(`${apiUrl}/.well-known/oauth-protected-resource/api`);
  if (!resourceMetadataResponse.ok) throw new Error(`AK resource discovery failed with HTTP ${resourceMetadataResponse.status}`);
  const resourceMetadata = (await resourceMetadataResponse.json()) as { resource?: string; authorization_servers?: string[] };
  if (!resourceMetadata.resource) throw new Error("AK resource metadata has no resource identifier");
  if (!resourceMetadata.authorization_servers?.includes(issuer)) throw new Error("AK does not advertise the selected Realmroot issuer");

  const discovery = await discover(issuer);
  if (!discovery.device_authorization_endpoint) throw new Error("Realmroot does not advertise device authorization");
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);
  const deviceProof = await dpopProof(discovery.device_authorization_endpoint, "POST", privateKey, publicJwk);
  const deviceResponse = await fetch(discovery.device_authorization_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", dpop: deviceProof },
    body: new URLSearchParams({ client_id: input.clientId, scope: AK_NATIVE_SCOPES, resource: resourceMetadata.resource }),
  });
  const device = (await deviceResponse.json().catch(() => null)) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  } | null;
  if (!deviceResponse.ok || !device?.device_code || !device.verification_uri || !device.user_code) {
    throw new Error(`Realmroot device authorization failed with HTTP ${deviceResponse.status}`);
  }

  console.log(`Open ${device.verification_uri_complete ?? device.verification_uri}`);
  console.log(`Enter code: ${device.user_code}`);
  const deadline = Date.now() + (device.expires_in ?? 600) * 1000;
  let interval = Math.max(device.interval ?? 5, 1) * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const proof = await dpopProof(discovery.token_endpoint, "POST", privateKey, publicJwk);
    const response = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: input.clientId,
        resource: resourceMetadata.resource,
      }),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.ok) {
      const authority = tokenAuthority(body, privateJwk, publicJwk);
      storeAuthority(new URL(apiUrl).host, authority);
      saveEnvironment({ apiUrl, issuer, resource: resourceMetadata.resource, clientId: input.clientId });
      return;
    }
    if (body?.error === "authorization_pending") continue;
    if (body?.error === "slow_down") {
      interval += 5000;
      continue;
    }
    throw new Error(`Realmroot device authorization failed: ${String(body?.error ?? response.status)}`);
  }
  throw new Error("Realmroot device authorization expired");
}

export async function realmrootRequestHeaders(method: string, url: string): Promise<Record<string, string>> {
  const environment = getCredentials();
  const host = new URL(environment.apiUrl).host;
  let authority = readAuthority(host);
  if (authority.expiresAt <= Date.now() + 30_000) authority = await refreshAuthorityOnce(environment, authority, host);
  if (authority.tokenType === "Bearer") {
    return { authorization: `Bearer ${authority.accessToken}` };
  }
  const privateKey = (await importJWK(authority.privateJwk, "ES256")) as CryptoKey;
  return {
    authorization: `DPoP ${authority.accessToken}`,
    dpop: await dpopProof(url, method, privateKey, authority.publicJwk, authority.accessToken),
  };
}

export function clearRealmrootAuthority(apiUrl?: string): void {
  const host = apiUrl ? new URL(apiUrl).host : new URL(getCredentials().apiUrl).host;
  new Entry(KEYCHAIN_SERVICE, host).deletePassword();
}

function readAuthority(host: string): StoredAuthority {
  const value = new Entry(KEYCHAIN_SERVICE, host).getPassword();
  if (!value) throw new Error(`No Realmroot authority for ${host}. Run: ak auth login --api-url <url>`);
  return JSON.parse(value) as StoredAuthority;
}

function storeAuthority(host: string, authority: StoredAuthority): void {
  new Entry(KEYCHAIN_SERVICE, host).setPassword(JSON.stringify(authority));
}

async function refreshAuthority(environment: ReturnType<typeof getCredentials>, authority: StoredAuthority, host: string): Promise<StoredAuthority> {
  if (!authority.refreshToken) throw new Error("Realmroot authority expired. Run ak auth login again.");
  const discovery = await discover(environment.issuer);
  const privateKey = (await importJWK(authority.privateJwk, "ES256")) as CryptoKey;
  const proof = await dpopProof(discovery.token_endpoint, "POST", privateKey, authority.publicJwk);
  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: authority.refreshToken,
      client_id: environment.clientId,
      resource: environment.resource,
    }),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) throw new Error("Realmroot refresh failed; run ak auth login again.");
  const refreshed = tokenAuthority(body, authority.privateJwk, authority.publicJwk, authority.refreshToken);
  storeAuthority(host, refreshed);
  return refreshed;
}

async function refreshAuthorityOnce(
  environment: ReturnType<typeof getCredentials>,
  authority: StoredAuthority,
  host: string,
): Promise<StoredAuthority> {
  const existing = refreshInFlight.get(host);
  if (existing) return existing;
  const refresh = refreshAuthority(environment, authority, host);
  refreshInFlight.set(host, refresh);
  try {
    return await refresh;
  } finally {
    if (refreshInFlight.get(host) === refresh) refreshInFlight.delete(host);
  }
}

function tokenAuthority(body: Record<string, unknown> | null, privateJwk: JWK, publicJwk: JWK, previousRefresh?: string): StoredAuthority {
  const tokenType = String(body?.token_type).toLowerCase();
  if (typeof body?.access_token !== "string" || (tokenType !== "bearer" && tokenType !== "dpop"))
    throw new Error("Realmroot returned an invalid token response");
  const exp = decodeJwt(body.access_token).exp;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : previousRefresh,
    expiresAt: typeof exp === "number" ? exp * 1000 : Date.now() + Number(body.expires_in ?? 300) * 1000,
    tokenType: tokenType === "dpop" ? "DPoP" : "Bearer",
    privateJwk,
    publicJwk,
  };
}

async function discover(issuer: string): Promise<Discovery> {
  const response = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`Realmroot discovery failed with HTTP ${response.status}`);
  const discovery = (await response.json()) as Discovery;
  if (discovery.issuer !== issuer.replace(/\/$/, "") || !discovery.token_endpoint) throw new Error("Invalid Realmroot discovery metadata");
  return discovery;
}

async function dpopProof(url: string, method: string, privateKey: CryptoKey, publicJwk: JWK, accessToken?: string): Promise<string> {
  const target = new URL(url);
  target.search = "";
  target.hash = "";
  const payload: Record<string, unknown> = { htu: target.toString(), htm: method.toUpperCase() };
  if (accessToken) payload.ath = await sha256Base64Url(accessToken);
  return new SignJWT(payload)
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk })
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .sign(privateKey);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Buffer.from(digest).toString("base64url");
}
