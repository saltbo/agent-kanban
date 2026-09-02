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
  it("[spec: agents/authoritative-projection] strictly decodes token exchange success and classifies exchange failures", async () => {
    for (const [response, status] of [
      [Response.json({ access_token: "" }), 502],
      [Response.json({ access_token: "token", expires_in: "300" }), 502],
      [new Response("not-json", { status: 200 }), 502],
      [Response.json({ error: "invalid_grant" }, { status: 401 }), 502],
      [Response.json({ error: "access_denied" }, { status: 403 }), 403],
      [Response.json({ error: "slow_down" }, { status: 429 }), 503],
      [Response.json({ error: "temporarily_unavailable" }, { status: 500 }), 503],
    ] as const) {
      stubExchange(() => response.clone());
      await expect(delegatedAmaToken(env, { sourceAccessToken: "source", scopes: ["agents:read"] })).rejects.toMatchObject({ status });
    }
  });

  it("[spec: agents/authoritative-projection] classifies discovery and network failures through the error handler", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad discovery", { status: 400 })),
    );
    await expect(delegatedAmaToken(env, { sourceAccessToken: "source", scopes: ["agents:read"] })).rejects.toMatchObject({ status: 502 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("network down"))),
    );
    await expect(delegatedAmaToken(env, { sourceAccessToken: "source", scopes: ["agents:read"] })).rejects.toMatchObject({ status: 503 });

    for (const status of [401, 403, 502, 503] as const) {
      const app = new Hono<{ Bindings: Env }>();
      app.get("/api/agents", () => {
        throw new RealmrootDelegationFailure(`delegation-${status}`, status);
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
});
