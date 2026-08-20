// @vitest-environment node

// Regression: /api/auth/* must route through the actual `api` Hono app (what the
// worker entry uses: `api.fetch(request, env)`), not just `auth.handler` in
// isolation. A `**` wildcard silently stopped matching once the app fell back to
// Hono's TrieRouter (triggered by a regex route), 404-ing every auth endpoint.
// `*` matches in both routers. Existing tests only hit auth.api/auth.handler
// directly, so they never caught this.

import { describe, expect, it } from "vitest";
import { api } from "../apps/web/server/routes";
import { setupMiniflare } from "./helpers/db";

function env(db: D1Database): any {
  return {
    DB: db,
    AE: { writeDataPoint: () => {} },
    EMAIL: { send: async () => ({}) },
    AUTH_SECRET: "test-secret-32-chars-minimum-ok!!",
    ALLOWED_HOSTS: "localhost:6265",
    GITHUB_CLIENT_ID: "gh",
    GITHUB_CLIENT_SECRET: "ghs",
    AMA_ORIGIN: "https://ama.test",
    AMA_OIDC_ISSUER: "https://auth.test",
    AMA_OIDC_CLIENT_ID: "ak-app",
    AMA_OIDC_CLIENT_SECRET: "ak-secret",
  };
}

describe("/api/auth/* routing through the api app", () => {
  it("GET /api/auth/get-session reaches BetterAuth (not a Hono 404)", async () => {
    const { mf, db } = await setupMiniflare();
    try {
      const res = await api.fetch(new Request("http://localhost:6265/api/auth/get-session"), env(db));
      // No session → BetterAuth returns 200 with a null body. The point is it is
      // NOT the Hono 404 that the unmatched `**` route produced.
      expect(res.status).toBe(200);
    } finally {
      await mf.dispose();
    }
    // BetterAuth session bootstrap is slow under the single-worker pre-commit
    // hook; give it headroom so it doesn't trip the 5s default timeout.
  }, 15_000);

  it("POST /api/auth/sign-in/social reaches BetterAuth (returns the provider authorize URL)", async () => {
    const { mf, db } = await setupMiniflare();
    try {
      const res = await api.fetch(
        new Request("http://localhost:6265/api/auth/sign-in/social", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "github", callbackURL: "/" }),
        }),
        env(db),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { url?: string };
      expect(body.url).toContain("github.com/login/oauth/authorize");
    } finally {
      await mf.dispose();
    }
  }, 15_000);
});
