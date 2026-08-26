import type { Context } from "hono";
import { calculateJwkThumbprint, createRemoteJWKSet, decodeProtectedHeader, importJWK, type JWTPayload, jwtVerify } from "jose";
import { createLogger } from "./logger";
import type { Env, Principal } from "./types";

const SESSION_COOKIE = "ak_session";
const LOGIN_COOKIE = "ak_login";
const ORG_CLAIM = "urn:realmroot:params:oauth:org";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOGIN_TTL_SECONDS = 10 * 60;
const DPOP_MAX_AGE_SECONDS = 300;
const DISCOVERY_CACHE_MS = 10 * 60 * 1000;
const discoveryCache = new Map<string, { metadata: OidcMetadata; expiresAt: number }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const logger = createLogger("realmroot-auth");
const AMA_TOKEN_REFRESH_WINDOW_MS = 60_000;
const grantOperations = new Map<string, Promise<void>>();

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
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  revocation_endpoint?: string;
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
  scopes_json: string;
  csrf_token: string;
  expires_at: string;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  token_type?: string;
};

type StoredAmaGrant = {
  tenant_id: string;
  subject_id: string;
  refresh_token_ciphertext: string;
  refresh_token_nonce: string;
  access_token_ciphertext: string;
  access_token_nonce: string;
  access_token_expires_at: string;
};

export type RealmrootPrincipal = Principal;

export async function beginRealmrootLogin(c: Context<{ Bindings: Env }>): Promise<Response> {
  const metadata = await discover(c.env.REALMROOT_ISSUER);
  const attemptId = randomToken();
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  const challenge = await sha256Base64Url(verifier);
  const returnTo = safeReturnTo(c.req.query("return_to"));
  const expiresAt = new Date(Date.now() + LOGIN_TTL_SECONDS * 1000).toISOString();

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM login_attempts WHERE expires_at <= ?").bind(new Date().toISOString()),
    c.env.DB.prepare(
      `INSERT INTO login_attempts
         (id_hash, state_hash, nonce, pkce_verifier, return_to, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(await sha256Hex(attemptId), await sha256Hex(state), nonce, verifier, returnTo, expiresAt),
  ]);

  const callbackUrl = publicUrl(c.env, "/api/auth/callback", c.req.url);
  const authorizationUrl = new URL(metadata.authorization_endpoint);
  authorizationUrl.searchParams.set("client_id", required(c.env.REALMROOT_WEB_CLIENT_ID, "REALMROOT_WEB_CLIENT_ID"));
  authorizationUrl.searchParams.set("redirect_uri", callbackUrl);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", ["openid", "profile", "email", "offline_access", ...AK_SCOPES, ...AMA_SCOPES].join(" "));
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("nonce", nonce);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.append("resource", resourceUrl(c.env, c.req.url));
  authorizationUrl.searchParams.append("resource", required(c.env.AMA_RESOURCE, "AMA_RESOURCE"));
  authorizationUrl.searchParams.append("resource", realmrootManagementResource(c.env));

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
    `DELETE FROM login_attempts
     WHERE id_hash = ? AND state_hash = ? AND expires_at > ?
     RETURNING nonce, pkce_verifier, return_to`,
  )
    .bind(await sha256Hex(attemptId), await sha256Hex(state), new Date().toISOString())
    .first<{ nonce: string; pkce_verifier: string; return_to: string }>();
  if (!attempt) return authFailure("Expired or replayed Realmroot callback");

  const metadata = await discover(c.env.REALMROOT_ISSUER);
  const callbackUrl = publicUrl(c.env, "/api/auth/callback", c.req.url);
  const tokenResponse = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Basic ${btoa(
        `${required(c.env.REALMROOT_WEB_CLIENT_ID, "REALMROOT_WEB_CLIENT_ID")}:${required(
          c.env.REALMROOT_WEB_CLIENT_SECRET,
          "REALMROOT_WEB_CLIENT_SECRET",
        )}`,
      )}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl,
      code_verifier: attempt.pkce_verifier,
      resource: resourceUrl(c.env, c.req.url),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const tokenBody = (await tokenResponse.json().catch(() => null)) as TokenResponse | null;
  if (!tokenResponse.ok || !tokenBody?.id_token || !tokenBody.access_token || !tokenBody.refresh_token)
    return authFailure("Realmroot token exchange failed");

  const claims = await verifyJwt(tokenBody.id_token, metadata, c.env.REALMROOT_WEB_CLIENT_ID, "JWT");
  if (claims.nonce !== attempt.nonce || typeof claims.sub !== "string") return authFailure("Invalid Realmroot ID token");

  const tenantId = tenantFromClaims(claims);
  const accessClaims = await verifyJwt(tokenBody.access_token, metadata, resourceUrl(c.env, c.req.url), "at+jwt");
  if (accessClaims.sub !== claims.sub || tenantFromClaims(accessClaims) !== tenantId) return authFailure("Realmroot AK grant identity mismatch");
  const akScopes = stringList(accessClaims.scope);
  const roles = stringList(claims.roles ?? claims.role);
  const role = roles.includes("admin") ? "admin" : "member";
  const email = typeof claims.email === "string" ? claims.email : null;
  const name = typeof claims.name === "string" ? claims.name : (email ?? claims.sub);
  const image = typeof claims.picture === "string" ? claims.picture : null;
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO tenants (id) VALUES (?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
    ).bind(tenantId),
    c.env.DB.prepare(
      `INSERT INTO tenant_members (tenant_id, subject_id, email, name, role)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, subject_id) DO UPDATE SET
         email = excluded.email,
         name = excluded.name,
         role = excluded.role,
         updated_at = ?`,
    ).bind(tenantId, claims.sub, email, name, role, now),
  ]);

  const amaTokens = await exchangeRefreshToken(c.env, metadata, tokenBody.refresh_token, required(c.env.AMA_RESOURCE, "AMA_RESOURCE")).catch(
    () => null,
  );
  if (!amaTokens?.access_token || !amaTokens.refresh_token) return authFailure("Realmroot AMA grant exchange failed");
  const encryptedRefresh = await encryptSecret(c.env, amaTokens.refresh_token);
  const encryptedAccess = await encryptSecret(c.env, amaTokens.access_token);
  const accessExpiresAt = new Date(Date.now() + Math.max(1, amaTokens.expires_in ?? 300) * 1000).toISOString();
  const grantUpsert = c.env.DB.prepare(
    `INSERT INTO ama_grants
       (tenant_id, subject_id, refresh_token_ciphertext, refresh_token_nonce, access_token_ciphertext, access_token_nonce, access_token_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, subject_id) DO UPDATE SET
       refresh_token_ciphertext = excluded.refresh_token_ciphertext,
       refresh_token_nonce = excluded.refresh_token_nonce,
       access_token_ciphertext = excluded.access_token_ciphertext,
       access_token_nonce = excluded.access_token_nonce,
       access_token_expires_at = excluded.access_token_expires_at,
       updated_at = datetime('now')`,
  ).bind(
    tenantId,
    claims.sub,
    encryptedRefresh.ciphertext,
    encryptedRefresh.nonce,
    encryptedAccess.ciphertext,
    encryptedAccess.nonce,
    accessExpiresAt,
  );

  const sessionToken = randomToken(48);
  const sessionId = crypto.randomUUID();
  const csrfToken = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await c.env.DB.batch([
    grantUpsert,
    c.env.DB.prepare("DELETE FROM web_sessions WHERE tenant_id = ? AND subject_id = ?").bind(tenantId, claims.sub),
    c.env.DB.prepare(
      `INSERT INTO web_sessions
           (id, token_hash, tenant_id, subject_id, email, name, image, role, scopes_json, csrf_token, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(sessionId, await sha256Hex(sessionToken), tenantId, claims.sub, email, name, image, role, JSON.stringify(akScopes), csrfToken, expiresAt),
  ]);

  const headers = new Headers({ location: publicUrl(c.env, attempt.return_to, c.req.url) });
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
  await c.env.DB.prepare("DELETE FROM web_sessions WHERE id = ?").bind(stored.id).run();
  const revokedGrant = await releaseAmaGrantIfUnused(c.env, stored.tenant_id, stored.subject_id);

  const metadata = await discover(c.env.REALMROOT_ISSUER).catch((error) => {
    logger.warn(`Realmroot logout discovery failed after local session deletion: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (revokedGrant && metadata?.revocation_endpoint) await revokeRefreshToken(c.env, metadata.revocation_endpoint, revokedGrant);
  const logoutUrl = metadata?.end_session_endpoint ? new URL(metadata.end_session_endpoint) : null;
  if (logoutUrl) {
    logoutUrl.searchParams.set("client_id", required(c.env.REALMROOT_WEB_CLIENT_ID, "REALMROOT_WEB_CLIENT_ID"));
    logoutUrl.searchParams.set("post_logout_redirect_uri", publicUrl(c.env, "/", c.req.url));
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
  c.set("user", {
    id: stored.subject_id,
    name: stored.name ?? stored.email ?? stored.subject_id,
    email: stored.email ?? "",
    image: stored.image,
    role: stored.role,
  });
  c.set("session", { id: stored.id, expiresAt: new Date(stored.expires_at), csrfToken: stored.csrf_token });
  return {
    source: "session",
    type: "human",
    subjectId: stored.subject_id,
    tenantId: stored.tenant_id,
    scopes: JSON.parse(stored.scopes_json) as string[],
  };
}

export async function authenticateRealmrootToken(c: Context<{ Bindings: Env }>): Promise<RealmrootPrincipal> {
  const authorization = c.req.header("authorization");
  const proof = c.req.header("dpop");
  const credentialMode = authorization?.startsWith("DPoP ") ? "dpop" : authorization?.startsWith("Bearer ") ? "bearer" : null;
  if (!credentialMode) throw new AuthError("Realmroot access token required");
  if (credentialMode === "dpop" && !proof) throw new AuthError("DPoP proof required");
  if (credentialMode === "bearer" && proof) throw new AuthError("Bearer access token must not include a DPoP proof");
  const accessToken = authorization!.slice(credentialMode === "dpop" ? 5 : 7);
  const metadata = await discover(c.env.REALMROOT_ISSUER);
  const claims = await verifyJwt(accessToken, metadata, resourceUrl(c.env, c.req.url), "at+jwt");
  const confirmation = claims.cnf as { jkt?: unknown } | undefined;
  if (credentialMode === "bearer" && confirmation !== undefined) throw new AuthError("Sender-constrained access token requires DPoP");
  if (credentialMode === "dpop" && (!confirmation || typeof confirmation.jkt !== "string")) {
    throw new AuthError("Access token is not DPoP-bound");
  }

  const actor = objectClaim(claims.act);
  if (claims.act !== undefined && !actor) throw new AuthError("Agent actor claim is invalid");
  const topProfile = typeof claims.sub_profile === "string" ? claims.sub_profile : undefined;
  const actorIssuer = actor && typeof actor.iss === "string" ? actor.iss : undefined;
  const realmrootAgentId = actor && typeof actor.sub === "string" ? actor.sub : undefined;
  const clientId = typeof claims.client_id === "string" ? claims.client_id : typeof claims.azp === "string" ? claims.azp : undefined;
  const subjectId = typeof claims.sub === "string" ? claims.sub : clientId;
  if (!clientId) throw new AuthError("Access token has no client id");
  if (!subjectId) throw new AuthError("Access token has no subject");

  const allowedClientIds = new Set([required(c.env.REALMROOT_CLI_CLIENT_ID, "REALMROOT_CLI_CLIENT_ID"), "realmroot-cli"]);
  if (!allowedClientIds.has(clientId)) throw new AuthError("Access token client is not allowed for AK");
  if (actor && (!realmrootAgentId || !actorIssuer)) throw new AuthError("Agent actor identity is incomplete");
  if (actorIssuer && actorIssuer.replace(/\/$/, "") !== metadata.issuer.replace(/\/$/, "")) {
    throw new AuthError("Agent actor issuer is not trusted");
  }
  const type = actor ? "agent" : topProfile === "service" ? "service" : topProfile === "machine" ? "machine" : "human";
  if (type === "agent" && credentialMode !== "dpop") throw new AuthError("Realmroot Agent token requires DPoP");
  const principal: RealmrootPrincipal = {
    source: "token",
    type,
    subjectId,
    tenantId: tenantFromClaims(claims),
    ...(clientId ? { clientId } : {}),
    scopes: stringList(claims.scope),
    ...(realmrootAgentId && actorIssuer ? { actor: { issuer: metadata.issuer, subject: realmrootAgentId } } : {}),
  };

  if (credentialMode === "dpop") {
    const verifiedProof = await verifyDpopProof(c, proof!, accessToken, confirmation!.jkt as string);
    await rememberDpopProof(c.env.DB, verifiedProof);
  }
  return principal;
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
  ) {
    throw new AuthError("Stale DPoP proof");
  }
  const target = new URL(c.req.url);
  target.hash = "";
  target.search = "";
  if (payload.htm !== c.req.method.toUpperCase() || payload.htu !== target.toString()) throw new AuthError("DPoP target mismatch");
  if (payload.ath !== (await sha256Base64Url(accessToken))) throw new AuthError("DPoP access token hash mismatch");
  if (!(await constantTimeEqual(thumbprint, expectedThumbprint))) throw new AuthError("DPoP key binding mismatch");
  return {
    thumbprint,
    jti: payload.jti,
    expiresAt: new Date((payload.iat + DPOP_MAX_AGE_SECONDS) * 1000).toISOString(),
  };
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

export class AmaUserGrantRequired extends Error {
  readonly status = 401;
  readonly code = "AMA_USER_GRANT_REQUIRED";

  constructor(message = "Sign in again to authorize Agent Kanban to use AMA.") {
    super(message);
    this.name = "AmaUserGrantRequired";
  }
}

export async function amaBearerToken(env: Env, tenantId: string, forceRefresh = false, subjectId?: string): Promise<string> {
  const refreshKey = `${tenantId}\0${subjectId ?? ""}`;
  return serializeGrantOperation(refreshKey, () => refreshAmaBearerToken(env, tenantId, forceRefresh, subjectId));
}

export async function realmrootManagementBearerToken(env: Env, tenantId: string, subjectId: string): Promise<string> {
  const refreshKey = `${tenantId}\0${subjectId}`;
  return serializeGrantOperation(refreshKey, () => exchangeRealmrootManagementBearerToken(env, tenantId, subjectId));
}

export async function releaseAmaGrantIfUnused(env: Env, tenantId: string, subjectId: string): Promise<string | null> {
  const grant = await findAmaGrant(env.DB, tenantId, subjectId);
  if (!grant) return null;
  const refreshToken = await decryptSecret(env, grant.refresh_token_ciphertext, grant.refresh_token_nonce);
  const deleted = await env.DB.prepare(
    `DELETE FROM ama_grants WHERE tenant_id = ? AND subject_id = ?
     AND NOT EXISTS (SELECT 1 FROM ama_connections WHERE tenant_id = ? AND authorized_subject_id = ?)`,
  )
    .bind(tenantId, subjectId, tenantId, subjectId)
    .run();
  return (deleted.meta.changes ?? 0) === 1 ? refreshToken : null;
}

export async function revokeReleasedAmaGrant(env: Env, refreshToken: string | null): Promise<void> {
  if (!refreshToken) return;
  const metadata = await discover(env.REALMROOT_ISSUER);
  if (metadata.revocation_endpoint) await revokeRefreshToken(env, metadata.revocation_endpoint, refreshToken);
}

async function refreshAmaBearerToken(env: Env, tenantId: string, forceRefresh: boolean, subjectId?: string): Promise<string> {
  let grant = await findAmaGrant(env.DB, tenantId, subjectId);
  if (!grant) throw new AmaUserGrantRequired();
  if (!forceRefresh && Date.parse(grant.access_token_expires_at) - AMA_TOKEN_REFRESH_WINDOW_MS > Date.now()) {
    return decryptSecret(env, grant.access_token_ciphertext, grant.access_token_nonce);
  }

  const metadata = await discover(env.REALMROOT_ISSUER);
  const refreshToken = await decryptSecret(env, grant.refresh_token_ciphertext, grant.refresh_token_nonce);
  const tokens = await exchangeRefreshToken(env, metadata, refreshToken, required(env.AMA_RESOURCE, "AMA_RESOURCE")).catch(async (error) => {
    const current = await findAmaGrant(env.DB, tenantId, subjectId);
    if (current && current.refresh_token_ciphertext !== grant?.refresh_token_ciphertext) {
      return {
        access_token: await decryptSecret(env, current.access_token_ciphertext, current.access_token_nonce),
        refresh_token: await decryptSecret(env, current.refresh_token_ciphertext, current.refresh_token_nonce),
        expires_in: Math.max(1, Math.floor((Date.parse(current.access_token_expires_at) - Date.now()) / 1000)),
      } satisfies TokenResponse;
    }
    throw error;
  });
  if (!tokens.access_token || !tokens.refresh_token) throw new AmaUserGrantRequired("Realmroot did not return an AMA access grant.");
  const encryptedRefresh = await encryptSecret(env, tokens.refresh_token);
  const encryptedAccess = await encryptSecret(env, tokens.access_token);
  const expiresAt = new Date(Date.now() + Math.max(1, tokens.expires_in ?? 300) * 1000).toISOString();
  const updated = await env.DB.prepare(
    `UPDATE ama_grants SET
       refresh_token_ciphertext = ?, refresh_token_nonce = ?,
       access_token_ciphertext = ?, access_token_nonce = ?, access_token_expires_at = ?, updated_at = datetime('now')
     WHERE tenant_id = ? AND subject_id = ? AND refresh_token_ciphertext = ?`,
  )
    .bind(
      encryptedRefresh.ciphertext,
      encryptedRefresh.nonce,
      encryptedAccess.ciphertext,
      encryptedAccess.nonce,
      expiresAt,
      grant.tenant_id,
      grant.subject_id,
      grant.refresh_token_ciphertext,
    )
    .run();
  if ((updated.meta.changes ?? 0) === 0) {
    grant = await findAmaGrant(env.DB, tenantId, subjectId);
    if (!grant) throw new AmaUserGrantRequired();
    return decryptSecret(env, grant.access_token_ciphertext, grant.access_token_nonce);
  }
  return tokens.access_token;
}

async function exchangeRealmrootManagementBearerToken(env: Env, tenantId: string, subjectId: string): Promise<string> {
  const grant = await findAmaGrant(env.DB, tenantId, subjectId);
  if (!grant) throw new AmaUserGrantRequired();
  const metadata = await discover(env.REALMROOT_ISSUER);
  const refreshToken = await decryptSecret(env, grant.refresh_token_ciphertext, grant.refresh_token_nonce);
  let tokens: TokenResponse;
  try {
    tokens = await exchangeRefreshToken(env, metadata, refreshToken, realmrootManagementResource(env));
  } catch (error) {
    const current = await findAmaGrant(env.DB, tenantId, subjectId);
    if (current && current.refresh_token_ciphertext !== grant.refresh_token_ciphertext) {
      return exchangeRealmrootManagementBearerToken(env, tenantId, subjectId);
    }
    throw error;
  }
  if (!tokens.access_token || !tokens.refresh_token || tokens.token_type?.toLowerCase() !== "bearer") {
    throw new AmaUserGrantRequired("Realmroot did not return a User management grant.");
  }
  const encryptedRefresh = await encryptSecret(env, tokens.refresh_token);
  const updated = await env.DB.prepare(
    `UPDATE ama_grants SET refresh_token_ciphertext = ?, refresh_token_nonce = ?, updated_at = datetime('now')
     WHERE tenant_id = ? AND subject_id = ? AND refresh_token_ciphertext = ?`,
  )
    .bind(encryptedRefresh.ciphertext, encryptedRefresh.nonce, tenantId, subjectId, grant.refresh_token_ciphertext)
    .run();
  if ((updated.meta.changes ?? 0) === 0) return exchangeRealmrootManagementBearerToken(env, tenantId, subjectId);
  return tokens.access_token;
}

async function serializeGrantOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = grantOperations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  grantOperations.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (grantOperations.get(key) === tail) grantOperations.delete(key);
  }
}

async function findAmaGrant(db: D1Database, tenantId: string, subjectId?: string): Promise<StoredAmaGrant | null> {
  const suffix = subjectId ? "AND subject_id = ?" : "";
  const statement = db.prepare(
    `SELECT tenant_id, subject_id, refresh_token_ciphertext, refresh_token_nonce,
            access_token_ciphertext, access_token_nonce, access_token_expires_at
     FROM ama_grants WHERE tenant_id = ? ${suffix}
     ORDER BY updated_at DESC LIMIT 1`,
  );
  return (subjectId ? statement.bind(tenantId, subjectId) : statement.bind(tenantId)).first<StoredAmaGrant>();
}

async function exchangeRefreshToken(env: Env, metadata: OidcMetadata, refreshToken: string, resource: string): Promise<TokenResponse> {
  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: basicClientAuthorization(env),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, resource }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => null)) as TokenResponse | null;
  if (!response.ok || !body) throw new AmaUserGrantRequired("Realmroot AMA grant refresh failed.");
  return body;
}

function realmrootManagementResource(env: Env): string {
  return `${new URL(required(env.REALMROOT_ISSUER, "REALMROOT_ISSUER")).origin}/api`;
}

async function revokeRefreshToken(env: Env, endpoint: string, token: string): Promise<void> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: basicClientAuthorization(env), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, token_type_hint: "refresh_token" }),
    signal: AbortSignal.timeout(10_000),
  }).catch((error) => {
    logger.warn(`Realmroot refresh-token revocation failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (response && !response.ok) logger.warn(`Realmroot refresh-token revocation failed with HTTP ${response.status}`);
}

function basicClientAuthorization(env: Env): string {
  return `Basic ${btoa(`${required(env.REALMROOT_WEB_CLIENT_ID, "REALMROOT_WEB_CLIENT_ID")}:${required(env.REALMROOT_WEB_CLIENT_SECRET, "REALMROOT_WEB_CLIENT_SECRET")}`)}`;
}

async function encryptionKey(env: Env): Promise<CryptoKey> {
  const encoded = required(env.REALMROOT_SESSION_ENCRYPTION_KEY, "REALMROOT_SESSION_ENCRYPTION_KEY");
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 32) throw new Error("REALMROOT_SESSION_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptSecret(env: Env, value: string): Promise<{ ciphertext: string; nonce: string }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await encryptionKey(env), new TextEncoder().encode(value));
  return { ciphertext: base64Url(new Uint8Array(ciphertext)), nonce: base64Url(nonce) };
}

async function decryptSecret(env: Env, ciphertext: string, nonce: string): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(nonce).buffer as ArrayBuffer },
    await encryptionKey(env),
    fromBase64Url(ciphertext).buffer as ArrayBuffer,
  );
  return new TextDecoder().decode(plaintext);
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function findWebSession(c: Context<{ Bindings: Env }>): Promise<StoredSession | null> {
  const token = readCookie(c.req.header("cookie"), SESSION_COOKIE);
  if (!token) return null;
  return c.env.DB.prepare(
    `SELECT id, tenant_id, subject_id, email, name, image, role, scopes_json, csrf_token, expires_at
     FROM web_sessions WHERE token_hash = ? AND expires_at > ?`,
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
  const normalized = required(issuer, "REALMROOT_ISSUER").replace(/\/$/, "");
  const cached = discoveryCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.metadata;
  const response = await fetch(`${normalized}/.well-known/openid-configuration`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new AuthError(`Realmroot discovery failed with HTTP ${response.status}`);
  const metadata = (await response.json()) as OidcMetadata;
  if (metadata.issuer !== normalized || !metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.jwks_uri) {
    throw new AuthError("Invalid Realmroot discovery metadata");
  }
  discoveryCache.set(normalized, { metadata, expiresAt: Date.now() + DISCOVERY_CACHE_MS });
  return metadata;
}

async function verifyJwt(token: string, metadata: OidcMetadata, audience: string, typ: string): Promise<JWTPayload> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new AuthError("Malformed Realmroot token header");
  }
  if (typ === "at+jwt" && header.typ !== "at+jwt") throw new AuthError("Invalid access token type");
  const algorithms = (metadata.id_token_signing_alg_values_supported ?? ["ES256", "EdDSA", "RS256"]).filter(
    (algorithm) => algorithm !== "none" && !algorithm.startsWith("HS"),
  );
  let jwks = jwksCache.get(metadata.jwks_uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
    jwksCache.set(metadata.jwks_uri, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, {
    issuer: metadata.issuer,
    audience,
    algorithms,
  });
  if (typeof payload.exp !== "number") throw new AuthError("Realmroot token has no expiration");
  if (typ === "at+jwt" && payload.aud !== audience) throw new AuthError("Access token audience must exactly match the AK Resource");
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

function safeReturnTo(value: string | undefined): string {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function publicUrl(env: Env, path: string, requestUrl: string): string {
  return new URL(path, env.AK_PUBLIC_ORIGIN || env.AK_RESOURCE || requestUrl).toString();
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

export class CsrfError extends Error {
  constructor() {
    super("Invalid CSRF token");
    this.name = "CsrfError";
  }
}
