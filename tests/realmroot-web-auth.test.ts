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
          return Response.json({ id_token: idToken, access_token: "server-only", token_type: "DPoP" });
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
    expect(authorization.searchParams.get("resource")).toBe("https://ak.example.test/api");
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
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].headers.get("authorization")).toBe(`Basic ${btoa("ak-web-test:ak-web-secret")}`);
    const tokenForm = new URLSearchParams(await tokenRequests[0].clone().text());
    expect(tokenForm.get("grant_type")).toBe("authorization_code");
    expect(tokenForm.get("code_verifier")).toBeTruthy();
    expect(tokenForm.get("resource")).toBe("https://ak.example.test/api");

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

    const replay = await api.fetch(
      new Request(
        `https://ak.example.test/api/auth/callback?code=replayed-code&state=${encodeURIComponent(authorization.searchParams.get("state")!)}`,
        { headers: { cookie: loginCookie.split(";")[0] } },
      ),
      testEnv(),
    );
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toContain("Expired+or+replayed");
    expect(tokenRequests).toHaveLength(1);
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === `${logoutIssuer}/.well-known/openid-configuration`) {
          return Response.json({
            issuer: logoutIssuer,
            authorization_endpoint: `${logoutIssuer}/authorize`,
            token_endpoint: `${logoutIssuer}/token`,
            jwks_uri: `${logoutIssuer}/jwks`,
            end_session_endpoint: `${logoutIssuer}/logout`,
          });
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
      bearer_methods_supported: [],
      scopes_supported: expect.arrayContaining(["ak:read", "ak:write", "task:assign", "task:release"]),
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
    expect(await openapi.json()).toMatchObject({
      openapi: "3.1.0",
      servers: [{ url: "https://ak.example.test/api" }],
      paths: {
        "/tasks": { get: { security: [{ realmroot: ["ak:read"] }] } },
        "/tasks/{taskId}/assign": { post: { security: [{ realmroot: ["task:assign"] }] } },
        "/tasks/{taskId}/release": { post: { security: [{ realmroot: ["task:release"] }] } },
        "/agents": { post: { security: [{ realmroot: ["ak:write"] }] } },
      },
    });
  });
});

describe("Realmroot tenant contract", () => {
  it("uses the organization claim and otherwise derives user:{sub}", () => {
    expect(tenantFromClaims({ sub: "human-1", "urn:realmroot:params:oauth:org": "org-1" })).toBe("org-1");
    expect(tenantFromClaims({ sub: "human-1" })).toBe("user:human-1");
  });
});
