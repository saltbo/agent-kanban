import type { Context } from "hono";
import { calculateJwkThumbprint, createRemoteJWKSet, decodeProtectedHeader, importJWK, type JWTPayload, jwtVerify } from "jose";
import type { Env, Principal } from "./types";

const ORG_CLAIM = "urn:realmroot:params:oauth:org";
const DPOP_MAX_AGE_SECONDS = 300;
const DISCOVERY_CACHE_MS = 10 * 60 * 1000;
const discoveryCache = new Map<string, { metadata: OidcMetadata; expiresAt: number }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export const AK_SCOPES = [
  "boards:read",
  "boards:write",
  "repositories:read",
  "repositories:write",
  "tasks:read",
  "tasks:write",
  "memberships:read",
  "memberships:write",
  "execution:read",
  "execution:write",
  "work:read",
  "work:write",
  "reviews:read",
  "reviews:write",
] as const;

export const AMA_SCOPES = [
  "agents:read",
  "agents:write",
  "environments:read",
  "environments:write",
  "projects:read",
  "runners:read",
  "sessions:read",
  "sessions:write",
] as const;

type OidcMetadata = {
  issuer: string;
  jwks_uri: string;
  id_token_signing_alg_values_supported?: string[];
};

export type RealmrootPrincipal = Principal;

export async function authenticateRealmrootToken(c: Context<{ Bindings: Env }>): Promise<RealmrootPrincipal> {
  const authorization = c.req.header("authorization");
  const proof = c.req.header("dpop");
  const credentialMode = authorization?.startsWith("DPoP ") ? "dpop" : authorization?.startsWith("Bearer ") ? "bearer" : null;
  if (!credentialMode) throw new AuthError("Realmroot access token required");
  if (credentialMode === "dpop" && !proof) throw new AuthError("DPoP proof required");
  if (credentialMode === "bearer" && proof) throw new AuthError("Bearer access token must not include a DPoP proof");

  const accessToken = authorization!.slice(credentialMode === "dpop" ? 5 : 7);
  const metadata = await discover(c.env.REALMROOT_ISSUER);
  const claims = await verifyJwt(accessToken, metadata, resourceUrl(c.env, c.req.url));
  const actor = objectClaim(claims.act);
  if (claims.act !== undefined && !actor) throw new AuthError("Agent actor claim is invalid");
  const actorIssuer = actor && typeof actor.iss === "string" ? actor.iss : undefined;
  const actorSubject = actor && typeof actor.sub === "string" ? actor.sub : undefined;
  if (actor && (!actorIssuer || !actorSubject)) throw new AuthError("Agent actor identity is incomplete");
  if (actorIssuer && actorIssuer.replace(/\/$/, "") !== metadata.issuer.replace(/\/$/, "")) {
    throw new AuthError("Agent actor issuer is not trusted");
  }

  const clientId = typeof claims.client_id === "string" ? claims.client_id : typeof claims.azp === "string" ? claims.azp : undefined;
  const subjectId = typeof claims.sub === "string" ? claims.sub : clientId;
  if (!clientId || !subjectId) throw new AuthError("Access token identity is incomplete");
  const agentClientIds = new Set([required(c.env.REALMROOT_CLI_CLIENT_ID, "REALMROOT_CLI_CLIENT_ID"), "realmroot-cli"]);
  const allowedClientIds = new Set([required(c.env.REALMROOT_BROWSER_CLIENT_ID, "REALMROOT_BROWSER_CLIENT_ID"), ...agentClientIds]);
  if (!allowedClientIds.has(clientId)) throw new AuthError("Access token client is not allowed for AK");
  if (actor && !agentClientIds.has(clientId)) throw new AuthError("Only Realmroot Agent clients may carry an Agent actor");

  const confirmation = claims.cnf as { jkt?: unknown } | undefined;
  if (actor) {
    if (credentialMode !== "dpop" || !confirmation || typeof confirmation.jkt !== "string") {
      throw new AuthError("Realmroot Agent token requires DPoP");
    }
    const verifiedProof = await verifyDpopProof(c, proof!, accessToken, confirmation.jkt);
    await rememberDpopProof(c.env.DB, verifiedProof);
  } else {
    if (credentialMode !== "bearer" || confirmation !== undefined) {
      throw new AuthError("Only Realmroot Agent tokens may use DPoP");
    }
  }

  const profile = typeof claims.sub_profile === "string" ? claims.sub_profile : undefined;
  return {
    source: "token",
    type: actor ? "agent" : profile === "service" ? "service" : profile === "machine" ? "machine" : "human",
    subjectId,
    tenantId: tenantFromClaims(claims),
    clientId,
    scopes: stringList(claims.scope),
    ...(actorIssuer && actorSubject ? { actor: { issuer: metadata.issuer, subject: actorSubject } } : {}),
  };
}

type VerifiedDpopProof = { thumbprint: string; jti: string; expiresAt: string };

async function verifyDpopProof(
  c: Context<{ Bindings: Env }>,
  proof: string,
  accessToken: string,
  expectedThumbprint: string,
): Promise<VerifiedDpopProof> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  let payload: JWTPayload;
  let thumbprint: string;
  try {
    header = decodeProtectedHeader(proof);
    if (header.typ?.toLowerCase() !== "dpop+jwt" || header.alg !== "ES256" || !header.jwk || "d" in header.jwk) {
      throw new AuthError("Invalid DPoP proof header");
    }
    const key = await importJWK(header.jwk, "ES256");
    ({ payload } = await jwtVerify(proof, key, { algorithms: ["ES256"], typ: "dpop+jwt" }));
    thumbprint = await calculateJwkThumbprint(header.jwk, "sha256");
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("Malformed or invalid DPoP proof");
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    typeof payload.iat !== "number" ||
    Math.abs(now - payload.iat) >= DPOP_MAX_AGE_SECONDS ||
    typeof payload.jti !== "string" ||
    payload.jti.length === 0 ||
    payload.jti.length > 160
  )
    throw new AuthError("Stale DPoP proof");
  const target = new URL(c.req.url);
  target.hash = "";
  target.search = "";
  if (payload.htm !== c.req.method.toUpperCase() || payload.htu !== target.toString()) throw new AuthError("DPoP target mismatch");
  if (payload.ath !== (await sha256Base64Url(accessToken))) throw new AuthError("DPoP access token hash mismatch");
  if (!(await constantTimeEqual(thumbprint, expectedThumbprint))) throw new AuthError("DPoP key binding mismatch");
  return { thumbprint, jti: payload.jti, expiresAt: new Date((payload.iat + DPOP_MAX_AGE_SECONDS) * 1000).toISOString() };
}

async function rememberDpopProof(db: D1Database, proof: VerifiedDpopProof): Promise<void> {
  try {
    await db.batch([
      db.prepare("DELETE FROM dpop_replays WHERE expires_at <= ?").bind(new Date().toISOString()),
      db.prepare("INSERT INTO dpop_replays (thumbprint, jti, expires_at) VALUES (?, ?, ?)").bind(proof.thumbprint, proof.jti, proof.expiresAt),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE") || String(error).includes("PRIMARY KEY")) throw new AuthError("Replayed DPoP proof");
    throw error;
  }
}

async function discover(issuer: string): Promise<OidcMetadata> {
  const normalized = required(issuer, "REALMROOT_ISSUER").replace(/\/$/, "");
  const cached = discoveryCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.metadata;
  const response = await fetch(`${normalized}/.well-known/openid-configuration`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new AuthError(`Realmroot discovery failed with HTTP ${response.status}`);
  const metadata = (await response.json()) as OidcMetadata;
  if (metadata.issuer !== normalized || !metadata.jwks_uri) throw new AuthError("Invalid Realmroot discovery metadata");
  discoveryCache.set(normalized, { metadata, expiresAt: Date.now() + DISCOVERY_CACHE_MS });
  return metadata;
}

async function verifyJwt(token: string, metadata: OidcMetadata, audience: string): Promise<JWTPayload> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new AuthError("Malformed Realmroot token header");
  }
  if (header.typ !== "at+jwt") throw new AuthError("Invalid access token type");
  const algorithms = (metadata.id_token_signing_alg_values_supported ?? ["ES256", "EdDSA", "RS256"]).filter(
    (algorithm) => algorithm !== "none" && !algorithm.startsWith("HS"),
  );
  let jwks = jwksCache.get(metadata.jwks_uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
    jwksCache.set(metadata.jwks_uri, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, { issuer: metadata.issuer, audience, algorithms });
  if (typeof payload.exp !== "number" || payload.aud !== audience) throw new AuthError("Access token audience is invalid");
  return payload;
}

export function tenantFromClaims(claims: JWTPayload): string {
  const organization = claims[ORG_CLAIM];
  if (typeof organization === "string" && organization) return organization;
  if (typeof claims.sub !== "string" || !claims.sub) throw new AuthError("Realmroot subject is missing");
  return `user:${claims.sub}`;
}

export function resourceUrl(env: Env, requestUrl?: string): string {
  if (env.AK_RESOURCE) return env.AK_RESOURCE.replace(/\/$/, "");
  if (requestUrl) return `${new URL(requestUrl).origin}/api`;
  throw new Error("AK_RESOURCE is required");
}

function objectClaim(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

async function sha256Base64Url(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function base64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const leftDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)));
  const rightDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)));
  let difference = 0;
  for (let index = 0; index < leftDigest.length; index += 1) difference |= leftDigest[index] ^ rightDigest[index];
  return difference === 0;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}
