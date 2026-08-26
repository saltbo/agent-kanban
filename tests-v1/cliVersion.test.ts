// @vitest-environment node
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, createTestWebSession, seedUser, setupMiniflare } from "./helpers/db";

const env = createTestEnv();
let mf: Miniflare;
let apiKey: string;

async function apiRequest(method: string, path: string, extraHeaders?: Record<string, string>) {
  const { api } = await import("../apps/web/server/routes");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Host: "localhost:8788",
    "x-forwarded-proto": "http",
    cookie: `ak_session=${apiKey}`,
    ...extraHeaders,
  };
  return api.request(path, { method, headers }, env);
}

beforeAll(async () => {
  ({ mf, db: env.DB } = await setupMiniflare());
  await seedUser(env.DB, "cli-version-test-user", "cliversion@test.com");
  apiKey = (await createTestWebSession(env.DB, "cli-version-test-user")).token;
});

afterAll(async () => {
  await mf.dispose();
});

describe("cliVersionMiddleware", () => {
  it("passes through when no X-CLI-Version header is present", async () => {
    const res = await apiRequest("GET", "/api/boards");
    // Auth passes, middleware skips — should not be 403
    expect(res.status).not.toBe(403);
  });

  it("passes through when MIN_CLI_VERSION is not configured", async () => {
    // env has no MIN_CLI_VERSION set
    const res = await apiRequest("GET", "/api/boards", { "X-CLI-Version": "0.0.1" });
    expect(res.status).not.toBe(403);
  });

  it("passes through when client version equals minimum version", async () => {
    (env as any).MIN_CLI_VERSION = "1.5.0";
    try {
      const res = await apiRequest("GET", "/api/boards", { "X-CLI-Version": "1.5.0" });
      expect(res.status).not.toBe(403);
    } finally {
      delete (env as any).MIN_CLI_VERSION;
    }
  });

  it("passes through when client version is greater than minimum version", async () => {
    (env as any).MIN_CLI_VERSION = "1.0.0";
    try {
      const res = await apiRequest("GET", "/api/boards", { "X-CLI-Version": "2.0.0" });
      expect(res.status).not.toBe(403);
    } finally {
      delete (env as any).MIN_CLI_VERSION;
    }
  });

  it("returns 403 when client version is below minimum", async () => {
    (env as any).MIN_CLI_VERSION = "2.0.0";
    try {
      const res = await apiRequest("GET", "/api/boards", { "X-CLI-Version": "1.9.9" });
      expect(res.status).toBe(426);
    } finally {
      delete (env as any).MIN_CLI_VERSION;
    }
  });

  it("returns error code CLI_UPGRADE_REQUIRED on version rejection", async () => {
    (env as any).MIN_CLI_VERSION = "2.0.0";
    try {
      const res = await apiRequest("GET", "/api/boards", { "X-CLI-Version": "1.0.0" });
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("CLI_UPGRADE_REQUIRED");
    } finally {
      delete (env as any).MIN_CLI_VERSION;
    }
  });

  it("returns min_version in error body", async () => {
    (env as any).MIN_CLI_VERSION = "3.1.0";
    try {
      const res = await apiRequest("GET", "/api/boards", { "X-CLI-Version": "2.0.0" });
      const body = (await res.json()) as any;
      expect(body.error.min_version).toBe("3.1.0");
    } finally {
      delete (env as any).MIN_CLI_VERSION;
    }
  });

  it("error message mentions ak upgrade", async () => {
    (env as any).MIN_CLI_VERSION = "2.0.0";
    try {
      const res = await apiRequest("GET", "/api/boards", { "X-CLI-Version": "1.0.0" });
      const body = (await res.json()) as any;
      expect(body.error.message).toContain("ak upgrade");
    } finally {
      delete (env as any).MIN_CLI_VERSION;
    }
  });

  it("passes through when client patch version is higher", async () => {
    (env as any).MIN_CLI_VERSION = "1.2.3";
    try {
      const res = await apiRequest("GET", "/api/boards", { "X-CLI-Version": "1.2.4" });
      expect(res.status).not.toBe(403);
    } finally {
      delete (env as any).MIN_CLI_VERSION;
    }
  });

  it("returns 403 when only patch version is lower", async () => {
    (env as any).MIN_CLI_VERSION = "1.2.5";
    try {
      const res = await apiRequest("GET", "/api/boards", { "X-CLI-Version": "1.2.4" });
      expect(res.status).toBe(426);
    } finally {
      delete (env as any).MIN_CLI_VERSION;
    }
  });
});
