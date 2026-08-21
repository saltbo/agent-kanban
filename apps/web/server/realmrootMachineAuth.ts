import { decodeJwt, importJWK, type JWK, SignJWT } from "jose";
import type { Env } from "./types";

type CachedToken = { accessToken: string; expiresAt: number };
const tokenCache = new Map<string, CachedToken>();
const inFlight = new Map<string, Promise<CachedToken>>();
const dpopKeyCache = new Map<string, Promise<{ privateKey: CryptoKey; publicJwk: JWK }>>();
const TOKEN_SKEW_MS = 30_000;

export type DpopAuthorization = { accessToken: string; dpopProof: string };

export function createAmaMachineAuthorizer(env: Env): (url: string, method: string) => Promise<DpopAuthorization> {
  return async (url, method) => {
    const key = await machineDpopKey(env);
    const accessToken = await machineAccessToken(env, key.privateKey, key.publicJwk);
    return {
      accessToken,
      dpopProof: await dpopProof(url, method, key.privateKey, key.publicJwk, accessToken),
    };
  };
}

export function invalidateAmaMachineToken(env: Env): void {
  tokenCache.delete(cacheKey(env));
}

async function machineAccessToken(env: Env, privateKey: CryptoKey, publicJwk: JWK): Promise<string> {
  const key = cacheKey(env);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + TOKEN_SKEW_MS) return cached.accessToken;
  const pending = inFlight.get(key);
  if (pending) return (await pending).accessToken;

  const request = requestMachineToken(env, privateKey, publicJwk).finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return (await request).accessToken;
}

async function requestMachineToken(env: Env, privateKey: CryptoKey, publicJwk: JWK): Promise<CachedToken> {
  const issuer = required(env.REALMROOT_ISSUER, "REALMROOT_ISSUER").replace(/\/$/, "");
  const discoveryResponse = await fetch(`${issuer}/.well-known/openid-configuration`, { headers: { accept: "application/json" } });
  if (!discoveryResponse.ok) throw new Error(`Realmroot discovery failed with HTTP ${discoveryResponse.status}`);
  const discovery = (await discoveryResponse.json()) as { issuer?: string; token_endpoint?: string };
  if (discovery.issuer !== issuer || !discovery.token_endpoint) throw new Error("Invalid Realmroot discovery metadata");

  const clientId = required(env.AMA_MACHINE_CLIENT_ID, "AMA_MACHINE_CLIENT_ID");
  const clientSecret = required(env.AMA_MACHINE_CLIENT_SECRET, "AMA_MACHINE_CLIENT_SECRET");
  const resource = required(env.AMA_RESOURCE ?? env.AMA_ORIGIN, "AMA_RESOURCE").replace(/\/$/, "");
  const proof = await dpopProof(discovery.token_endpoint, "POST", privateKey, publicJwk);
  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
      dpop: proof,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      resource,
      scope: required(env.AMA_MACHINE_SCOPES?.trim(), "AMA_MACHINE_SCOPES"),
    }),
  });
  const body = (await response.json().catch(() => null)) as { access_token?: string; expires_in?: number; token_type?: string } | null;
  if (!response.ok || !body?.access_token) throw new Error(`Realmroot machine token request failed with HTTP ${response.status}`);
  if (body.token_type?.toLowerCase() !== "dpop") throw new Error("Realmroot machine token is not DPoP-bound");
  const exp = decodeJwt(body.access_token).exp;
  const expiresAt = typeof exp === "number" ? exp * 1000 : Date.now() + (body.expires_in ?? 300) * 1000;
  const token = { accessToken: body.access_token, expiresAt };
  tokenCache.set(cacheKey(env), token);
  return token;
}

async function machineDpopKey(env: Env): Promise<{ privateKey: CryptoKey; publicJwk: JWK }> {
  const encoded = required(env.AMA_DPOP_PRIVATE_JWK, "AMA_DPOP_PRIVATE_JWK");
  const cached = dpopKeyCache.get(encoded);
  if (cached) return cached;
  const imported = (async () => {
    const privateJwk = JSON.parse(encoded) as JWK;
    if (privateJwk.kty !== "EC" || privateJwk.crv !== "P-256" || !privateJwk.d) {
      throw new Error("AMA_DPOP_PRIVATE_JWK must be an ES256 private JWK");
    }
    const privateKey = (await importJWK(privateJwk, "ES256")) as CryptoKey;
    const { d: _privateScalar, ...publicJwk } = privateJwk;
    return { privateKey, publicJwk };
  })().catch((error) => {
    dpopKeyCache.delete(encoded);
    throw error;
  });
  dpopKeyCache.set(encoded, imported);
  return imported;
}

async function dpopProof(url: string, method: string, privateKey: CryptoKey, publicJwk: JWK, accessToken?: string): Promise<string> {
  const target = new URL(url);
  target.hash = "";
  target.search = "";
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({
    htu: target.toString(),
    htm: method.toUpperCase(),
    ...(accessToken ? { ath: await sha256Base64Url(accessToken) } : {}),
  })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk })
    .setJti(crypto.randomUUID())
    .setIssuedAt(now);
  return jwt.sign(privateKey);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function cacheKey(env: Env): string {
  return `${env.REALMROOT_ISSUER}|${env.AMA_MACHINE_CLIENT_ID}|${env.AMA_RESOURCE ?? env.AMA_ORIGIN}`;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
