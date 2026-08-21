// @vitest-environment node

import { createHash } from "node:crypto";
import { decodeProtectedHeader, exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAmaMachineAuthorizer, invalidateAmaMachineToken } from "./realmrootMachineAuth";

const issuer = "https://id.realmroot.dev/api/auth";
const tokenEndpoint = `${issuer}/oauth2/token`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AMA Realmroot machine authorizer", () => {
  it("uses client_credentials, caches the token, and signs each AMA request with DPoP", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    const accessToken = await new SignJWT({ scope: "projects:read" }).setProtectedHeader({ alg: "ES256" }).setExpirationTime("10m").sign(privateKey);
    const env = {
      REALMROOT_ISSUER: issuer,
      AMA_MACHINE_CLIENT_ID: "ak-machine",
      AMA_MACHINE_CLIENT_SECRET: "machine-secret",
      AMA_RESOURCE: "https://ama.example.test/",
      AMA_MACHINE_SCOPES: "projects:read sessions:write",
      AMA_DPOP_PRIVATE_JWK: JSON.stringify(privateJwk),
    } as never;
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith("/.well-known/openid-configuration")) {
          return Response.json({ issuer, token_endpoint: tokenEndpoint });
        }
        if (request.url === tokenEndpoint) {
          return Response.json({ access_token: accessToken, token_type: "DPoP", expires_in: 600 });
        }
        throw new Error(`Unexpected request: ${request.url}`);
      }),
    );

    const authorize = createAmaMachineAuthorizer(env);
    const first = await authorize("https://ama.example.test/api/v1/projects?cursor=secret", "get");
    const second = await authorize("https://ama.example.test/api/v1/sessions", "POST");

    expect(first.accessToken).toBe(accessToken);
    expect(second.accessToken).toBe(accessToken);
    expect(requests).toHaveLength(2);
    const tokenRequest = requests[1];
    expect(tokenRequest.headers.get("authorization")).toBe(`Basic ${btoa("ak-machine:machine-secret")}`);
    expect(tokenRequest.headers.get("dpop")).toBeTruthy();
    const form = new URLSearchParams(await tokenRequest.text());
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "client_credentials",
      resource: "https://ama.example.test",
      scope: "projects:read sessions:write",
    });

    const header = decodeProtectedHeader(first.dpopProof);
    expect(header).toMatchObject({ typ: "dpop+jwt", alg: "ES256" });
    expect(header.jwk).not.toHaveProperty("d");
    const key = await importJWK(header.jwk!, "ES256");
    const { payload } = await jwtVerify(first.dpopProof, key, { typ: "dpop+jwt", algorithms: ["ES256"] });
    expect(payload).toMatchObject({
      htu: "https://ama.example.test/api/v1/projects",
      htm: "GET",
      ath: createHash("sha256").update(accessToken).digest("base64url"),
    });
    expect(payload.jti).toEqual(expect.any(String));

    invalidateAmaMachineToken(env);
    await authorize("https://ama.example.test/api/v1/projects", "GET");
    expect(requests).toHaveLength(4);
  });

  it("rejects non-DPoP machine tokens", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    const accessToken = await new SignJWT({}).setProtectedHeader({ alg: "ES256" }).setExpirationTime("10m").sign(privateKey);
    const env = {
      REALMROOT_ISSUER: issuer,
      AMA_MACHINE_CLIENT_ID: "ak-machine-bearer-test",
      AMA_MACHINE_CLIENT_SECRET: "machine-secret",
      AMA_RESOURCE: "https://ama.example.test",
      AMA_MACHINE_SCOPES: "projects:read sessions:write",
      AMA_DPOP_PRIVATE_JWK: JSON.stringify(privateJwk),
    } as never;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ issuer, token_endpoint: tokenEndpoint }))
        .mockResolvedValueOnce(Response.json({ access_token: accessToken, token_type: "Bearer" })),
    );

    await expect(createAmaMachineAuthorizer(env)("https://ama.example.test/api/v1/projects", "GET")).rejects.toThrow("not DPoP-bound");
  });
});
