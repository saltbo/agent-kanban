// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../apps/web/server/routes";
import { createTestAgent, createTestEnv, createTestWebSession, seedUser, setupMiniflare } from "./helpers/db";

const issuer = "https://tunnel.realmroot.test";
const resource = "https://ak-tunnel.example.test/api";
const issuerKeysPromise = generateKeyPair("ES256", { extractable: true });
const relayFetch = vi.fn(async () => new Response("relayed"));
const relayNamespace = {
  idFromName: vi.fn((name: string) => `relay:${name}`),
  get: vi.fn(() => ({ fetch: relayFetch })),
};
const env = {
  ...createTestEnv(),
  REALMROOT_ISSUER: issuer,
  REALMROOT_CLI_CLIENT_ID: "ak-tunnel-test",
  AK_RESOURCE: resource,
  TUNNEL_RELAY: relayNamespace,
} as any;

let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let tenantSession: Awaited<ReturnType<typeof createTestWebSession>>;
let otherTenantSession: Awaited<ReturnType<typeof createTestWebSession>>;
let machineId: string;
let ownerAgentId: string;

beforeAll(async () => {
  ({ mf, db: env.DB } = await setupMiniflare());
  await seedUser(env.DB, "tunnel-tenant", "tunnel@example.test");
  await seedUser(env.DB, "tunnel-other", "other@example.test");
  tenantSession = await createTestWebSession(env.DB, "tunnel-tenant", { subjectId: "tunnel-human" });
  otherTenantSession = await createTestWebSession(env.DB, "tunnel-other", { subjectId: "other-human" });

  const { upsertMachine } = await import("../apps/web/server/machineRepo");
  const machine = await upsertMachine(env.DB, "tunnel-tenant", {
    name: "Tunnel machine",
    os: "darwin",
    version: "1",
    device_id: "tunnel-device",
    runtimes: [],
  });
  machineId = machine.id;
  await env.DB.prepare("INSERT INTO realmroot_native_machine_bindings (tenant_id, subject_id, machine_id) VALUES (?, ?, ?)")
    .bind("tunnel-tenant", "tunnel-human", machineId)
    .run();

  const ownerAgent = await createTestAgent(env.DB, "tunnel-tenant", { username: "tunnel-owner-agent", runtime: "claude" });
  ownerAgentId = ownerAgent.id;
  const otherAgent = await createTestAgent(env.DB, "tunnel-other", { username: "tunnel-other-agent", runtime: "claude" });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO agent_sessions (id, agent_id, machine_id, status, public_key, delegation_proof)
         VALUES ('owned-tunnel-session', ?, ?, 'active', 'public', 'proof')`,
    ).bind(ownerAgent.id, machineId),
    env.DB.prepare(
      `INSERT INTO ama_agent_sessions (id, owner_id, agent_id, status, public_key, delegation_proof)
         VALUES ('foreign-tunnel-session', 'tunnel-other', ?, 'active', 'public', 'proof')`,
    ).bind(otherAgent.id),
  ]);
});

beforeEach(() => {
  relayFetch.mockClear();
  relayNamespace.idFromName.mockClear();
  relayNamespace.get.mockClear();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await mf.dispose();
});

describe("Realmroot tunnel authorization", () => {
  it("rejects a Native human daemon request without a verified machine context", async () => {
    const url = "https://ak-tunnel.example.test/api/tunnel/ws?role=daemon";
    const authority = await nativeAuthority("tunnel-human", url);
    const response = await tunnelRequest(url, authority);
    expect(response.status, await response.clone().text()).toBe(403);
    expect(relayFetch).not.toHaveBeenCalled();
  });

  it("rejects a forged machine header but relays a bound Native machine context", async () => {
    const url = "https://ak-tunnel.example.test/api/tunnel/ws?role=daemon";
    const forged = await nativeAuthority("unbound-human", url);
    const forgedResponse = await tunnelRequest(url, forged, { "x-ak-machine-id": machineId });
    expect(forgedResponse.status, await forgedResponse.clone().text()).toBe(403);

    const bound = await nativeAuthority("tunnel-human", url);
    const response = await tunnelRequest(url, bound, { "x-ak-machine-id": machineId });
    expect(response.status).toBe(200);
    expect(relayNamespace.idFromName).toHaveBeenLastCalledWith("tunnel-tenant");
    expect(relayFetch).toHaveBeenCalledOnce();
  });

  it("rejects token browser authority and requires the canonical Origin for an owned browser session", async () => {
    const ownedUrl = "https://ak-tunnel.example.test/api/tunnel/ws?role=browser&sessionId=owned-tunnel-session";
    const token = await nativeAuthority("tunnel-human", ownedUrl);
    const tokenResponse = await tunnelRequest(ownedUrl, token);
    expect(tokenResponse.status, await tokenResponse.clone().text()).toBe(403);

    const missingOrigin = await api.fetch(new Request(ownedUrl, { headers: { cookie: tenantSession.cookie } }), env);
    expect(missingOrigin.status).toBe(403);
    const wrongOrigin = await api.fetch(
      new Request(ownedUrl, { headers: { cookie: tenantSession.cookie, origin: "https://attacker.example" } }),
      env,
    );
    expect(wrongOrigin.status).toBe(403);

    const owned = await api.fetch(
      new Request(ownedUrl, { headers: { cookie: tenantSession.cookie, origin: "https://ak-tunnel.example.test" } }),
      env,
    );
    expect(owned.status).toBe(200);
    expect(relayNamespace.idFromName).toHaveBeenLastCalledWith("tunnel-tenant");

    const crossTenant = await api.fetch(
      new Request("https://ak-tunnel.example.test/api/tunnel/ws?role=browser&sessionId=foreign-tunnel-session", {
        headers: { cookie: tenantSession.cookie, origin: "https://ak-tunnel.example.test" },
      }),
      env,
    );
    expect(crossTenant.status).toBe(404);
    expect(relayFetch).toHaveBeenCalledOnce();

    const foreignOwned = await api.fetch(
      new Request("https://ak-tunnel.example.test/api/tunnel/ws?role=browser&sessionId=foreign-tunnel-session", {
        headers: { cookie: otherTenantSession.cookie, origin: "https://ak-tunnel.example.test" },
      }),
      env,
    );
    expect(foreignOwned.status).toBe(200);
  });

  it("requires the canonical Origin before resolving an AMA browser socket", async () => {
    const url = "https://ak-tunnel.example.test/api/ama/sessions/session-1/socket";
    const baseHeaders = { cookie: tenantSession.cookie, upgrade: "websocket" };
    const missing = await api.fetch(new Request(url, { headers: baseHeaders }), env);
    expect(missing.status).toBe(403);
    const wrong = await api.fetch(new Request(url, { headers: { ...baseHeaders, origin: "https://attacker.example" } }), env);
    expect(wrong.status).toBe(403);
    const correct = await api.fetch(new Request(url, { headers: { ...baseHeaders, origin: "https://ak-tunnel.example.test" } }), env);
    expect(correct.status).toBe(404);
    await expect(correct.json()).resolves.toMatchObject({ error: { message: "AMA project is not configured" } });
  });

  it("accepts Native human authority before resolving the AMA project", async () => {
    const url = "https://ak-tunnel.example.test/api/ama/sessions/session-1/socket";
    const websocketHeaders = { origin: "https://ak-tunnel.example.test", upgrade: "websocket" };
    const bearer = await bearerAccessToken("tunnel-human");
    const bearerResponse = await api.fetch(new Request(url, { headers: { ...websocketHeaders, authorization: `Bearer ${bearer}` } }), env);
    expect(bearerResponse.status, await bearerResponse.clone().text()).toBe(404);
    await expect(bearerResponse.json()).resolves.toMatchObject({
      error: { message: "AMA project is not configured" },
    });

    const dpop = await nativeAuthority("tunnel-human", url);
    const dpopResponse = await tunnelRequest(url, dpop, websocketHeaders);
    expect(dpopResponse.status, await dpopResponse.clone().text()).toBe(404);
    await expect(dpopResponse.json()).resolves.toMatchObject({
      error: { message: "AMA project is not configured" },
    });
  });

  it("default-denies the removed authenticated Agent GPG-key route", async () => {
    const response = await api.fetch(
      new Request(`https://ak-tunnel.example.test/api/agents/${ownerAgentId}/gpg-key`, {
        headers: { cookie: tenantSession.cookie },
      }),
      env,
    );
    expect(response.status).toBe(403);
  });

  it("rejects an unknown tunnel role", async () => {
    const response = await api.fetch(
      new Request("https://ak-tunnel.example.test/api/tunnel/ws?role=controller", { headers: { cookie: tenantSession.cookie } }),
      env,
    );
    expect(response.status).toBe(400);
    expect(relayFetch).not.toHaveBeenCalled();
  });
});

async function tunnelRequest(url: string, authority: { accessToken: string; proof: string }, extraHeaders: Record<string, string> = {}) {
  return api.fetch(
    new Request(url, {
      headers: {
        authorization: `DPoP ${authority.accessToken}`,
        dpop: authority.proof,
        ...extraHeaders,
      },
    }),
    env,
  );
}

async function nativeAuthority(subjectId: string, url: string) {
  const { issuerKeys, issuerJwk } = await issuerAuthority();
  const dpopKeys = await generateKeyPair("ES256", { extractable: true });
  const dpopJwk = await exportJWK(dpopKeys.publicKey);
  const accessToken = await new SignJWT({
    scope: "ak:read",
    client_id: "ak-tunnel-test",
    cnf: { jkt: await calculateJwkThumbprint(dpopJwk) },
    "urn:realmroot:params:oauth:org": "tunnel-tenant",
  })
    .setProtectedHeader({ alg: "ES256", kid: issuerJwk.kid, typ: "at+jwt" })
    .setIssuer(issuer)
    .setAudience(resource)
    .setSubject(subjectId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(issuerKeys.privateKey);
  const proof = await new SignJWT({
    htu: new URL(url).origin + new URL(url).pathname,
    htm: "GET",
    ath: createHash("sha256").update(accessToken).digest("base64url"),
  })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: dpopJwk })
    .setJti(randomUUID())
    .setIssuedAt()
    .sign(dpopKeys.privateKey);
  return { accessToken, proof };
}

async function bearerAccessToken(subjectId: string): Promise<string> {
  const { issuerKeys, issuerJwk } = await issuerAuthority();
  return new SignJWT({
    scope: "ak:read",
    client_id: "ak-tunnel-test",
    "urn:realmroot:params:oauth:org": "tunnel-tenant",
  })
    .setProtectedHeader({ alg: "ES256", kid: issuerJwk.kid, typ: "at+jwt" })
    .setIssuer(issuer)
    .setAudience(resource)
    .setSubject(subjectId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(issuerKeys.privateKey);
}

async function issuerAuthority() {
  const issuerKeys = await issuerKeysPromise;
  const issuerJwk = await exportJWK(issuerKeys.publicKey);
  issuerJwk.kid = "tunnel-issuer-key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      if (requestUrl === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          id_token_signing_alg_values_supported: ["ES256"],
        });
      }
      if (requestUrl === `${issuer}/jwks`) return Response.json({ keys: [issuerJwk] });
      throw new Error(`Unexpected request: ${requestUrl}`);
    }),
  );
  return { issuerKeys, issuerJwk };
}
