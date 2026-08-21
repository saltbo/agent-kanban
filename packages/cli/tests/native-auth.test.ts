// @vitest-environment node

import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keychain = vi.hoisted(() => new Map<string, string>());
const configMocks = vi.hoisted(() => ({
  saveEnvironment: vi.fn(),
  getCredentials: vi.fn(() => ({
    apiUrl: "https://ak.example.test",
    issuer: "https://id.realmroot.dev/api/auth",
    resource: "https://ak.example.test/api",
    clientId: "ak-cli",
  })),
}));

vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    constructor(
      private readonly service: string,
      private readonly account: string,
    ) {}

    getPassword() {
      return keychain.get(`${this.service}:${this.account}`) ?? null;
    }

    setPassword(value: string) {
      keychain.set(`${this.service}:${this.account}`, value);
    }

    deletePassword() {
      keychain.delete(`${this.service}:${this.account}`);
    }
  },
}));
vi.mock("../src/config.js", () => configMocks);

const { clearRealmrootAuthority, loginWithRealmroot, realmrootRequestHeaders } = await import("../src/nativeAuth.js");

beforeEach(() => {
  keychain.clear();
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Realmroot native CLI authority", () => {
  it("uses Device Authorization and stores the DPoP authority only in the OS keychain", async () => {
    const issuer = "https://id.realmroot.dev/api/auth";
    const deviceEndpoint = `${issuer}/oauth2/device/authorize`;
    const tokenEndpoint = `${issuer}/oauth2/token`;
    const { privateKey } = await generateKeyPair("ES256");
    const accessToken = await new SignJWT({ scope: "task:claim" }).setProtectedHeader({ alg: "ES256" }).setExpirationTime("10m").sign(privateKey);
    const requests: Request[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      queueMicrotask(callback);
      return 1;
    }) as typeof setTimeout);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url === "https://ak.example.test/.well-known/oauth-protected-resource/api") {
          return Response.json({ resource: "https://ak.example.test/api", authorization_servers: [issuer] });
        }
        if (request.url === `${issuer}/.well-known/openid-configuration`) {
          return Response.json({ issuer, token_endpoint: tokenEndpoint, device_authorization_endpoint: deviceEndpoint });
        }
        if (request.url === deviceEndpoint) {
          return Response.json({
            device_code: "device-code",
            user_code: "USER-CODE",
            verification_uri: "https://id.realmroot.dev/activate",
            expires_in: 600,
            interval: 1,
          });
        }
        if (request.url === tokenEndpoint) {
          return Response.json({ access_token: accessToken, refresh_token: "refresh-token", token_type: "DPoP", expires_in: 600 });
        }
        throw new Error(`Unexpected request: ${request.url}`);
      }),
    );

    await loginWithRealmroot({ apiUrl: "https://ak.example.test/", clientId: "ak-cli", issuer });

    expect(configMocks.saveEnvironment).toHaveBeenCalledWith({
      apiUrl: "https://ak.example.test",
      issuer,
      resource: "https://ak.example.test/api",
      clientId: "ak-cli",
    });
    expect(keychain.has("agent-kanban.realmroot:ak.example.test")).toBe(true);
    const deviceForm = new URLSearchParams(await requests[2].clone().text());
    expect(Object.fromEntries(deviceForm)).toEqual({
      client_id: "ak-cli",
      scope:
        "openid profile email offline_access ak:read ak:write task:claim task:assign task:release task:review task:complete task:reject task:cancel task:log task:message agent:usage",
      resource: "https://ak.example.test/api",
    });
    expect(requests[2].headers.get("dpop")).toBeTruthy();
    const tokenForm = new URLSearchParams(await requests[3].clone().text());
    expect(Object.fromEntries(tokenForm)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "device-code",
      client_id: "ak-cli",
      resource: "https://ak.example.test/api",
    });

    const headers = await realmrootRequestHeaders("post", "https://ak.example.test/api/tasks/task-1?debug=secret");
    expect(headers.authorization).toBe(`DPoP ${accessToken}`);
    const proofHeader = decodeProtectedHeader(headers.dpop);
    expect(proofHeader).toMatchObject({ typ: "dpop+jwt", alg: "ES256" });
    expect(proofHeader.jwk).not.toHaveProperty("d");
    const proofKey = await importJWK(proofHeader.jwk!, "ES256");
    const { payload } = await jwtVerify(headers.dpop, proofKey, { typ: "dpop+jwt", algorithms: ["ES256"] });
    expect(payload).toMatchObject({ htu: "https://ak.example.test/api/tasks/task-1", htm: "POST" });
    expect(payload.ath).toEqual(expect.any(String));

    clearRealmrootAuthority("https://ak.example.test");
    expect(keychain.size).toBe(0);
  });

  it("rejects a Resource Server that does not advertise the selected issuer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ resource: "https://ak.example.test/api", authorization_servers: ["https://issuer.example.test"] })),
    );

    await expect(
      loginWithRealmroot({ apiUrl: "https://ak.example.test", clientId: "ak-cli", issuer: "https://id.realmroot.dev/api/auth" }),
    ).rejects.toThrow("does not advertise the selected Realmroot issuer");
    expect(keychain.size).toBe(0);
    expect(configMocks.saveEnvironment).not.toHaveBeenCalled();
  });

  it("stores and uses a Device Flow Bearer authority without sending a DPoP proof", async () => {
    const issuer = "https://id.realmroot.dev/api/auth";
    const deviceEndpoint = `${issuer}/oauth2/device/authorize`;
    const tokenEndpoint = `${issuer}/oauth2/token`;
    const accessToken = await accessTokenExpiringIn(600);
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      queueMicrotask(callback);
      return 1;
    }) as typeof setTimeout);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://ak.example.test/.well-known/oauth-protected-resource/api") {
          return Response.json({ resource: "https://ak.example.test/api", authorization_servers: [issuer] });
        }
        if (url === `${issuer}/.well-known/openid-configuration`) {
          return Response.json({ issuer, token_endpoint: tokenEndpoint, device_authorization_endpoint: deviceEndpoint });
        }
        if (url === deviceEndpoint) {
          return Response.json({
            device_code: "device-code",
            user_code: "USER-CODE",
            verification_uri: "https://id.realmroot.dev/activate",
            expires_in: 600,
            interval: 1,
          });
        }
        if (url === tokenEndpoint) {
          return Response.json({ access_token: accessToken, refresh_token: "refresh-token", token_type: "Bearer", expires_in: 600 });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    await loginWithRealmroot({ apiUrl: "https://ak.example.test", clientId: "ak-cli", issuer });

    const stored = JSON.parse(keychain.get("agent-kanban.realmroot:ak.example.test")!) as Record<string, unknown>;
    expect(stored).toMatchObject({ accessToken, refreshToken: "refresh-token", tokenType: "Bearer" });
    await expect(realmrootRequestHeaders("GET", "https://ak.example.test/api/tasks")).resolves.toEqual({
      authorization: `Bearer ${accessToken}`,
    });
  });

  it.each([
    ["DPoP", "Bearer"],
    ["Bearer", "DPoP"],
  ] as const)("honors a refresh token_type switch from %s to %s", async (initialType, refreshedType) => {
    const issuer = "https://id.realmroot.dev/api/auth";
    const tokenEndpoint = `${issuer}/oauth2/token`;
    await seedExpiredAuthority(initialType);
    const refreshedAccessToken = await accessTokenExpiringIn(600);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${issuer}/.well-known/openid-configuration`) return Response.json({ issuer, token_endpoint: tokenEndpoint });
        if (url === tokenEndpoint) {
          return Response.json({ access_token: refreshedAccessToken, refresh_token: "refresh-2", token_type: refreshedType });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const headers = await realmrootRequestHeaders("GET", "https://ak.example.test/api/tasks");

    expect(headers.authorization).toBe(`${refreshedType} ${refreshedAccessToken}`);
    if (refreshedType === "Bearer") expect(headers).not.toHaveProperty("dpop");
    else expect(headers.dpop).toEqual(expect.any(String));
    const stored = JSON.parse(keychain.get("agent-kanban.realmroot:ak.example.test")!) as Record<string, unknown>;
    expect(stored).toMatchObject({ accessToken: refreshedAccessToken, refreshToken: "refresh-2", tokenType: refreshedType });
  });

  it("rejects an invalid token_type returned during refresh without replacing the stored authority", async () => {
    const issuer = "https://id.realmroot.dev/api/auth";
    const tokenEndpoint = `${issuer}/oauth2/token`;
    await seedExpiredAuthority("Bearer");
    const original = keychain.get("agent-kanban.realmroot:ak.example.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${issuer}/.well-known/openid-configuration`) return Response.json({ issuer, token_endpoint: tokenEndpoint });
        if (url === tokenEndpoint) {
          return Response.json({ access_token: await accessTokenExpiringIn(600), refresh_token: "must-not-store", token_type: "MAC" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    await expect(realmrootRequestHeaders("GET", "https://ak.example.test/api/tasks")).rejects.toThrow("Realmroot returned an invalid token response");
    expect(keychain.get("agent-kanban.realmroot:ak.example.test")).toBe(original);
  });

  it("coalesces concurrent refresh while generating a distinct DPoP proof per request", async () => {
    const issuer = "https://id.realmroot.dev/api/auth";
    const tokenEndpoint = `${issuer}/oauth2/token`;
    await seedExpiredAuthority();
    const refreshedAccessToken = await accessTokenExpiringIn(600);
    let releaseToken: (() => void) | undefined;
    const tokenGate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    let discoveryCalls = 0;
    let tokenCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${issuer}/.well-known/openid-configuration`) {
          discoveryCalls += 1;
          return Response.json({ issuer, token_endpoint: tokenEndpoint });
        }
        if (url === tokenEndpoint) {
          tokenCalls += 1;
          await tokenGate;
          return Response.json({ access_token: refreshedAccessToken, refresh_token: "refresh-2", token_type: "DPoP" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const pending = Promise.all(
      Array.from({ length: 6 }, (_, index) => realmrootRequestHeaders("GET", `https://ak.example.test/api/tasks/task-${index}`)),
    );
    await vi.waitFor(() => expect(tokenCalls).toBe(1));
    releaseToken?.();
    const headers = await pending;

    expect(discoveryCalls).toBe(1);
    expect(tokenCalls).toBe(1);
    expect(new Set(headers.map(({ dpop }) => decodeJwt(dpop).jti)).size).toBe(headers.length);
    expect(headers.every(({ authorization }) => authorization === `DPoP ${refreshedAccessToken}`)).toBe(true);
  });

  it("clears a failed refresh flight so a later request can retry", async () => {
    const issuer = "https://id.realmroot.dev/api/auth";
    const tokenEndpoint = `${issuer}/oauth2/token`;
    await seedExpiredAuthority();
    const refreshedAccessToken = await accessTokenExpiringIn(600);
    let tokenCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${issuer}/.well-known/openid-configuration`) {
          return Response.json({ issuer, token_endpoint: tokenEndpoint });
        }
        if (url === tokenEndpoint) {
          tokenCalls += 1;
          if (tokenCalls === 1) return Response.json({ error: "invalid_grant", secret: "must-not-leak" }, { status: 401 });
          return Response.json({ access_token: refreshedAccessToken, token_type: "DPoP" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const failures = await Promise.allSettled([
      realmrootRequestHeaders("GET", "https://ak.example.test/api/tasks/a"),
      realmrootRequestHeaders("GET", "https://ak.example.test/api/tasks/b"),
    ]);
    expect(failures.every(({ status }) => status === "rejected")).toBe(true);
    expect(tokenCalls).toBe(1);

    await expect(realmrootRequestHeaders("GET", "https://ak.example.test/api/tasks/c")).resolves.toMatchObject({
      authorization: `DPoP ${refreshedAccessToken}`,
      dpop: expect.any(String),
    });
    expect(tokenCalls).toBe(2);
  });
});

async function seedExpiredAuthority(tokenType: "Bearer" | "DPoP" = "DPoP"): Promise<void> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  keychain.set(
    "agent-kanban.realmroot:ak.example.test",
    JSON.stringify({
      accessToken: await accessTokenExpiringIn(-60),
      refreshToken: "refresh-1",
      expiresAt: Date.now() - 60_000,
      tokenType,
      privateJwk: await exportJWK(privateKey),
      publicJwk: await exportJWK(publicKey),
    }),
  );
}

async function accessTokenExpiringIn(seconds: number): Promise<string> {
  const { privateKey } = await generateKeyPair("ES256");
  return new SignJWT({ scope: "ak:read" })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + seconds)
    .sign(privateKey);
}
