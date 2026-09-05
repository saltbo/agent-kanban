import { agencyResource, akResource } from "@server/config/serviceUrls";
import type { Env } from "@server/env";
import { RealmrootDelegationFailure } from "@server/usecases/agency/failures";

const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const REFRESH_WINDOW_MS = 60_000;

type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number };
type StoredGrant = {
  refresh_token_ciphertext: string;
  refresh_token_nonce: string;
  access_token_ciphertext: string;
  access_token_nonce: string;
  access_token_expires_at: string;
};

export { RealmrootDelegationFailure } from "@server/usecases/agency/failures";

export interface UserGrantIdentity {
  tenantId: string;
  subjectId: string;
}

export async function requireUserGrant(env: Env, user: UserGrantIdentity): Promise<void> {
  const grant = await env.DB.prepare("SELECT 1 FROM realmroot_user_grants WHERE tenant_id = ? AND subject_id = ?")
    .bind(user.tenantId, user.subjectId)
    .first();
  if (!grant)
    throw new RealmrootDelegationFailure(
      "user-login-required",
      "The associated user must sign in to Agent Kanban in a web browser before creating or assigning Tasks. No saved user authorization is available.",
    );
}

export async function storeWebSessionGrant(env: Env, sessionId: string, value: unknown): Promise<void> {
  const user = await env.DB.prepare("SELECT tenant_id, subject_id FROM realmroot_web_sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ tenant_id: string; subject_id: string }>();
  if (!user) throw new RealmrootDelegationFailure("authority-required", "The browser login Session is missing.");
  const tokens = decodeTokenResponse(value);
  if (!tokens.refresh_token) throw new RealmrootDelegationFailure("invalid-response", "Realmroot did not issue the AK browser grant.");
  const access = await encrypt(env, tokens.access_token);
  const refresh = await encrypt(env, tokens.refresh_token);
  await env.DB.prepare(
    `INSERT INTO realmroot_user_grants
       (tenant_id, subject_id, refresh_token_ciphertext, refresh_token_nonce,
        access_token_ciphertext, access_token_nonce, access_token_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, subject_id) DO UPDATE SET
       refresh_token_ciphertext = excluded.refresh_token_ciphertext, refresh_token_nonce = excluded.refresh_token_nonce,
       access_token_ciphertext = excluded.access_token_ciphertext, access_token_nonce = excluded.access_token_nonce,
       access_token_expires_at = excluded.access_token_expires_at, refresh_lease = NULL, refresh_lease_expires_at = NULL,
       updated_at = datetime('now')`,
  )
    .bind(
      user.tenant_id,
      user.subject_id,
      refresh.ciphertext,
      refresh.nonce,
      access.ciphertext,
      access.nonce,
      new Date(Date.now() + Math.max(1, tokens.expires_in ?? 300) * 1000).toISOString(),
    )
    .run();
}

export async function delegatedAgencyToken(
  env: Env,
  input: { sourceAccessToken?: string; user?: UserGrantIdentity; scopes: readonly string[] },
): Promise<string> {
  return delegatedResourceToken(env, { ...input, resource: agencyResource(env) });
}

export async function delegatedResourceToken(
  env: Env,
  input: { sourceAccessToken?: string; user?: UserGrantIdentity; scopes: readonly string[]; resource: string },
): Promise<string> {
  const subjectToken = input.sourceAccessToken ?? (input.user ? await userAccessToken(env, input.user) : null);
  if (!subjectToken) throw new RealmrootDelegationFailure("authority-required", "A current Realmroot authority is required.");
  const endpoint = await tokenEndpoint(env.OIDC_ISSUER);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: clientAuthorization(env),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: subjectToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
        requested_token_type: ACCESS_TOKEN_TYPE,
        audience: input.resource,
        scope: [...new Set(input.scopes)].join(" "),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const value = response.ok ? await responseValue(response) : null;
    if (!response.ok) {
      const kind = delegationFailureKind(response.status);
      throw new RealmrootDelegationFailure(kind, exchangeFailureMessage(kind));
    }
    return decodeTokenResponse(value).access_token;
  } catch (error) {
    if (error instanceof RealmrootDelegationFailure) throw error;
    throw new RealmrootDelegationFailure("unavailable", "Realmroot token exchange is unavailable.");
  }
}

async function userAccessToken(env: Env, user: UserGrantIdentity): Promise<string> {
  const grant = await env.DB.prepare(
    `SELECT refresh_token_ciphertext, refresh_token_nonce, access_token_ciphertext,
            access_token_nonce, access_token_expires_at
     FROM realmroot_user_grants WHERE tenant_id = ? AND subject_id = ?`,
  )
    .bind(user.tenantId, user.subjectId)
    .first<StoredGrant>();
  if (!grant)
    throw new RealmrootDelegationFailure(
      "user-login-required",
      "The associated user must sign in to Agent Kanban in a web browser to authorize background Task execution.",
    );
  if (Date.parse(grant.access_token_expires_at) - REFRESH_WINDOW_MS > Date.now()) {
    return decrypt(env, grant.access_token_ciphertext, grant.access_token_nonce);
  }
  const lease = crypto.randomUUID();
  const acquired = await env.DB.prepare(`UPDATE realmroot_user_grants SET refresh_lease = ?, refresh_lease_expires_at = ?
    WHERE tenant_id = ? AND subject_id = ? AND refresh_token_ciphertext = ?
      AND (refresh_lease IS NULL OR refresh_lease_expires_at <= ?)`)
    .bind(lease, new Date(Date.now() + 30_000).toISOString(), user.tenantId, user.subjectId, grant.refresh_token_ciphertext, new Date().toISOString())
    .run();
  if (acquired.meta.changes !== 1)
    throw new RealmrootDelegationFailure("unavailable", "The user authorization is being refreshed. Retry after the current refresh completes.");
  try {
    const endpoint = await tokenEndpoint(env.OIDC_ISSUER);
    const refreshToken = await decrypt(env, grant.refresh_token_ciphertext, grant.refresh_token_nonce);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { accept: "application/json", authorization: clientAuthorization(env), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, resource: akResource(env) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new RealmrootDelegationFailure("unavailable", "Realmroot token refresh is unavailable.");
    }
    const value = response.ok ? await responseValue(response) : null;
    if (!response.ok) {
      if (response.status >= 500 || response.status === 429) {
        throw new RealmrootDelegationFailure("unavailable", "Realmroot token refresh is unavailable.");
      }
      throw new RealmrootDelegationFailure("reauthenticate", "The Realmroot web grant expired. Sign in again.");
    }
    const tokens = decodeTokenResponse(value);
    const nextRefreshToken = tokens.refresh_token ?? refreshToken;
    const access = await encrypt(env, tokens.access_token);
    const refresh = await encrypt(env, nextRefreshToken);
    await env.DB.prepare(
      `UPDATE realmroot_user_grants SET
       refresh_token_ciphertext = ?, refresh_token_nonce = ?, access_token_ciphertext = ?,
       access_token_nonce = ?, access_token_expires_at = ?, updated_at = datetime('now')
     WHERE tenant_id = ? AND subject_id = ? AND refresh_lease = ?`,
    )
      .bind(
        refresh.ciphertext,
        refresh.nonce,
        access.ciphertext,
        access.nonce,
        new Date(Date.now() + Math.max(1, tokens.expires_in ?? 300) * 1000).toISOString(),
        user.tenantId,
        user.subjectId,
        lease,
      )
      .run();
    return tokens.access_token;
  } finally {
    await env.DB.prepare(
      "UPDATE realmroot_user_grants SET refresh_lease = NULL, refresh_lease_expires_at = NULL WHERE tenant_id = ? AND subject_id = ? AND refresh_lease = ?",
    )
      .bind(user.tenantId, user.subjectId, lease)
      .run();
  }
}

async function responseValue(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new RealmrootDelegationFailure("invalid-response", "Realmroot returned an invalid token response.");
  }
}

function decodeTokenResponse(value: unknown): TokenResponse {
  if (!isRecord(value) || typeof value.access_token !== "string" || value.access_token.length === 0) {
    throw new RealmrootDelegationFailure("invalid-response", "Realmroot returned an invalid token response.");
  }
  if (value.refresh_token !== undefined && (typeof value.refresh_token !== "string" || value.refresh_token.length === 0)) {
    throw new RealmrootDelegationFailure("invalid-response", "Realmroot returned an invalid token response.");
  }
  if (value.expires_in !== undefined && (typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0)) {
    throw new RealmrootDelegationFailure("invalid-response", "Realmroot returned an invalid token response.");
  }
  return {
    access_token: value.access_token,
    ...(typeof value.refresh_token === "string" ? { refresh_token: value.refresh_token } : {}),
    ...(typeof value.expires_in === "number" ? { expires_in: value.expires_in } : {}),
  };
}

function exchangeFailureMessage(kind: "denied" | "invalid-response" | "unavailable"): string {
  if (kind === "unavailable") return "Realmroot token exchange is unavailable.";
  return kind === "denied" ? "Realmroot token exchange was denied." : "Realmroot token exchange failed.";
}

function delegationFailureKind(status: number): "denied" | "invalid-response" | "unavailable" {
  if (status === 429 || status >= 500) return "unavailable";
  return status === 401 ? "invalid-response" : "denied";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function tokenEndpoint(issuer: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(new URL(".well-known/openid-configuration", issuer.endsWith("/") ? issuer : `${issuer}/`), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new RealmrootDelegationFailure("unavailable", "Realmroot discovery is unavailable.");
  }
  const body = (await response.json().catch(() => null)) as { issuer?: unknown; token_endpoint?: unknown } | null;
  if (!response.ok) {
    throw new RealmrootDelegationFailure(
      response.status === 429 || response.status >= 500 ? "unavailable" : "invalid-response",
      "Realmroot discovery failed.",
    );
  }
  if (body?.issuer !== issuer || typeof body.token_endpoint !== "string") {
    throw new RealmrootDelegationFailure("invalid-response", "Realmroot discovery failed.");
  }
  return body.token_endpoint;
}

function clientAuthorization(env: Env): string {
  return `Basic ${btoa(`${required(env.OIDC_WEB_CLIENT_ID, "OIDC_WEB_CLIENT_ID")}:${required(env.OIDC_WEB_CLIENT_SECRET, "OIDC_WEB_CLIENT_SECRET")}`)}`;
}

async function encryptionKey(env: Env): Promise<CryptoKey> {
  const bytes = Uint8Array.from(atob(required(env.AK_SESSION_ENCRYPTION_KEY, "AK_SESSION_ENCRYPTION_KEY")), (value) => value.charCodeAt(0));
  if (bytes.byteLength !== 32) throw new Error("AK_SESSION_ENCRYPTION_KEY must encode exactly 32 bytes");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encrypt(env: Env, value: string): Promise<{ ciphertext: string; nonce: string }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await encryptionKey(env), new TextEncoder().encode(value));
  return { ciphertext: encode(new Uint8Array(ciphertext)), nonce: encode(nonce) };
}

async function decrypt(env: Env, ciphertext: string, nonce: string): Promise<string> {
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(nonce) }, await encryptionKey(env), decode(ciphertext));
  return new TextDecoder().decode(plaintext);
}

function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Uint8Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")), (item) => item.charCodeAt(0)));
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
