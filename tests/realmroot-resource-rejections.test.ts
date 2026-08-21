// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "../apps/web/node_modules/hono/dist/index.js";
import { authMiddleware } from "../apps/web/server/auth";
import type { Env } from "../apps/web/server/types";
import { createTestEnv, setupMiniflare } from "./helpers/db";

const issuer = "https://resource-rejections.realmroot.test";
const resource = "https://ak-rejections.example.test/api";
const target = `${resource}/tasks/task-1/claim`;
const issuerKeysPromise = generateKeyPair("ES256", { extractable: true });
const attackerKeysPromise = generateKeyPair("ES256", { extractable: true });

let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let db: D1Database;
let issuerPublicJwk: JsonWebKey;

beforeEach(async () => {
  ({ mf, db } = await setupMiniflare());
  const issuerKeys = await issuerKeysPromise;
  issuerPublicJwk = await exportJWK(issuerKeys.publicKey);
  issuerPublicJwk.kid = "resource-rejections-key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          id_token_signing_alg_values_supported: ["ES256"],
        });
      }
      if (url === `${issuer}/jwks`) return Response.json({ keys: [issuerPublicJwk] });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await mf.dispose();
});

function env(): Env {
  return {
    ...createTestEnv(),
    DB: db,
    REALMROOT_ISSUER: issuer,
    REALMROOT_CLI_CLIENT_ID: "ak-native-test",
    AK_RESOURCE: resource,
  } as never;
}

function protectedApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.get("/api/boards", (c) =>
    c.json({
      tenantId: c.get("ownerId"),
      subjectId: c.get("principal").subjectId,
      identityType: c.get("identityType"),
    }),
  );
  app.post("/api/tasks/:id/claim", (c) => c.json({ accepted: true }));
  return app;
}

describe("Realmroot Bearer access tokens", () => {
  it("accepts an unbound Native human token and establishes its exact tenant membership", async () => {
    const accessToken = await createBearerAuthority();

    const response = await protectedApp().fetch(new Request(`${resource}/boards`, { headers: { authorization: `Bearer ${accessToken}` } }), env());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tenantId: "tenant-a", subjectId: "controller", identityType: "user" });
    await expect(
      db
        .prepare("SELECT tenant_id, subject_id, role FROM realmroot_tenant_members WHERE tenant_id = ? AND subject_id = ?")
        .bind("tenant-a", "controller")
        .first(),
    ).resolves.toEqual({ tenant_id: "tenant-a", subject_id: "controller", role: "member" });
  });

  it("rejects Bearer tokens with sender-constraint claims or DPoP proof headers", async () => {
    const senderConstrained = await createBearerAuthority({ cnf: { jkt: "unexpected-binding" } });
    const boundResponse = await protectedApp().fetch(
      new Request(`${resource}/boards`, { headers: { authorization: `Bearer ${senderConstrained}` } }),
      env(),
    );
    expect(boundResponse.status).toBe(401);

    const unbound = await createBearerAuthority();
    const proofResponse = await protectedApp().fetch(
      new Request(`${resource}/boards`, { headers: { authorization: `Bearer ${unbound}`, dpop: "unexpected-proof" } }),
      env(),
    );
    expect(proofResponse.status).toBe(401);
  });

  it("rejects an unregistered Native client and insufficient Bearer scope", async () => {
    const invalidClient = await createBearerAuthority({ clientId: "unregistered-native-client" });
    const clientResponse = await protectedApp().fetch(
      new Request(`${resource}/boards`, { headers: { authorization: `Bearer ${invalidClient}` } }),
      env(),
    );
    expect(clientResponse.status).toBe(401);

    const insufficientScope = await createBearerAuthority({ scope: "ak:write" });
    const scopeResponse = await protectedApp().fetch(
      new Request(`${resource}/boards`, { headers: { authorization: `Bearer ${insufficientScope}` } }),
      env(),
    );
    expect(scopeResponse.status).toBe(403);
    await expect(scopeResponse.json()).resolves.toMatchObject({ error: { message: "Missing scope: ak:read" } });
  });

  it("does not merge the same Native subject across Realmroot organization tenants", async () => {
    const tenantA = await createBearerAuthority({ organization: "tenant-a" });
    const tenantB = await createBearerAuthority({ organization: "tenant-b" });

    const responses = await Promise.all(
      [tenantA, tenantB].map((accessToken) =>
        protectedApp().fetch(new Request(`${resource}/boards`, { headers: { authorization: `Bearer ${accessToken}` } }), env()),
      ),
    );

    await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual([
      { tenantId: "tenant-a", subjectId: "controller", identityType: "user" },
      { tenantId: "tenant-b", subjectId: "controller", identityType: "user" },
    ]);
    const memberships = await db
      .prepare("SELECT tenant_id, subject_id FROM realmroot_tenant_members WHERE subject_id = ? ORDER BY tenant_id")
      .bind("controller")
      .all();
    expect(memberships.results).toEqual([
      { tenant_id: "tenant-a", subject_id: "controller" },
      { tenant_id: "tenant-b", subject_id: "controller" },
    ]);
  });
});

describe("Realmroot DPoP freshness and replay", () => {
  it("accepts a fresh Native human proof once and rejects the identical proof as replayed", async () => {
    const now = Math.floor(Date.now() / 1000);
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    const authority = await createHumanDpopAuthority(now - 1);
    const request = () =>
      new Request(`${resource}/boards`, {
        headers: { authorization: `DPoP ${authority.accessToken}`, dpop: authority.proof },
      });

    const accepted = await protectedApp().fetch(request(), env());
    expect(accepted.status).toBe(200);

    const replay = await protectedApp().fetch(request(), env());
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toMatchObject({ error: { message: "Replayed DPoP proof" } });
  });

  it("rejects a proof exactly at the 300-second lower freshness boundary", async () => {
    const now = Math.floor(Date.now() / 1000);
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    const authority = await createHumanDpopAuthority(now - 300);

    const response = await protectedApp().fetch(
      new Request(`${resource}/boards`, {
        headers: { authorization: `DPoP ${authority.accessToken}`, dpop: authority.proof },
      }),
      env(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { message: "Stale DPoP proof" } });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM realmroot_dpop_replays").first()).resolves.toEqual({ count: 0 });
  });
});

describe("Realmroot access-token rejection matrix", () => {
  it.each([
    ["issuer", { tokenIssuer: "https://wrong-issuer.example" }],
    ["audience", { audience: "https://wrong-resource.example/api" }],
    ["audience array", { audience: [resource, "https://other-resource.example/api"] }],
    ["expiry", { expirationTime: Math.floor(Date.now() / 1000) - 60 }],
    ["signature", { useAttackerKey: true }],
    ["client", { clientId: "unregistered-native-client" }],
  ] as const)("rejects a token with an invalid %s", async (_case, overrides) => {
    const authority = await createAuthority(overrides);
    const response = await protectedApp().fetch(
      new Request(target, {
        method: "POST",
        headers: { authorization: `DPoP ${authority.accessToken}`, dpop: authority.proof },
      }),
      env(),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a token whose algorithm is outside Realmroot metadata", async () => {
    const dpopKeys = await generateKeyPair("ES256", { extractable: true });
    const dpopJwk = await exportJWK(dpopKeys.publicKey);
    const accessToken = await new SignJWT({
      scope: "task:claim",
      client_id: "realmroot-cli",
      cnf: { jkt: await calculateJwkThumbprint(dpopJwk) },
      act: { sub: "rr-agent-1", sub_profile: "ai_agent" },
      "urn:realmroot:params:oauth:org": "tenant-a",
    })
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setIssuer(issuer)
      .setAudience(resource)
      .setSubject("controller")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("not-an-accepted-realmroot-signing-key"));
    const proof = await signProof(accessToken, dpopKeys, dpopJwk, {});

    const response = await protectedApp().fetch(
      new Request(target, { method: "POST", headers: { authorization: `DPoP ${accessToken}`, dpop: proof } }),
      env(),
    );
    expect(response.status).toBe(401);
  });

  it("requires a proof for a DPoP access token and rejects it as Bearer", async () => {
    const authority = await createAuthority({});
    const missingProof = await protectedApp().fetch(
      new Request(target, { method: "POST", headers: { authorization: `DPoP ${authority.accessToken}` } }),
      env(),
    );
    expect(missingProof.status).toBe(401);

    const bearerFallback = await protectedApp().fetch(
      new Request(target, {
        method: "POST",
        headers: { authorization: `Bearer ${authority.accessToken}`, dpop: authority.proof },
      }),
      env(),
    );
    expect(bearerFallback.status).toBe(401);
  });
});

describe("Realmroot DPoP rejection matrix", () => {
  it.each([
    ["htu", { proofHtu: `${resource}/tasks/other/claim` }],
    ["htm", { proofHtm: "GET" }],
    ["iat", { proofIat: Math.floor(Date.now() / 1000) - 600 }],
    ["ath", { proofAth: "not-the-access-token-hash" }],
    ["jkt", { mismatchJkt: true }],
    ["missing jti", { omitProofJti: true }],
    ["empty jti", { proofJti: "" }],
    ["oversized jti", { proofJti: "x".repeat(161) }],
  ] as const)("rejects a proof with an invalid %s", async (_case, overrides) => {
    const authority = await createAuthority(overrides);
    const response = await protectedApp().fetch(
      new Request(target, {
        method: "POST",
        headers: { authorization: `DPoP ${authority.accessToken}`, dpop: authority.proof },
      }),
      env(),
    );
    expect(response.status).toBe(401);
  });
});

type BearerOverrides = {
  clientId?: string;
  scope?: string;
  organization?: string;
  cnf?: { jkt: string };
};

async function createBearerAuthority(overrides: BearerOverrides = {}) {
  const issuerKeys = await issuerKeysPromise;
  return new SignJWT({
    scope: overrides.scope ?? "ak:read",
    client_id: overrides.clientId ?? "ak-native-test",
    ...(overrides.organization === undefined
      ? { "urn:realmroot:params:oauth:org": "tenant-a" }
      : { "urn:realmroot:params:oauth:org": overrides.organization }),
    ...(overrides.cnf ? { cnf: overrides.cnf } : {}),
  })
    .setProtectedHeader({ alg: "ES256", kid: issuerPublicJwk.kid, typ: "at+jwt" })
    .setIssuer(issuer)
    .setAudience(resource)
    .setSubject("controller")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(issuerKeys.privateKey);
}

async function createHumanDpopAuthority(proofIat: number) {
  const issuerKeys = await issuerKeysPromise;
  const dpopKeys = await generateKeyPair("ES256", { extractable: true });
  const dpopJwk = await exportJWK(dpopKeys.publicKey);
  const accessToken = await new SignJWT({
    scope: "ak:read",
    client_id: "ak-native-test",
    cnf: { jkt: await calculateJwkThumbprint(dpopJwk) },
    "urn:realmroot:params:oauth:org": "tenant-a",
  })
    .setProtectedHeader({ alg: "ES256", kid: issuerPublicJwk.kid, typ: "at+jwt" })
    .setIssuer(issuer)
    .setAudience(resource)
    .setSubject("controller")
    .setIssuedAt(proofIat)
    .setExpirationTime(proofIat + 600)
    .sign(issuerKeys.privateKey);
  const proof = await new SignJWT({
    htu: `${resource}/boards`,
    htm: "GET",
    ath: createHash("sha256").update(accessToken).digest("base64url"),
  })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: dpopJwk })
    .setJti("freshness-boundary-proof")
    .setIssuedAt(proofIat)
    .sign(dpopKeys.privateKey);
  return { accessToken, proof };
}

type AuthorityOverrides = {
  tokenIssuer?: string;
  audience?: string | string[];
  expirationTime?: number;
  useAttackerKey?: boolean;
  clientId?: string;
  proofHtu?: string;
  proofHtm?: string;
  proofIat?: number;
  proofAth?: string;
  proofJti?: string;
  omitProofJti?: boolean;
  mismatchJkt?: boolean;
};

async function createAuthority(overrides: AuthorityOverrides) {
  const issuerKeys = overrides.useAttackerKey ? await attackerKeysPromise : await issuerKeysPromise;
  const dpopKeys = await generateKeyPair("ES256", { extractable: true });
  const dpopJwk = await exportJWK(dpopKeys.publicKey);
  const otherDpopKeys = overrides.mismatchJkt ? await generateKeyPair("ES256", { extractable: true }) : null;
  const confirmationJwk = otherDpopKeys ? await exportJWK(otherDpopKeys.publicKey) : dpopJwk;
  const accessToken = await new SignJWT({
    scope: "task:claim",
    client_id: overrides.clientId ?? "realmroot-cli",
    cnf: { jkt: await calculateJwkThumbprint(confirmationJwk) },
    act: { sub: "rr-agent-1", sub_profile: "ai_agent" },
    "urn:realmroot:params:oauth:org": "tenant-a",
  })
    .setProtectedHeader({ alg: "ES256", kid: issuerPublicJwk.kid, typ: "at+jwt" })
    .setIssuer(overrides.tokenIssuer ?? issuer)
    .setAudience(overrides.audience ?? resource)
    .setSubject("controller")
    .setIssuedAt()
    .setExpirationTime(overrides.expirationTime ?? "5m")
    .sign(issuerKeys.privateKey);
  const proof = await signProof(accessToken, dpopKeys, dpopJwk, overrides);
  return { accessToken, proof };
}

async function signProof(
  accessToken: string,
  dpopKeys: Awaited<ReturnType<typeof generateKeyPair>>,
  dpopJwk: JsonWebKey,
  overrides: AuthorityOverrides,
) {
  const proof = new SignJWT({
    htu: overrides.proofHtu ?? target,
    htm: overrides.proofHtm ?? "POST",
    ath: overrides.proofAth ?? createHash("sha256").update(accessToken).digest("base64url"),
    ...(overrides.proofIat === undefined ? {} : { iat: overrides.proofIat }),
  }).setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: dpopJwk });
  if (!overrides.omitProofJti) proof.setJti(overrides.proofJti ?? randomUUID());
  if (overrides.proofIat === undefined) proof.setIssuedAt();
  return proof.sign(dpopKeys.privateKey);
}
