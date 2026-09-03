// @vitest-environment node

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../server/env";
import { api } from "../../../server/http/app";
import { createTestEnv, setupMiniflare } from "../../helpers/db";

const webhookSecret = "test-webhook-secret-xyz";
let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let env: Env;

beforeAll(async () => {
  const setup = await setupMiniflare();
  mf = setup.mf;
  env = { ...createTestEnv(), DB: setup.db, GITHUB_APP_WEBHOOK_SECRET: webhookSecret } as Env;
});

afterAll(async () => mf.dispose());
afterEach(() => vi.unstubAllGlobals());

describe("v2 GitHub webhook routing without Maintainers", () => {
  it.each(["issues", "issue_comment", "pull_request_review", "pull_request_review_comment"])(
    "does not dispatch removed Maintainer event %s",
    async (event) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const body = JSON.stringify({ action: "created" });

      const response = await webhookRequest(event, body);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ handled: false });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("[spec: repositories/pull-request-update] keeps pull_request task routing without a maintainer_dispatch response", async () => {
    const body = JSON.stringify({ action: "opened", pull_request: { html_url: "https://github.com/acme/repo/pull/1", merged: false } });

    const response = await webhookRequest("pull_request", body);

    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("maintainer_dispatch");
  });
});

async function webhookRequest(event: string, body: string): Promise<Response> {
  return api.request(
    "/api/webhooks/github-app",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": await signature(body),
        "x-github-event": event,
      },
      body,
    },
    env,
  );
}

async function signature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(webhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
