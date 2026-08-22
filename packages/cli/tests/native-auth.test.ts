// @vitest-environment node

import { createHash } from "node:crypto";
import { createServer, get as httpGet } from "node:http";
import { calculateJwkThumbprint, decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "../../../apps/web/node_modules/hono/dist/index.js";
import { authMiddleware } from "../../../apps/web/server/auth.js";
import type { Env } from "../../../apps/web/server/types.js";
import { createTestEnv, setupMiniflare } from "../../../tests/helpers/db.js";

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
if (process.platform === "win32") vi.setConfig({ testTimeout: 15_000 });

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
  it.each(["Bearer", "DPoP"] as const)("completes loopback Authorization Code + PKCE and stores a %s authority", async (tokenType) => {
    const issuer = "https://id.realmroot.dev/api/auth";
    const authorizationEndpoint = `${issuer}/oauth2/authorize`;
    const tokenEndpoint = `${issuer}/oauth2/token`;
    const { privateKey: issuerPrivateKey, publicKey: issuerPublicKey } = await generateKeyPair("ES256", { extractable: true });
    const issuerPublicJwk = await exportJWK(issuerPublicKey);
    issuerPublicJwk.kid = `native-login-${tokenType.toLowerCase()}`;
    const tokenRequests: Request[] = [];
    installLoginFetch({
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      tokenType,
      tokenRequests,
      issuerPrivateKey,
      issuerPublicJwk,
    });

    const login = loginWithRealmroot({ apiUrl: "https://ak.example.test/", clientId: "ak-cli", issuer });
    const authorization = await waitForAuthorizationUrl();
    expect(`${authorization.origin}${authorization.pathname}`).toBe(authorizationEndpoint);
    expect(authorization.searchParams.get("response_type")).toBe("code");
    expect(authorization.searchParams.get("client_id")).toBe("ak-cli");
    expect(authorization.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:49173/oauth/callback");
    expect(authorization.searchParams.get("resource")).toBe("https://ak.example.test/api");
    expect(authorization.searchParams.get("scope")).toBe(
      "openid profile email offline_access ak:read ak:write task:claim task:assign task:release task:review task:complete task:reject task:cancel task:log task:message agent:usage",
    );
    expect(authorization.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const redirectUri = authorization.searchParams.get("redirect_uri")!;
    await waitForLoopbackServer(redirectUri);
    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set("code", "one-time-code");
    callbackUrl.searchParams.set("state", authorization.searchParams.get("state")!);
    const callback = await loopbackGet(callbackUrl);
    expect(callback).toEqual({ status: 200, body: "Authentication complete. Return to the terminal." });
    await login;
    await waitForLoopbackPortReleased();

    expect(tokenRequests).toHaveLength(1);
    const tokenForm = new URLSearchParams(await tokenRequests[0].clone().text());
    expect(Object.fromEntries(tokenForm)).toMatchObject({
      grant_type: "authorization_code",
      code: "one-time-code",
      redirect_uri: "http://127.0.0.1:49173/oauth/callback",
      client_id: "ak-cli",
      resource: "https://ak.example.test/api",
    });
    const verifier = tokenForm.get("code_verifier")!;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.searchParams.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(tokenRequests[0].headers.get("authorization")).toBeNull();
    const exchangeProof = tokenRequests[0].headers.get("dpop");
    expect(exchangeProof).toEqual(expect.any(String));
    const exchangeProofHeader = decodeProtectedHeader(exchangeProof!);
    expect(exchangeProofHeader).toMatchObject({ typ: "dpop+jwt", alg: "ES256" });
    expect(exchangeProofHeader.jwk).not.toHaveProperty("d");
    const exchangeProofKey = await importJWK(exchangeProofHeader.jwk!, "ES256");
    const { payload: exchangeProofPayload } = await jwtVerify(exchangeProof!, exchangeProofKey, {
      typ: "dpop+jwt",
      algorithms: ["ES256"],
    });
    expect(exchangeProofPayload).toMatchObject({ htu: tokenEndpoint, htm: "POST", jti: expect.any(String), iat: expect.any(Number) });
    expect(exchangeProofPayload).not.toHaveProperty("ath");

    expect(configMocks.saveEnvironment).toHaveBeenCalledWith({
      apiUrl: "https://ak.example.test",
      issuer,
      resource: "https://ak.example.test/api",
      clientId: "ak-cli",
    });
    const stored = JSON.parse(keychain.get("agent-kanban.realmroot:ak.example.test")!) as {
      accessToken: string;
      refreshToken: string;
      tokenType: "Bearer" | "DPoP";
      publicJwk: JsonWebKey;
    };
    expect(stored).toMatchObject({ refreshToken: "refresh-token", tokenType });
    expect(stored.publicJwk).toEqual(exchangeProofHeader.jwk);
    const confirmation = decodeJwt(stored.accessToken).cnf as { jkt?: string } | undefined;
    if (tokenType === "DPoP") {
      expect(confirmation?.jkt).toBe(await calculateJwkThumbprint(exchangeProofHeader.jwk!));
    } else {
      expect(confirmation).toBeUndefined();
    }

    const headers = await realmrootRequestHeaders("post", "https://ak.example.test/api/tasks/task-1?debug=secret");
    expect(headers.authorization).toBe(`${tokenType} ${stored.accessToken}`);
    if (tokenType === "Bearer") {
      expect(headers).not.toHaveProperty("dpop");
    } else {
      const proofHeader = decodeProtectedHeader(headers.dpop);
      expect(proofHeader).toMatchObject({ typ: "dpop+jwt", alg: "ES256" });
      expect(proofHeader.jwk).not.toHaveProperty("d");
      expect(proofHeader.jwk).toEqual(exchangeProofHeader.jwk);
      const proofKey = await importJWK(proofHeader.jwk!, "ES256");
      const { payload } = await jwtVerify(headers.dpop, proofKey, { typ: "dpop+jwt", algorithms: ["ES256"] });
      expect(payload).toMatchObject({ htu: "https://ak.example.test/api/tasks/task-1", htm: "POST" });
      expect(payload.ath).toEqual(expect.any(String));

      const { mf, db } = await setupMiniflare();
      try {
        const app = new Hono<{ Bindings: Env }>();
        app.use("*", authMiddleware);
        app.get("/api/boards", (c) => c.json({ tenantId: c.get("ownerId") }));
        const response = await app.fetch(
          new Request("https://ak.example.test/api/boards", {
            headers: await realmrootRequestHeaders("GET", "https://ak.example.test/api/boards"),
          }),
          {
            ...createTestEnv(),
            DB: db,
            REALMROOT_ISSUER: issuer,
            REALMROOT_CLI_CLIENT_ID: "ak-cli",
            AK_RESOURCE: "https://ak.example.test/api",
          } as never,
        );
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ tenantId: "tenant-native-login" });
      } finally {
        await mf.dispose();
      }
    }

    clearRealmrootAuthority("https://ak.example.test");
    expect(keychain.size).toBe(0);
  });

  it("keeps listening after a mismatched state and accepts the matching callback", async () => {
    const issuer = "https://id.realmroot.dev/api/auth";
    const authorizationEndpoint = `${issuer}/oauth2/authorize`;
    const tokenEndpoint = `${issuer}/oauth2/token`;
    const accessToken = await accessTokenExpiringIn(600);
    const tokenRequests: Request[] = [];
    installLoginFetch({ issuer, authorizationEndpoint, tokenEndpoint, accessToken, tokenType: "Bearer", tokenRequests });

    const login = loginWithRealmroot({ apiUrl: "https://ak.example.test", clientId: "ak-cli", issuer });
    const authorization = await waitForAuthorizationUrl();
    const redirectUri = authorization.searchParams.get("redirect_uri")!;
    await waitForLoopbackServer(redirectUri);
    const wrongCallback = new URL(redirectUri);
    wrongCallback.searchParams.set("code", "attacker-code");
    wrongCallback.searchParams.set("state", `${authorization.searchParams.get("state")}-wrong`);

    await expect(loopbackGet(wrongCallback)).resolves.toEqual({ status: 400, body: "Invalid authorization state." });
    expect(tokenRequests).toHaveLength(0);
    expect(keychain.size).toBe(0);
    expect(configMocks.saveEnvironment).not.toHaveBeenCalled();

    const validCallback = new URL(redirectUri);
    validCallback.searchParams.set("code", "valid-code");
    validCallback.searchParams.set("state", authorization.searchParams.get("state")!);
    await expect(loopbackGet(validCallback)).resolves.toEqual({
      status: 200,
      body: "Authentication complete. Return to the terminal.",
    });
    await login;
    await waitForLoopbackPortReleased();
    expect(tokenRequests).toHaveLength(1);
    expect(new URLSearchParams(await tokenRequests[0].clone().text()).get("code")).toBe("valid-code");
    expect(keychain.has("agent-kanban.realmroot:ak.example.test")).toBe(true);
  });

  it.each([
    {
      name: "OAuth error",
      callback: (authorization: URL) => ({
        state: authorization.searchParams.get("state")!,
        error: "access_denied",
        error_description: "not returned to terminal",
      }),
      message: "Realmroot authorization failed: access_denied",
      responseBody: "Realmroot authorization was not completed.",
    },
    {
      name: "missing code",
      callback: (authorization: URL) => ({ state: authorization.searchParams.get("state")! }),
      message: "Realmroot authorization returned no code",
      responseBody: "Missing authorization code.",
    },
  ])("rejects a loopback callback with $name", async ({ callback, message, responseBody }) => {
    const issuer = "https://id.realmroot.dev/api/auth";
    const authorizationEndpoint = `${issuer}/oauth2/authorize`;
    const tokenEndpoint = `${issuer}/oauth2/token`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://ak.example.test/.well-known/oauth-protected-resource/api") {
          return Response.json({ resource: "https://ak.example.test/api", authorization_servers: [issuer] });
        }
        if (url === `${issuer}/.well-known/openid-configuration`) {
          return Response.json({ issuer, authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint });
        }
        throw new Error(`Token exchange must not run after an invalid callback: ${url}`);
      }),
    );

    const loginFailure = loginWithRealmroot({ apiUrl: "https://ak.example.test", clientId: "ak-cli", issuer }).then(
      () => null,
      (error: Error) => error,
    );
    const authorization = await waitForAuthorizationUrl();
    const redirectUri = authorization.searchParams.get("redirect_uri")!;
    await waitForLoopbackServer(redirectUri);
    const callbackUrl = new URL(redirectUri);
    for (const [name, value] of Object.entries(callback(authorization))) callbackUrl.searchParams.set(name, value);
    const callbackResponse = await loopbackGet(callbackUrl);

    expect(callbackResponse).toEqual({ status: 400, body: responseBody });
    expect((await loginFailure)?.message).toBe(message);
    await waitForLoopbackPortReleased();
    expect(keychain.size).toBe(0);
    expect(configMocks.saveEnvironment).not.toHaveBeenCalled();
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

  it("fails fast when the fixed loopback callback port is already occupied", async () => {
    const issuer = "https://id.realmroot.dev/api/auth";
    const authorizationEndpoint = `${issuer}/oauth2/authorize`;
    const tokenEndpoint = `${issuer}/oauth2/token`;
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(49173, "127.0.0.1", resolve);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://ak.example.test/.well-known/oauth-protected-resource/api") {
          return Response.json({ resource: "https://ak.example.test/api", authorization_servers: [issuer] });
        }
        if (url === `${issuer}/.well-known/openid-configuration`) {
          return Response.json({ issuer, authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    try {
      await expect(loginWithRealmroot({ apiUrl: "https://ak.example.test", clientId: "ak-cli", issuer })).rejects.toThrow(
        /Unable to start the Realmroot login callback: .*EADDRINUSE/,
      );
      expect(keychain.size).toBe(0);
      expect(configMocks.saveEnvironment).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())));
    }
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

function installLoginFetch(input: {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  accessToken?: string;
  tokenType: "Bearer" | "DPoP";
  tokenRequests: Request[];
  issuerPrivateKey?: CryptoKey;
  issuerPublicJwk?: JsonWebKey;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(requestInput, init);
      if (request.url === "https://ak.example.test/.well-known/oauth-protected-resource/api") {
        return Response.json({ resource: "https://ak.example.test/api", authorization_servers: [input.issuer] });
      }
      if (request.url === `${input.issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer: input.issuer,
          authorization_endpoint: input.authorizationEndpoint,
          token_endpoint: input.tokenEndpoint,
          ...(input.issuerPublicJwk ? { jwks_uri: `${input.issuer}/jwks`, id_token_signing_alg_values_supported: ["ES256"] } : {}),
        });
      }
      if (request.url === `${input.issuer}/jwks` && input.issuerPublicJwk) {
        return Response.json({ keys: [input.issuerPublicJwk] });
      }
      if (request.url === input.tokenEndpoint) {
        input.tokenRequests.push(request);
        const proof = request.headers.get("dpop");
        if (!proof) throw new Error("Authorization code exchange did not include a DPoP proof");
        const proofJwk = decodeProtectedHeader(proof).jwk;
        if (!proofJwk) throw new Error("Authorization code exchange DPoP proof did not include a public JWK");
        const accessToken =
          input.issuerPrivateKey && input.issuerPublicJwk
            ? await new SignJWT({
                scope: "ak:read",
                client_id: "ak-cli",
                "urn:realmroot:params:oauth:org": "tenant-native-login",
                ...(input.tokenType === "DPoP" ? { cnf: { jkt: await calculateJwkThumbprint(proofJwk) } } : {}),
              })
                .setProtectedHeader({ alg: "ES256", kid: input.issuerPublicJwk.kid, typ: "at+jwt" })
                .setIssuer(input.issuer)
                .setAudience("https://ak.example.test/api")
                .setSubject("native-login-subject")
                .setIssuedAt()
                .setExpirationTime("10m")
                .sign(input.issuerPrivateKey)
            : input.accessToken;
        if (!accessToken) throw new Error("Login test did not configure an access token");
        return Response.json({
          access_token: accessToken,
          refresh_token: "refresh-token",
          token_type: input.tokenType,
          expires_in: 600,
        });
      }
      throw new Error(`Unexpected request: ${request.url}`);
    }),
  );
}

async function waitForAuthorizationUrl(): Promise<URL> {
  await vi.waitFor(() => expect(console.log).toHaveBeenCalledTimes(1));
  const message = String(vi.mocked(console.log).mock.calls[0][0]);
  expect(message).toMatch(/^Open https:\/\//);
  return new URL(message.slice("Open ".length));
}

async function waitForLoopbackServer(redirectUri: string): Promise<void> {
  const readinessUrl = new URL("/ready", redirectUri);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await loopbackGet(readinessUrl);
      if (response.status === 404) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Realmroot loopback callback server did not start");
}

function loopbackGet(url: URL): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, { agent: false, headers: { connection: "close" } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
  });
}

async function waitForLoopbackPortReleased(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = createServer();
    const available = await new Promise<boolean>((resolve, reject) => {
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") resolve(false);
        else reject(error);
      });
      probe.listen(49173, "127.0.0.1", () => resolve(true));
    });
    if (available) {
      await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Realmroot loopback callback server did not release its port");
}

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
