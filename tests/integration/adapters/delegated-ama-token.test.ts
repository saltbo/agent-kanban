// @vitest-environment node

import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { delegatedAmaToken, RealmrootDelegationFailure } from "../../../server/adapters/realmroot/delegatedAmaToken";
import type { Env } from "../../../server/env";
import { apiErrorHandler } from "../../../server/http/middleware/errorHandler";

const issuer = "https://id.realmroot.test/oauth";
const tokenEndpoint = "https://id.realmroot.test/oauth/token";
const env = {
  OIDC_ISSUER: issuer,
  OIDC_WEB_CLIENT_ID: "ak-web",
  OIDC_WEB_CLIENT_SECRET: "secret",
  AMA_ORIGIN: "https://ama.test",
  AK_PUBLIC_ORIGIN: "https://ak.test",
} as Env;

afterEach(() => vi.unstubAllGlobals());

function stubExchange(exchange: () => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(".well-known/openid-configuration")) return Response.json({ issuer, token_endpoint: tokenEndpoint });
      return exchange();
    }),
  );
}

describe("Realmroot delegated AMA token boundary", () => {
  it("redacts OIDC error_description from delegation failures and API Problems", async () => {
    const credentialSentinel = "oidc-upstream-credential-sentinel";
    stubExchange(() => Response.json({ error: "access_denied", error_description: credentialSentinel }, { status: 403 }));

    const failure = await delegatedAmaToken(env, { sourceAccessToken: "source", scopes: ["agents:read"] }).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(RealmrootDelegationFailure);
    expect(failure).toMatchObject({ kind: "denied", message: "Realmroot token exchange was denied." });
    expect(String(failure)).not.toContain(credentialSentinel);

    const app = new Hono<{ Bindings: Env }>();
    app.get("/api/agents", async (c) => c.text(await delegatedAmaToken(c.env, { sourceAccessToken: "source", scopes: ["agents:read"] })));
    app.onError(apiErrorHandler);
    const response = await app.fetch(new Request("https://ak.test/api/agents"), env);

    expect(response.status).toBe(403);
    const problem = (await response.json()) as { detail: string };
    expect(problem.detail).toBe("Realmroot token exchange was denied.");
    expect(JSON.stringify(problem)).not.toContain(credentialSentinel);
  });

  it("[spec: agents/authoritative-projection] strictly decodes token exchange success and classifies exchange failures", async () => {
    for (const [response, kind] of [
      [Response.json({ access_token: "" }), "invalid-response"],
      [Response.json({ access_token: "token", expires_in: "300" }), "invalid-response"],
      [new Response("not-json", { status: 200 }), "invalid-response"],
      [Response.json({ error: "invalid_grant" }, { status: 401 }), "invalid-response"],
      [Response.json({ error: "access_denied" }, { status: 403 }), "denied"],
      [Response.json({ error: "slow_down" }, { status: 429 }), "unavailable"],
      [Response.json({ error: "temporarily_unavailable" }, { status: 500 }), "unavailable"],
    ] as const) {
      stubExchange(() => response.clone());
      await expect(delegatedAmaToken(env, { sourceAccessToken: "source", scopes: ["agents:read"] })).rejects.toMatchObject({ kind });
    }
  });

  it("[spec: agents/authoritative-projection] classifies discovery and network failures through the error handler", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad discovery", { status: 400 })),
    );
    await expect(delegatedAmaToken(env, { sourceAccessToken: "source", scopes: ["agents:read"] })).rejects.toMatchObject({
      kind: "invalid-response",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("network down"))),
    );
    await expect(delegatedAmaToken(env, { sourceAccessToken: "source", scopes: ["agents:read"] })).rejects.toMatchObject({ kind: "unavailable" });

    for (const [kind, status] of [
      ["reauthenticate", 401],
      ["denied", 403],
      ["invalid-response", 502],
      ["unavailable", 503],
    ] as const) {
      const app = new Hono<{ Bindings: Env }>();
      app.get("/api/agents", () => {
        throw new RealmrootDelegationFailure(kind, `delegation-${status}`);
      });
      app.onError(apiErrorHandler);
      const response = await app.fetch(new Request("https://ak.test/api/agents"), env);
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({
        status,
        detail: `delegation-${status}`,
        type: expect.stringMatching(status < 500 ? /delegation-denied$/ : /delegation-unavailable$/),
      });
    }
  });

  it("bounds OIDC discovery and token exchange requests with abort signals", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        signals.push(init?.signal as AbortSignal);
        if (String(input).includes(".well-known/openid-configuration")) {
          return Response.json({ issuer, token_endpoint: tokenEndpoint });
        }
        return Response.json({ access_token: "delegated-token" });
      }),
    );

    await expect(delegatedAmaToken(env, { sourceAccessToken: "source", scopes: ["agents:read"] })).resolves.toBe("delegated-token");
    expect(signals).toHaveLength(2);
  });
});
