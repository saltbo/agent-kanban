// @vitest-environment node

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tenantFromClaims } from "../apps/web/server/realmrootAuth";
import { api } from "../apps/web/server/routes";
import { createTestEnv, createTestWebSession, seedUser, setupMiniflare } from "./helpers/db";

const issuer = "https://id.realmroot.dev/api/auth";
const authorizationEndpoint = `${issuer}/oauth2/authorize`;
const tokenEndpoint = `${issuer}/oauth2/token`;
const jwksUri = `${issuer}/jwks`;
const amaResource = "https://ama.example.test/api";

let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let db: D1Database;

beforeEach(async () => {
  ({ mf, db } = await setupMiniflare());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await mf.dispose();
});

function testEnv() {
  return { ...createTestEnv(), DB: db, AK_RESOURCE: "https://ak.example.test/api" } as never;
}

describe("Realmroot Web application", () => {
  it("completes PKCE login, creates an HttpOnly session, rejects callback replay, and enforces CSRF on logout", async () => {
    await seedUser(db, "org-realmroot-1", "old-session@example.test");
    const oldSession = await createTestWebSession(db, "org-realmroot-1", { subjectId: "realmroot-human-1" });
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "realmroot-test-key";
    const tokenRequests: Request[] = [];
    let loginNonce = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url === `${issuer}/.well-known/openid-configuration`) {
          return Response.json({
            issuer,
            authorization_endpoint: authorizationEndpoint,
            token_endpoint: tokenEndpoint,
            jwks_uri: jwksUri,
            id_token_signing_alg_values_supported: ["ES256"],
          });
        }
        if (request.url === tokenEndpoint) {
          tokenRequests.push(request);
          const idToken = await new SignJWT({
            nonce: loginNonce,
            email: "human@example.test",
            name: "Human User",
            "urn:realmroot:params:oauth:org": "org-realmroot-1",
          })
            .setProtectedHeader({ alg: "ES256", kid: publicJwk.kid, typ: "JWT" })
            .setIssuer(issuer)
            .setAudience("ak-web-test")
            .setSubject("realmroot-human-1")
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(privateKey);
          const form = new URLSearchParams(await request.clone().text());
          if (form.get("grant_type") === "authorization_code") {
            return Response.json({
              id_token: idToken,
              access_token: "ak-access-token",
              refresh_token: "multi-resource-refresh-token",
              token_type: "Bearer",
            });
          }
          return Response.json({
            access_token: "ama-access-token",
            refresh_token: "rotated-ama-refresh-token",
            expires_in: 600,
            token_type: "Bearer",
          });
        }
        if (request.url === jwksUri) return Response.json({ keys: [publicJwk] });
        throw new Error(`Unexpected request: ${request.url}`);
      }),
    );

    const login = await api.fetch(new Request("https://ak.example.test/api/auth/login?return_to=%2Fboards"), testEnv());
    expect(login.status).toBe(302);
    const loginCookie = login.headers.get("set-cookie")!;
    expect(loginCookie).toMatch(/^ak_login=/);
    expect(loginCookie).toContain("HttpOnly");
    expect(loginCookie).toContain("Secure");
    expect(loginCookie).toContain("SameSite=Lax");
    const authorization = new URL(login.headers.get("location")!);
    expect(authorization.origin + authorization.pathname).toBe(authorizationEndpoint);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.getAll("resource")).toEqual(["https://ak.example.test/api", amaResource]);
    const requestedScopes = new Set(authorization.searchParams.get("scope")?.split(" "));
    expect(requestedScopes).toEqual(expect.objectContaining(new Set(["openid", "profile", "email", "offline_access", "ak:read", "ak:write"])));
    expect(requestedScopes).toEqual(expect.objectContaining(new Set(["agents:read", "projects:write", "sessions:write", "vaults:write"])));
    expect(authorization.searchParams.get("state")).toBeTruthy();
    expect(authorization.searchParams.get("nonce")).toBeTruthy();
    loginNonce = authorization.searchParams.get("nonce")!;

    const callback = await api.fetch(
      new Request(
        `https://ak.example.test/api/auth/callback?code=one-time-code&state=${encodeURIComponent(authorization.searchParams.get("state")!)}`,
        { headers: { cookie: loginCookie.split(";")[0] } },
      ),
      testEnv(),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("https://ak.example.test/boards");
    const sessionCookieHeader = callback.headers.get("set-cookie")!;
    expect(sessionCookieHeader).toContain("ak_session=");
    expect(sessionCookieHeader).toContain("HttpOnly");
    expect(sessionCookieHeader).not.toContain("server-only");
    expect(tokenRequests).toHaveLength(2);
    expect(tokenRequests[0].headers.get("authorization")).toBe(`Basic ${btoa("ak-web-test:ak-web-secret")}`);
    const tokenForm = new URLSearchParams(await tokenRequests[0].clone().text());
    expect(tokenForm.get("grant_type")).toBe("authorization_code");
    expect(tokenForm.get("code_verifier")).toBeTruthy();
    expect(tokenForm.get("resource")).toBe("https://ak.example.test/api");
    const amaTokenForm = new URLSearchParams(await tokenRequests[1].clone().text());
    expect(amaTokenForm).toEqual(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "multi-resource-refresh-token",
        resource: amaResource,
      }),
    );
    const storedGrant = await db
      .prepare(
        `SELECT subject_id, refresh_token_ciphertext, refresh_token_nonce,
                access_token_ciphertext, access_token_nonce, access_token_expires_at
         FROM realmroot_user_ama_grants
         WHERE tenant_id = 'org-realmroot-1' AND subject_id = 'realmroot-human-1'`,
      )
      .first<Record<string, string>>();
    expect(storedGrant).toMatchObject({ subject_id: "realmroot-human-1" });
    expect(storedGrant?.refresh_token_ciphertext).not.toContain("rotated-ama-refresh-token");
    expect(storedGrant?.access_token_ciphertext).not.toContain("ama-access-token");
    expect(storedGrant?.refresh_token_nonce).not.toBe(storedGrant?.access_token_nonce);
    expect(Date.parse(storedGrant!.access_token_expires_at)).toBeGreaterThan(Date.now());

    const sessionCookie = sessionCookieHeader.match(/ak_session=([^;,]+)/)![0];
    expect(sessionCookie).not.toBe(oldSession.cookie);
    const rotatedOut = await api.fetch(
      new Request("https://ak.example.test/api/auth/session", { headers: { cookie: oldSession.cookie } }),
      testEnv(),
    );
    expect(rotatedOut.status).toBe(401);
    const sessionResponse = await api.fetch(
      new Request("https://ak.example.test/api/auth/session", { headers: { cookie: sessionCookie } }),
      testEnv(),
    );
    expect(sessionResponse.status).toBe(200);
    const session = (await sessionResponse.json()) as {
      user: { id: string; tenantId: string; email: string };
      session: { csrfToken: string };
    };
    expect(session.user).toMatchObject({
      id: "realmroot-human-1",
      tenantId: "org-realmroot-1",
      email: "human@example.test",
    });

    const noCsrfLogout = await api.fetch(
      new Request("https://ak.example.test/api/auth/logout", { method: "POST", headers: { cookie: sessionCookie } }),
      testEnv(),
    );
    expect(noCsrfLogout.status).toBe(403);
    await expect(noCsrfLogout.json()).resolves.toMatchObject({ error: { code: "CSRF_INVALID", message: "Invalid CSRF token" } });
    const logout = await api.fetch(
      new Request("https://ak.example.test/api/auth/logout", {
        method: "POST",
        headers: { cookie: sessionCookie, "x-csrf-token": session.session.csrfToken },
      }),
      testEnv(),
    );
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM realmroot_user_ama_grants WHERE tenant_id = 'org-realmroot-1' AND subject_id = 'realmroot-human-1'")
        .first(),
    ).toEqual({ count: 0 });
    expect(
      await db.prepare("SELECT subject_id FROM realmroot_user_ama_grants WHERE tenant_id = 'org-realmroot-1'").first<{ subject_id: string }>(),
    ).toEqual({ subject_id: "legacy:org-realmroot-1" });

    const replay = await api.fetch(
      new Request(
        `https://ak.example.test/api/auth/callback?code=replayed-code&state=${encodeURIComponent(authorization.searchParams.get("state")!)}`,
        { headers: { cookie: loginCookie.split(";")[0] } },
      ),
      testEnv(),
    );
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toContain("Expired+or+replayed");
    expect(tokenRequests).toHaveLength(2);
  });

  it("logs out only a valid CSRF-authorized session and returns Realmroot end_session", async () => {
    const logoutIssuer = "https://logout.realmroot.test";
    const logoutEnv = {
      ...testEnv(),
      REALMROOT_ISSUER: logoutIssuer,
      REALMROOT_WEB_CLIENT_ID: "ak-web-logout-test",
    } as never;
    await seedUser(db, "tenant-logout", "logout@example.test");
    const session = await createTestWebSession(db, "tenant-logout", { subjectId: "subject-logout" });
    await db.prepare("DELETE FROM realmroot_user_ama_grants WHERE tenant_id = 'tenant-logout'").run();
    const refreshGrant = await encryptTestSecret("logout-refresh-token");
    const accessGrant = await encryptTestSecret("logout-access-token");
    await db
      .prepare(
        `INSERT INTO realmroot_user_ama_grants
          (tenant_id, subject_id, refresh_token_ciphertext, refresh_token_nonce,
           access_token_ciphertext, access_token_nonce, access_token_expires_at)
         VALUES ('tenant-logout', 'subject-logout', ?, ?, ?, ?, ?)`,
      )
      .bind(refreshGrant.ciphertext, refreshGrant.nonce, accessGrant.ciphertext, accessGrant.nonce, new Date(Date.now() + 60_000).toISOString())
      .run();
    const revocations: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = request.url;
        if (url === `${logoutIssuer}/.well-known/openid-configuration`) {
          return Response.json({
            issuer: logoutIssuer,
            authorization_endpoint: `${logoutIssuer}/authorize`,
            token_endpoint: `${logoutIssuer}/token`,
            jwks_uri: `${logoutIssuer}/jwks`,
            end_session_endpoint: `${logoutIssuer}/logout`,
            revocation_endpoint: `${logoutIssuer}/revoke`,
          });
        }
        if (url === `${logoutIssuer}/revoke`) {
          revocations.push(request);
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    for (const cookie of [undefined, "ak_session=invalid-session"]) {
      const response = await api.fetch(
        new Request("https://ak.example.test/api/auth/logout", {
          method: "POST",
          ...(cookie ? { headers: { cookie } } : {}),
        }),
        logoutEnv,
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
    }

    const withoutCsrf = await api.fetch(
      new Request("https://ak.example.test/api/auth/logout", { method: "POST", headers: { cookie: session.cookie } }),
      logoutEnv,
    );
    expect(withoutCsrf.status).toBe(403);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM realmroot_web_sessions").first<{ count: number }>()).toEqual({ count: 1 });

    const response = await api.fetch(
      new Request("https://ak.example.test/api/auth/logout", {
        method: "POST",
        headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken },
      }),
      logoutEnv,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    const body = (await response.json()) as { logoutUrl: string };
    const logoutUrl = new URL(body.logoutUrl);
    expect(`${logoutUrl.origin}${logoutUrl.pathname}`).toBe(`${logoutIssuer}/logout`);
    expect(logoutUrl.searchParams.get("client_id")).toBe("ak-web-logout-test");
    expect(logoutUrl.searchParams.get("post_logout_redirect_uri")).toBe("https://ak.example.test/");
    expect(await db.prepare("SELECT COUNT(*) AS count FROM realmroot_web_sessions").first<{ count: number }>()).toEqual({ count: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM realmroot_user_ama_grants").first<{ count: number }>()).toEqual({ count: 0 });
    expect(revocations).toHaveLength(1);
    expect(revocations[0].headers.get("authorization")).toBe(`Basic ${btoa("ak-web-logout-test:ak-web-secret")}`);
    expect(new URLSearchParams(await revocations[0].clone().text())).toEqual(
      new URLSearchParams({ token: "logout-refresh-token", token_type_hint: "refresh_token" }),
    );

    const sessionColumns = await db.prepare("PRAGMA table_info(realmroot_web_sessions)").all<{ name: string }>();
    expect(sessionColumns.results.map(({ name }) => name)).not.toContain("refresh_token");
  });

  it("publishes RFC 9728 metadata and an unauthenticated service description", async () => {
    const env = testEnv();
    const metadata = await api.fetch(new Request("https://ak.example.test/.well-known/oauth-protected-resource/api"), env);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      resource: "https://ak.example.test/api",
      authorization_servers: [issuer],
      dpop_signing_alg_values_supported: ["ES256"],
      bearer_methods_supported: ["header"],
      dpop_bound_access_tokens_required: false,
      scopes_supported: expect.arrayContaining(["ak:read", "ak:write", "task:assign", "task:release"]),
    });
    const originMetadata = await api.fetch(new Request("https://ak.example.test/.well-known/oauth-protected-resource"), env);
    expect(originMetadata.status).toBe(200);
    await expect(originMetadata.json()).resolves.toMatchObject({
      resource: "https://ak.example.test/api",
      bearer_methods_supported: ["header"],
      dpop_signing_alg_values_supported: ["ES256"],
      dpop_bound_access_tokens_required: false,
    });

    const service = await api.fetch(new Request("https://ak.example.test/api"), env);
    expect(service.status).toBe(200);
    expect(service.headers.get("content-type")).toContain("application/json");
    expect(service.headers.get("link")).toBe(
      '<https://ak.example.test/api/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json;version=3.1"',
    );
    await expect(service.json()).resolves.toEqual({
      name: "Agent Kanban",
      resource: "https://ak.example.test/api",
      openapi: "https://ak.example.test/api/openapi.json",
    });
    const openapi = await api.fetch(new Request("https://ak.example.test/api/openapi.json"), env);
    expect(openapi.status).toBe(200);
    const document = (await openapi.json()) as {
      openapi: string;
      servers: { url: string }[];
      components: { securitySchemes: Record<string, Record<string, unknown>> };
      paths: Record<string, Record<string, { security?: Record<string, string[]>[] } | unknown>>;
    };
    expect(document).toMatchObject({
      openapi: "3.1.0",
      servers: [{ url: "https://ak.example.test/api" }],
      components: {
        securitySchemes: {
          realmroot: {
            type: "openIdConnect",
            description: expect.stringContaining("Bearer and sender-constrained DPoP"),
            "x-token-types": ["Bearer", "DPoP"],
          },
          agentSession: { type: "http", scheme: "bearer", bearerFormat: "agent+jwt" },
        },
      },
    });
    expect(document.paths["/tasks"].get).toMatchObject({ security: [{ realmroot: ["ak:read"] }, { agentSession: [] }] });
    expect(document.paths["/tasks"].post).toMatchObject({ security: [{ agentSession: [] }] });
    expect(document.paths["/tasks/{taskId}/assign"].post).toMatchObject({ security: [{ agentSession: [] }] });
    expect(document.paths["/tasks/{taskId}/release"].post).toMatchObject({
      security: [{ realmroot: ["task:release"] }, { agentSession: [] }],
    });
    expect(document.paths["/agents"].post).toMatchObject({ security: [{ realmroot: ["ak:write"] }, { agentSession: [] }] });
    expect(document.paths["/agents/{agentId}/sessions"].post).toMatchObject({ security: [{ realmroot: ["ak:write"] }] });
    expect(document.paths["/agents/{agentId}/sessions/{sessionId}/usage"].patch).toMatchObject({
      security: [{ realmroot: ["agent:usage"] }, { agentSession: [] }],
    });
    expect(document.paths["/machines"].post).toMatchObject({ security: [{ realmroot: ["ak:write"] }] });
    expect(document.paths["/repositories/{repositoryId}/github-token"].post).toMatchObject({
      security: [{ realmroot: ["ak:read"] }, { agentSession: [] }],
    });

    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (method === "parameters") continue;
        const security = (operation as { security?: Record<string, string[]>[] }).security;
        expect(security, `${method.toUpperCase()} ${path}`).toBeDefined();
        expect(security?.length, `${method.toUpperCase()} ${path}`).toBeGreaterThan(0);
        for (const requirement of security ?? []) {
          expect(Object.keys(requirement), `${method.toUpperCase()} ${path}`).toHaveLength(1);
          expect(["realmroot", "agentSession"]).toContain(Object.keys(requirement)[0]);
          if ("agentSession" in requirement) expect(requirement.agentSession, `${method.toUpperCase()} ${path}`).toEqual([]);
        }
      }
    }
  });
});

async function encryptTestSecret(value: string): Promise<{ ciphertext: string; nonce: string }> {
  const rawKey = Uint8Array.from(atob("MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE="), (character) => character.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(value)));
  return { ciphertext: base64Url(ciphertext), nonce: base64Url(nonce) };
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("Realmroot tenant contract", () => {
  it("uses the organization claim and otherwise derives user:{sub}", () => {
    expect(tenantFromClaims({ sub: "human-1", "urn:realmroot:params:oauth:org": "org-1" })).toBe("org-1");
    expect(tenantFromClaims({ sub: "human-1" })).toBe("user:human-1");
  });
});
