// @vitest-environment node

import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../server/env";
import { api } from "../../../server/http/app";
import { createTestEnv, setupMiniflare } from "../../helpers/db";

const tenantId = "tenant-login-bootstrap";
const subjectId = "login-bootstrap-human";

let fixture: Awaited<ReturnType<typeof setupMiniflare>>;
let env: Env;

beforeEach(async () => {
  fixture = await setupMiniflare();
  env = {
    ...createTestEnv(),
    DB: fixture.db,
    OIDC_ISSUER: `https://id-login-${randomUUID()}.example.test/api/auth`,
    OIDC_WEB_CLIENT_ID: "ak-web-login-test",
    OIDC_WEB_CLIENT_SECRET: "ak-web-login-secret",
    AK_PUBLIC_ORIGIN: "https://ak-login.example.test",
    AMA_ORIGIN: "https://ama-login.example.test",
  } as Env;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await fixture.mf.dispose();
});

describe("Realmroot login AMA Project bootstrap", () => {
  it.each(["reuse", "create"] as const)(
    "[spec: agents/transparent-ama-project] bootstraps the fixed-name AMA Project by %s before establishing the web session",
    async (mode) => {
      const events: string[] = [];
      const callback = await completeLogin(mode, events);

      expect(callback.status, await callback.clone().text()).toBe(302);
      expect(callback.headers.get("set-cookie")).toContain("ak_session=");
      expect(events).toEqual(
        mode === "reuse"
          ? ["token:authorization_code", "token:projects", "projects:list"]
          : ["token:authorization_code", "token:projects", "projects:list", "projects:create"],
      );
      await expect(
        fixture.db.prepare("SELECT ama_project_id FROM ama_owner_integrations WHERE tenant_id = ?").bind(tenantId).first(),
      ).resolves.toEqual({ ama_project_id: mode === "reuse" ? "project-existing" : "project-created" });
      await expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM realmroot_web_sessions").first()).resolves.toEqual({ count: 1 });
      await expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM realmroot_web_session_grants").first()).resolves.toEqual({ count: 1 });
    },
  );

  it("[spec: agents/transparent-ama-project] leaves no usable AK web session when AMA bootstrap fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const callback = await completeLogin("failure", []);

    const location = new URL(callback.headers.get("location")!, env.AK_PUBLIC_ORIGIN);
    expect(location.pathname).toBe("/auth");
    expect(location.searchParams.get("error")).toBe("Agent Kanban workspace initialization failed. Try signing in again.");
    const setCookie = callback.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("ak_login=;");
    expect(setCookie).not.toContain("ak_session=");
    await expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM realmroot_web_sessions").first()).resolves.toEqual({ count: 0 });
    await expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM realmroot_web_session_grants").first()).resolves.toEqual({ count: 0 });
    await expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM ama_owner_integrations").first()).resolves.toEqual({ count: 0 });
    const completionEvents = consoleError.mock.calls
      .map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
      .filter((entry) => entry.msg === "request completed" && entry.path === "/api/auth/callback");
    expect(completionEvents).toEqual([
      expect.objectContaining({
        result: "server_error",
        error_name: "AmaProjectionError",
        error_kind: "unavailable",
        error_message: "AMA is unavailable",
      }),
    ]);
  });

  it("[spec: agents/transparent-ama-project] coalesces concurrent callbacks onto one AMA Project before establishing either session", async () => {
    const { callbacks, createCount } = await completeConcurrentLogins();

    expect(callbacks.map((response) => response.status)).toEqual([302, 302]);
    for (const callback of callbacks) expect(callback.headers.get("set-cookie")).toContain("ak_session=");
    expect(createCount()).toBe(1);
    await expect(fixture.db.prepare("SELECT tenant_id, ama_project_id FROM ama_owner_integrations").all()).resolves.toMatchObject({
      results: [{ tenant_id: tenantId, ama_project_id: "project-concurrent" }],
    });

    const sessions = await fixture.db
      .prepare("SELECT COUNT(*) AS count FROM realmroot_web_sessions WHERE tenant_id = ? AND subject_id = ?")
      .bind(tenantId, subjectId)
      .first<{ count: number }>();
    const grants = await fixture.db.prepare("SELECT COUNT(*) AS count FROM realmroot_web_session_grants").first<{ count: number }>();
    expect(sessions?.count).toBeGreaterThanOrEqual(1);
    expect(grants?.count).toBe(sessions?.count);
  });

  it("[spec: agents/transparent-ama-project] isolates fixed-name AMA Projects by tenant binding", async () => {
    const first = await completeLogin(
      "create",
      [],
      { tenantId: "tenant-bootstrap-a", subjectId: "human-bootstrap-a" },
      { existing: "unused-a", created: "project-tenant-a" },
    );
    env = { ...env, OIDC_ISSUER: `https://id-login-${randomUUID()}.example.test/api/auth` };
    const second = await completeLogin(
      "create",
      [],
      { tenantId: "tenant-bootstrap-b", subjectId: "human-bootstrap-b" },
      { existing: "unused-b", created: "project-tenant-b" },
    );

    expect(first.headers.get("set-cookie")).toContain("ak_session=");
    expect(second.headers.get("set-cookie")).toContain("ak_session=");
    await expect(fixture.db.prepare("SELECT tenant_id, ama_project_id FROM ama_owner_integrations ORDER BY tenant_id").all()).resolves.toMatchObject({
      results: [
        { tenant_id: "tenant-bootstrap-a", ama_project_id: "project-tenant-a" },
        { tenant_id: "tenant-bootstrap-b", ama_project_id: "project-tenant-b" },
      ],
    });
  });
});

async function completeConcurrentLogins(): Promise<{ callbacks: Response[]; createCount: () => number }> {
  const keys = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = `login-key-${randomUUID()}`;
  const jwksUri = `${env.OIDC_ISSUER}/jwks`;
  const nonces = new Map<string, string>();
  let projectsCreated = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if (request.url === `${env.OIDC_ISSUER}/.well-known/openid-configuration`) {
        return Response.json({
          issuer: env.OIDC_ISSUER,
          authorization_endpoint: `${env.OIDC_ISSUER}/oauth2/authorize`,
          token_endpoint: `${env.OIDC_ISSUER}/oauth2/token`,
          jwks_uri: jwksUri,
          id_token_signing_alg_values_supported: ["ES256"],
        });
      }
      if (request.url === jwksUri) return Response.json({ keys: [jwk] });
      if (request.url === `${env.OIDC_ISSUER}/oauth2/token`) {
        const body = new URLSearchParams(await request.text());
        if (body.get("grant_type") === "authorization_code") {
          const code = body.get("code")!;
          const idToken = await new SignJWT({
            nonce: nonces.get(code),
            email: "concurrent@example.test",
            "urn:realmroot:params:oauth:org": tenantId,
          })
            .setProtectedHeader({ alg: "ES256", kid: jwk.kid, typ: "JWT" })
            .setIssuer(env.OIDC_ISSUER)
            .setAudience(env.OIDC_WEB_CLIENT_ID)
            .setSubject(subjectId)
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(keys.privateKey);
          return Response.json({
            id_token: idToken,
            access_token: `fresh-ak-access-${code}`,
            refresh_token: `fresh-ak-refresh-${code}`,
            expires_in: 300,
          });
        }
        return Response.json({ access_token: "ama-project-token" });
      }
      const url = new URL(request.url);
      if (url.origin === env.AMA_ORIGIN && url.pathname === "/api/v1/projects" && request.method === "GET") {
        expect(url.searchParams.get("limit")).toBe("100");
        await expectNoEstablishedWebSession(tenantId);
        return Response.json({ data: [], pagination: { nextCursor: null, hasMore: false } });
      }
      if (url.origin === env.AMA_ORIGIN && url.pathname === "/api/v1/projects" && request.method === "POST") {
        projectsCreated += 1;
        await expect(request.json()).resolves.toEqual({ name: "Agent Kanban" });
        await expectNoEstablishedWebSession(tenantId);
        return Response.json(amaProject("project-concurrent"), { status: 201 });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    }),
  );

  const attempts = await Promise.all(
    ["concurrent-code-a", "concurrent-code-b"].map(async (code) => {
      const begin = await api.fetch(new Request(`${env.AK_PUBLIC_ORIGIN}/api/auth/login`), env);
      const authorizationUrl = new URL(begin.headers.get("location")!);
      nonces.set(code, authorizationUrl.searchParams.get("nonce")!);
      return {
        code,
        state: authorizationUrl.searchParams.get("state")!,
        cookie: begin.headers.get("set-cookie")!.split(";", 1)[0],
      };
    }),
  );
  const callbacks = await Promise.all(
    attempts.map(({ code, state, cookie }) =>
      api.fetch(
        new Request(`${env.AK_PUBLIC_ORIGIN}/api/auth/callback?code=${code}&state=${encodeURIComponent(state)}`, {
          headers: { cookie },
        }),
        env,
      ),
    ),
  );
  return { callbacks, createCount: () => projectsCreated };
}

async function completeLogin(
  mode: "reuse" | "create" | "failure",
  events: string[],
  identity: { tenantId: string; subjectId: string } = { tenantId, subjectId },
  projectIds: { existing: string; created: string } = { existing: "project-existing", created: "project-created" },
): Promise<Response> {
  const keys = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = `login-key-${randomUUID()}`;
  const jwksUri = `${env.OIDC_ISSUER}/jwks`;
  let nonce = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if (request.url === `${env.OIDC_ISSUER}/.well-known/openid-configuration`) {
        return Response.json({
          issuer: env.OIDC_ISSUER,
          authorization_endpoint: `${env.OIDC_ISSUER}/oauth2/authorize`,
          token_endpoint: `${env.OIDC_ISSUER}/oauth2/token`,
          jwks_uri: jwksUri,
          id_token_signing_alg_values_supported: ["ES256"],
        });
      }
      if (request.url === jwksUri) return Response.json({ keys: [jwk] });
      if (request.url === `${env.OIDC_ISSUER}/oauth2/token`) {
        const body = new URLSearchParams(await request.text());
        if (body.get("grant_type") === "authorization_code") {
          events.push("token:authorization_code");
          const idToken = await new SignJWT({
            nonce,
            email: "bootstrap@example.test",
            "urn:realmroot:params:oauth:org": identity.tenantId,
          })
            .setProtectedHeader({ alg: "ES256", kid: jwk.kid, typ: "JWT" })
            .setIssuer(env.OIDC_ISSUER)
            .setAudience(env.OIDC_WEB_CLIENT_ID)
            .setSubject(identity.subjectId)
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(keys.privateKey);
          return Response.json({
            id_token: idToken,
            access_token: "fresh-ak-access-token",
            refresh_token: "fresh-ak-refresh-token",
            expires_in: 300,
          });
        }
        events.push("token:projects");
        expect(request.headers.get("authorization")).toBe(`Basic ${btoa(`${env.OIDC_WEB_CLIENT_ID}:${env.OIDC_WEB_CLIENT_SECRET}`)}`);
        expect(body.get("audience")).toBe(`${env.AMA_ORIGIN}/api`);
        expect(body.get("subject_token")).toBe("fresh-ak-access-token");
        expect(body.get("subject_token_type")).toBe("urn:ietf:params:oauth:token-type:access_token");
        expect(body.get("requested_token_type")).toBe("urn:ietf:params:oauth:token-type:access_token");
        expect(body.get("scope")).toBe("projects:read projects:write");
        return Response.json({ access_token: "ama-project-token" });
      }
      const url = new URL(request.url);
      if (url.origin === env.AMA_ORIGIN && url.pathname === "/api/v1/projects" && request.method === "GET") {
        events.push("projects:list");
        expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "100" });
        expect(request.headers.get("authorization")).toBe("Bearer ama-project-token");
        await expectNoEstablishedWebSession(identity.tenantId);
        if (mode === "failure") return new Response(null, { status: 503 });
        return Response.json({
          data: mode === "reuse" ? [amaProject(projectIds.existing)] : [],
          pagination: { nextCursor: null, hasMore: false },
        });
      }
      if (url.origin === env.AMA_ORIGIN && url.pathname === "/api/v1/projects" && request.method === "POST") {
        events.push("projects:create");
        await expect(request.json()).resolves.toEqual({ name: "Agent Kanban" });
        await expectNoEstablishedWebSession(identity.tenantId);
        return Response.json(amaProject(projectIds.created), { status: 201 });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    }),
  );

  const begin = await api.fetch(new Request(`${env.AK_PUBLIC_ORIGIN}/api/auth/login`), env);
  expect(begin.status).toBe(302);
  const authorizationUrl = new URL(begin.headers.get("location")!);
  nonce = authorizationUrl.searchParams.get("nonce")!;
  const state = authorizationUrl.searchParams.get("state")!;
  const loginCookie = begin.headers.get("set-cookie")!.split(";", 1)[0];
  return api.fetch(
    new Request(`${env.AK_PUBLIC_ORIGIN}/api/auth/callback?code=login-code&state=${encodeURIComponent(state)}`, {
      headers: { cookie: loginCookie },
    }),
    env,
  );
}

function amaProject(id: string) {
  return {
    id,
    name: "Agent Kanban",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:01:00.000Z",
  };
}

async function expectNoEstablishedWebSession(currentTenantId: string): Promise<void> {
  await expect(
    fixture.db.prepare("SELECT COUNT(*) AS count FROM realmroot_web_sessions WHERE tenant_id = ?").bind(currentTenantId).first(),
  ).resolves.toEqual({ count: 0 });
  await expect(
    fixture.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM realmroot_web_session_grants grants
         JOIN realmroot_web_sessions sessions ON sessions.id = grants.session_id
         WHERE sessions.tenant_id = ?`,
      )
      .bind(currentTenantId)
      .first(),
  ).resolves.toEqual({ count: 0 });
}
