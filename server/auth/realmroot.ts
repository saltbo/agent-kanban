import { storeWebSessionGrant } from "@server/adapters/realmroot/delegatedAgencyToken";
import { akPublicUrl, akResource } from "@server/config/serviceUrls";
import type { Env } from "@server/env";
import { createLogger } from "@server/observability/logger";
import { AGENCY_RUNTIMES } from "@shared";
import type { Context } from "hono";
import { calculateJwkThumbprint, createRemoteJWKSet, decodeProtectedHeader, importJWK, type JWTPayload, errors as joseErrors, jwtVerify } from "jose";

const SESSION_COOKIE = "ak_session";
const LOGIN_COOKIE = "ak_login";
const ORG_CLAIM = "urn:realmroot:params:oauth:org";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOGIN_TTL_SECONDS = 10 * 60;
const DPOP_MAX_AGE_SECONDS = 300;
const DISCOVERY_CACHE_MS = 10 * 60 * 1000;
const OIDC_SIGNING_ALGORITHMS = ["ES256", "ES384", "ES512", "EdDSA", "RS256", "RS384", "RS512", "PS256", "PS384", "PS512"] as const;
const discoveryCache = new Map<string, { metadata: OidcMetadata; expiresAt: number }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const logger = createLogger("realmroot-auth");

export const RESOURCE_SCOPES = [
  "board:read",
  "board:write",
  "repository:read",
  "repository:write",
  "agent:read",
  "agent:write",
  "machine:read",
  "machine:write",
  "task:read",
  "task:write",
  "task:claim",
  "task:assign",
  "task:release",
  "task:review",
  "task:complete",
  "task:reject",
  "task:cancel",
] as const;

type OidcMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
};

type StoredSession = {
  id: string;
  tenant_id: string;
  subject_id: string;
  email: string | null;
  name: string | null;
  image: string | null;
  role: string;
  csrf_token: string;
  expires_at: string;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
};

export type RealmrootPrincipal = {
  source: "session" | "token";
  type: "human" | "machine" | "agent" | "service";
  subjectId: string;
  actorId?: string;
  controllerSubjectId?: string;
  runtime?: string;
  runtimeSessionId?: string;
  tenantId: string;
  clientId?: string;
  scopes: string[];
  sourceAccessToken?: string;
};

export async function beginRealmrootLogin(c: Context<{ Bindings: Env }>): Promise<Response> {
  const metadata = await discover(c.env.OIDC_ISSUER);
  const attemptId = randomToken();
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  const challenge = await sha256Base64Url(verifier);
  const returnTo = safeReturnTo(c.req.query("return_to"));
  const expiresAt = new Date(Date.now() + LOGIN_TTL_SECONDS * 1000).toISOString();

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM realmroot_login_attempts WHERE expires_at <= ?").bind(new Date().toISOString()),
    c.env.DB.prepare(
      `INSERT INTO realmroot_login_attempts
         (id_hash, state_hash, nonce, pkce_verifier, return_to, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(await sha256Hex(attemptId), await sha256Hex(state), nonce, verifier, returnTo, expiresAt),
  ]);

  const callbackUrl = akPublicUrl(c.env, "/api/auth/callback");
  const authorizationUrl = new URL(metadata.authorization_endpoint);
  authorizationUrl.searchParams.set("client_id", required(c.env.OIDC_WEB_CLIENT_ID, "OIDC_WEB_CLIENT_ID"));
  authorizationUrl.searchParams.set("redirect_uri", callbackUrl);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", ["openid", "profile", "email", "offline_access", ...RESOURCE_SCOPES].join(" "));
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("nonce", nonce);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.append("resource", akResource(c.env));

  return new Response(null, {
    status: 302,
    headers: {
      location: authorizationUrl.toString(),
      "set-cookie": cookie(LOGIN_COOKIE, attemptId, LOGIN_TTL_SECONDS),
    },
  });
}

export async function finishRealmrootLogin(c: Context<{ Bindings: Env }>): Promise<Response> {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const attemptId = readCookie(c.req.header("cookie"), LOGIN_COOKIE);
  if (!code || !state || !attemptId) return authFailure("Invalid Realmroot callback");

  const attempt = await c.env.DB.prepare(
    `DELETE FROM realmroot_login_attempts
     WHERE id_hash = ? AND state_hash = ? AND expires_at > ?
     RETURNING nonce, pkce_verifier, return_to`,
  )
    .bind(await sha256Hex(attemptId), await sha256Hex(state), new Date().toISOString())
    .first<{ nonce: string; pkce_verifier: string; return_to: string }>();
  if (!attempt) return authFailure("Expired or replayed Realmroot callback");

  const metadata = await discover(c.env.OIDC_ISSUER);
  const callbackUrl = akPublicUrl(c.env, "/api/auth/callback");
  const tokenResponse = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Basic ${btoa(
        `${required(c.env.OIDC_WEB_CLIENT_ID, "OIDC_WEB_CLIENT_ID")}:${required(c.env.OIDC_WEB_CLIENT_SECRET, "OIDC_WEB_CLIENT_SECRET")}`,
      )}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl,
      code_verifier: attempt.pkce_verifier,
      resource: akResource(c.env),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const tokenBody = (await tokenResponse.json().catch(() => null)) as TokenResponse | null;
  if (!tokenResponse.ok || !tokenBody?.id_token || !tokenBody.access_token || !tokenBody.refresh_token) {
    return authFailure("Realmroot token exchange failed");
  }

  const claims = await verifyJwt(tokenBody.id_token, metadata, c.env.OIDC_WEB_CLIENT_ID, "JWT");
  if (claims.nonce !== attempt.nonce || typeof claims.sub !== "string") return authFailure("Invalid Realmroot ID token");

  const tenantId = tenantFromClaims(claims);
  const roles = stringList(claims.roles ?? claims.role);
  const role = roles.includes("admin") ? "admin" : "member";
  const email = typeof claims.email === "string" ? claims.email : null;
  const name = typeof claims.name === "string" ? claims.name : (email ?? claims.sub);
  const image = typeof claims.picture === "string" ? claims.picture : null;
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO realmroot_tenants (id) VALUES (?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
    ).bind(tenantId),
    c.env.DB.prepare(
      `INSERT INTO realmroot_tenant_members (tenant_id, subject_id, email, name, role)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, subject_id) DO UPDATE SET
         email = excluded.email,
         name = excluded.name,
         role = excluded.role,
         updated_at = ?`,
    ).bind(tenantId, claims.sub, email, name, role, now),
  ]);

  const sessionToken = randomToken(48);
  const sessionId = crypto.randomUUID();
  const csrfToken = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM realmroot_web_sessions WHERE tenant_id = ? AND subject_id = ?").bind(tenantId, claims.sub),
    c.env.DB.prepare(
      `INSERT INTO realmroot_web_sessions
           (id, token_hash, tenant_id, subject_id, email, name, image, role, csrf_token, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(sessionId, await sha256Hex(sessionToken), tenantId, claims.sub, email, name, image, role, csrfToken, expiresAt),
  ]);
  try {
    await storeWebSessionGrant(c.env, sessionId, tokenBody);
  } catch {
    await c.env.DB.prepare("DELETE FROM realmroot_web_sessions WHERE id = ?").bind(sessionId).run();
    return authFailure("Realmroot browser grant storage failed");
  }

  const headers = new Headers({ location: akPublicUrl(c.env, attempt.return_to) });
  headers.append("set-cookie", cookie(SESSION_COOKIE, sessionToken, SESSION_TTL_SECONDS));
  headers.append("set-cookie", expireCookie(LOGIN_COOKIE));
  return new Response(null, { status: 302, headers });
}

export async function readRealmrootWebSession(c: Context<{ Bindings: Env }>): Promise<Response> {
  const stored = await findWebSession(c);
  if (!stored) return c.json(null, 401);
  return c.json(sessionRepresentation(stored));
}

export async function endRealmrootWebSession(c: Context<{ Bindings: Env }>): Promise<Response> {
  const stored = await findWebSession(c);
  if (!stored) return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required" } }, 401);
  const csrf = c.req.header("x-csrf-token");
  if (!csrf || !(await constantTimeEqual(csrf, stored.csrf_token))) {
    return c.json({ error: { code: "CSRF_INVALID", message: "Invalid CSRF token" } }, 403);
  }
  await c.env.DB.prepare("DELETE FROM realmroot_web_sessions WHERE id = ?").bind(stored.id).run();

  const metadata = await discover(c.env.OIDC_ISSUER).catch(() => {
    logger.warn("Realmroot logout discovery failed after local session deletion", { result: "unavailable" });
    return null;
  });
  const logoutUrl = metadata?.end_session_endpoint ? new URL(metadata.end_session_endpoint) : null;
  if (logoutUrl) {
    logoutUrl.searchParams.set("client_id", required(c.env.OIDC_WEB_CLIENT_ID, "OIDC_WEB_CLIENT_ID"));
    logoutUrl.searchParams.set("post_logout_redirect_uri", akPublicUrl(c.env, "/"));
  }
  const headers = new Headers({ "set-cookie": expireCookie(SESSION_COOKIE) });
  if (!logoutUrl) return new Response(null, { status: 204, headers });
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify({ logoutUrl: logoutUrl.toString() }), { status: 200, headers });
}

export async function authenticateWebSession(c: Context<{ Bindings: Env }>): Promise<RealmrootPrincipal | null> {
  const stored = await findWebSession(c);
  if (!stored) return null;
  if (!isSafeMethod(c.req.method)) {
    const csrf = c.req.header("x-csrf-token");
    if (!csrf || !(await constantTimeEqual(csrf, stored.csrf_token))) throw new CsrfError();
  }

  c.set("ownerId", stored.tenant_id);
  c.set("identityType", "user");
  c.set("user", {
    id: stored.subject_id,
    name: stored.name ?? stored.email ?? stored.subject_id,
    email: stored.email ?? "",
    image: stored.image,
    role: stored.role,
  });
  c.set("session", { id: stored.id, expiresAt: new Date(stored.expires_at), csrfToken: stored.csrf_token });
  return { source: "session", type: "human", subjectId: stored.subject_id, tenantId: stored.tenant_id, scopes: [] };
}

export async function authenticateRealmrootToken(c: Context<{ Bindings: Env }>): Promise<RealmrootPrincipal> {
  const authorization = c.req.header("authorization");
  const proof = c.req.header("dpop");
  const credentialMode = authorization?.startsWith("DPoP ") ? "dpop" : authorization?.startsWith("Bearer ") ? "bearer" : null;
  if (!credentialMode) throw new AuthError("Realmroot access token required");
  if (credentialMode === "dpop" && !proof) throw new AuthError("DPoP proof required");
  if (credentialMode === "bearer" && proof) throw new AuthError("Bearer access token must not include a DPoP proof");
  const accessToken = authorization!.slice(credentialMode === "dpop" ? 5 : 7);
  if (!isCompactJwt(accessToken)) throw new AuthError("Invalid OIDC access token");
  validateJwtHeader(accessToken, "at+jwt");
  const metadata = await discover(c.env.OIDC_ISSUER);
  const claims = await verifyJwt(accessToken, metadata, akResource(c.env), "at+jwt");
  const confirmation = claims.cnf as { jkt?: unknown } | undefined;
  if (credentialMode === "bearer" && confirmation !== undefined) throw new AuthError("Sender-constrained access token requires DPoP");
  if (credentialMode === "dpop" && (!confirmation || typeof confirmation.jkt !== "string")) {
    throw new AuthError("Access token is not DPoP-bound");
  }

  const actor = objectClaim(claims.act);
  const actorIssuer = typeof actor?.iss === "string" ? actor.iss : undefined;
  const realmrootAgentId = typeof actor?.sub === "string" ? actor.sub : undefined;
  if (claims.act !== undefined && (!actorIssuer || actorIssuer !== metadata.issuer || !realmrootAgentId)) {
    throw new AuthError("Invalid Realmroot Agent actor");
  }
  const topProfile = typeof claims.sub_profile === "string" ? claims.sub_profile : undefined;
  const clientId = typeof claims.client_id === "string" ? claims.client_id : undefined;
  const tokenSubjectId = typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : undefined;
  if (!clientId) throw new AuthError("Access token has no client id");

  const type = actorIssuer && realmrootAgentId ? "agent" : topProfile === "service" ? "service" : topProfile === "machine" ? "machine" : "human";
  if ((type === "human" || type === "agent") && !tokenSubjectId) throw new AuthError("User or Agent access token has no subject");
  const subjectId = tokenSubjectId ?? clientId;
  if (clientId !== "realmroot-cli") throw new AuthError("Access token client is not Realmroot Toolbox");
  if (credentialMode !== "dpop") throw new AuthError("Realmroot Resource token requires DPoP");
  const runtimeBinding = type === "agent" ? readAgentRuntimeBinding(claims) : null;
  const principal: RealmrootPrincipal = {
    source: "token",
    type,
    subjectId,
    ...(type === "agent" ? { actorId: realmrootAgentId!, controllerSubjectId: subjectId } : {}),
    ...(runtimeBinding ? { runtime: runtimeBinding.runtime, runtimeSessionId: runtimeBinding.sessionId } : {}),
    tenantId: tenantFromClaims(claims),
    ...(clientId ? { clientId } : {}),
    scopes: stringList(claims.scope),
    sourceAccessToken: accessToken,
  };

  if (credentialMode === "dpop") {
    const thumbprint = await verifyDpopProof(c, proof!, accessToken, confirmation!.jkt as string);
    await rememberDpopProof(c.env.DB, thumbprint, proof!);
  }
  return principal;
}

const AGENT_BINDING_CLAIM = "urn:realmroot:params:agent:binding";
function readAgentRuntimeBinding(claims: JWTPayload): { runtime: string; sessionId: string } | null {
  const value = objectClaim(claims[AGENT_BINDING_CLAIM]);
  if (!value) return null;
  const runtime = value.runtime;
  const sessionId = value.session_id;
  if (runtime === undefined && sessionId === undefined) return null;
  if (
    typeof runtime !== "string" ||
    !AGENCY_RUNTIMES.includes(runtime as (typeof AGENCY_RUNTIMES)[number]) ||
    typeof sessionId !== "string" ||
    sessionId.trim() === "" ||
    sessionId.length > 1024
  ) {
    throw new AuthError("Invalid Realmroot Agent runtime session binding");
  }
  return { runtime, sessionId };
}

async function verifyDpopProof(c: Context<{ Bindings: Env }>, proof: string, accessToken: string, expectedThumbprint: string): Promise<string> {
  if (!isCompactJwt(proof)) throw new AuthError("Invalid DPoP proof");
  try {
    const header = decodeProtectedHeader(proof);
    if (header.typ?.toLowerCase() !== "dpop+jwt" || header.alg !== "ES256" || !header.jwk || "d" in header.jwk) {
      throw new AuthError("Invalid DPoP proof header");
    }
    const key = await importJWK(header.jwk, "ES256");
    const { payload } = await jwtVerify(proof, key, { algorithms: ["ES256"], typ: "dpop+jwt" });
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof payload.iat !== "number" ||
      Math.abs(now - payload.iat) >= DPOP_MAX_AGE_SECONDS ||
      typeof payload.jti !== "string" ||
      payload.jti.length === 0 ||
      payload.jti.length > 160
    ) {
      throw new AuthError("Stale DPoP proof");
    }
    const requestUrl = new URL(c.req.url);
    const target = new URL(akPublicUrl(c.env, requestUrl.pathname));
    if (payload.htm !== c.req.method.toUpperCase() || payload.htu !== target.toString()) throw new AuthError("DPoP target mismatch");
    if (payload.ath !== (await sha256Base64Url(accessToken))) throw new AuthError("DPoP access token hash mismatch");
    const thumbprint = await calculateJwkThumbprint(header.jwk, "sha256");
    if (!(await constantTimeEqual(thumbprint, expectedThumbprint))) throw new AuthError("DPoP key binding mismatch");
    return thumbprint;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (error instanceof joseErrors.JOSEError || error instanceof TypeError) throw new AuthError("Invalid DPoP proof");
    throw error;
  }
}

async function rememberDpopProof(db: D1Database, thumbprint: string, proof: string): Promise<void> {
  const { payload } = await jwtVerify(proof, async (header) => importJWK(header.jwk!, "ES256"), { algorithms: ["ES256"] });
  const jti = payload.jti!;
  const expiresAt = new Date(((payload.iat as number) + DPOP_MAX_AGE_SECONDS) * 1000).toISOString();
  try {
    await db.batch([
      db.prepare("DELETE FROM realmroot_dpop_replays WHERE expires_at <= ?").bind(new Date().toISOString()),
      db.prepare("INSERT INTO realmroot_dpop_replays (thumbprint, jti, expires_at) VALUES (?, ?, ?)").bind(thumbprint, jti, expiresAt),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE") || String(error).includes("PRIMARY KEY")) throw new AuthError("Replayed DPoP proof");
    throw error;
  }
}

async function findWebSession(c: Context<{ Bindings: Env }>): Promise<StoredSession | null> {
  const token = readCookie(c.req.header("cookie"), SESSION_COOKIE);
  if (!token) return null;
  return c.env.DB.prepare(
    `SELECT id, tenant_id, subject_id, email, name, image, role, csrf_token, expires_at
     FROM realmroot_web_sessions WHERE token_hash = ? AND expires_at > ?`,
  )
    .bind(await sha256Hex(token), new Date().toISOString())
    .first<StoredSession>();
}

function sessionRepresentation(stored: StoredSession) {
  return {
    session: { id: stored.id, expiresAt: stored.expires_at, csrfToken: stored.csrf_token },
    user: {
      id: stored.subject_id,
      name: stored.name ?? stored.email ?? stored.subject_id,
      email: stored.email ?? "",
      image: stored.image,
      role: stored.role,
      tenantId: stored.tenant_id,
    },
  };
}

async function discover(issuer: string): Promise<OidcMetadata> {
  const normalized = required(issuer, "OIDC_ISSUER").replace(/\/$/, "");
  const cached = discoveryCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.metadata;
  let response: Response;
  try {
    response = await fetch(`${normalized}/.well-known/openid-configuration`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new OidcProviderError("OIDC discovery is unavailable", { cause: error });
  }
  if (!response.ok) {
    throw new OidcProviderError(`OIDC discovery failed with HTTP ${response.status}`);
  }
  const value: unknown = await response.json().catch((error) => {
    throw new OidcProviderError("OIDC discovery returned invalid JSON", { cause: error });
  });
  const metadata = decodeOidcMetadata(value, normalized);
  discoveryCache.set(normalized, { metadata, expiresAt: Date.now() + DISCOVERY_CACHE_MS });
  return metadata;
}

function decodeOidcMetadata(value: unknown, expectedIssuer: string): OidcMetadata {
  const metadata = objectClaim(value);
  if (!metadata || metadata.issuer !== expectedIssuer) throw invalidOidcMetadata();

  const authorizationEndpoint = oidcHttpsUrl(metadata.authorization_endpoint);
  const tokenEndpoint = oidcHttpsUrl(metadata.token_endpoint);
  const jwksUri = oidcHttpsUrl(metadata.jwks_uri);
  if (!authorizationEndpoint || !tokenEndpoint || !jwksUri) throw invalidOidcMetadata();

  const endSessionEndpoint = metadata.end_session_endpoint;
  const normalizedEndSessionEndpoint = endSessionEndpoint === undefined ? undefined : oidcHttpsUrl(endSessionEndpoint);
  if (endSessionEndpoint !== undefined && !normalizedEndSessionEndpoint) throw invalidOidcMetadata();
  const algorithms = metadata.id_token_signing_alg_values_supported;
  if (algorithms !== undefined && (!Array.isArray(algorithms) || algorithms.some((algorithm) => typeof algorithm !== "string"))) {
    throw invalidOidcMetadata();
  }
  const signingAlgorithms = Array.isArray(algorithms)
    ? algorithms.filter((algorithm): algorithm is string => OIDC_SIGNING_ALGORITHMS.includes(algorithm as (typeof OIDC_SIGNING_ALGORITHMS)[number]))
    : undefined;
  if (signingAlgorithms?.length === 0) throw invalidOidcMetadata();

  return {
    issuer: expectedIssuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    jwks_uri: jwksUri,
    ...(normalizedEndSessionEndpoint ? { end_session_endpoint: normalizedEndSessionEndpoint } : {}),
    ...(signingAlgorithms ? { id_token_signing_alg_values_supported: signingAlgorithms } : {}),
  };
}

function oidcHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function invalidOidcMetadata(): OidcProviderError {
  return new OidcProviderError("OIDC discovery returned invalid metadata");
}

async function verifyJwt(token: string, metadata: OidcMetadata, audience: string, typ: string): Promise<JWTPayload> {
  validateJwtHeader(token, typ);
  const algorithms = metadata.id_token_signing_alg_values_supported ?? ["ES256", "EdDSA", "RS256"];
  let jwks = jwksCache.get(metadata.jwks_uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
    jwksCache.set(metadata.jwks_uri, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: metadata.issuer,
      audience,
      algorithms,
    });
    if (typ === "at+jwt" && payload.aud !== audience) throw new AuthError("Access token audience must exactly match the AK Resource");
    return payload;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (isJwksDependencyFailure(error) || error instanceof TypeError) {
      throw new OidcProviderError("OIDC signing keys are unavailable", { cause: error });
    }
    if (error instanceof joseErrors.JOSEError) {
      throw new AuthError(typ === "at+jwt" ? "Invalid OIDC access token" : "Invalid OIDC ID token");
    }
    throw error;
  }
}

function validateJwtHeader(token: string, typ: string): void {
  try {
    const header = decodeProtectedHeader(token);
    if (typ === "at+jwt" && header.typ !== "at+jwt") throw new AuthError("Invalid access token type");
    if (!OIDC_SIGNING_ALGORITHMS.includes(header.alg as (typeof OIDC_SIGNING_ALGORITHMS)[number])) {
      throw new AuthError(typ === "at+jwt" ? "Invalid access token algorithm" : "Invalid ID token algorithm");
    }
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (error instanceof joseErrors.JOSEError || error instanceof TypeError) {
      throw new AuthError(typ === "at+jwt" ? "Invalid OIDC access token" : "Invalid OIDC ID token");
    }
    throw error;
  }
}

function isJwksDependencyFailure(error: unknown): boolean {
  if (!(error instanceof joseErrors.JOSEError)) return false;
  return (
    error.constructor === joseErrors.JOSEError ||
    error instanceof joseErrors.JWKInvalid ||
    error instanceof joseErrors.JWKSInvalid ||
    error instanceof joseErrors.JWKSTimeout
  );
}

export function tenantFromClaims(claims: JWTPayload): string {
  const organization = claims[ORG_CLAIM];
  if (typeof organization === "string" && organization) return organization;
  if (typeof claims.sub !== "string" || !claims.sub) throw new AuthError("Realmroot subject is missing");
  return `user:${claims.sub}`;
}

function objectClaim(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isCompactJwt(value: string): boolean {
  return value.split(".").length === 3 && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}$/.test(value);
}

function safeReturnTo(value: string | undefined): string {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64Url(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

function readCookie(header: string | undefined, name: string): string | null {
  for (const entry of header?.split(";") ?? []) {
    const [key, ...rest] = entry.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function expireCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function authFailure(message: string): Response {
  const url = new URL("/auth", "https://agent-kanban.dev");
  url.searchParams.set("error", message);
  return new Response(null, { status: 302, headers: { location: `${url.pathname}${url.search}`, "set-cookie": expireCookie(LOGIN_COOKIE) } });
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

export class OidcProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OidcProviderError";
  }
}

export class CsrfError extends Error {
  constructor() {
    super("Invalid CSRF token");
    this.name = "CsrfError";
  }
}
