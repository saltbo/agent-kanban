import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { api } from "../../../apps/web/server/routes";
import type { Env } from "../../../apps/web/server/types";

export const API_VERSION = "2026-08-22";
export const AK_ORIGIN = "http://ak.test";
export const DEV_SECRET = "v2-test-secret";

export type TestApplication = {
  db: D1Database;
  env: Env;
  request(path: string, init?: RequestInit, identity?: { tenant?: string; issuer?: string; subject?: string }): Promise<Response>;
  close(): Promise<void>;
};

export async function createTestApplication(overrides: Partial<Env> = {}): Promise<TestApplication> {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('test'); } }",
    compatibilityDate: "2026-04-13",
    d1Databases: ["DB"],
  });
  const db = await miniflare.getD1Database("DB");
  const migration = await readFile(new URL("../../../apps/web/migrations/0001_v2.sql", import.meta.url), "utf8");
  for (const statement of migration
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)) {
    await db.prepare(statement).run();
  }
  const env = {
    DB: db,
    ASSETS: { fetch: () => Promise.resolve(new Response("not found", { status: 404 })) } as Fetcher,
    REALMROOT_ISSUER: "http://realmroot.invalid/api/auth",
    REALMROOT_WEB_CLIENT_ID: "ak-web",
    REALMROOT_WEB_CLIENT_SECRET: "web-secret",
    REALMROOT_SESSION_ENCRYPTION_KEY: "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
    REALMROOT_CLI_CLIENT_ID: "ak-cli",
    AK_RESOURCE: `${AK_ORIGIN}/api`,
    AK_API_URL: AK_ORIGIN,
    AMA_ORIGIN: "http://ama.invalid",
    AMA_RESOURCE: "http://ama.invalid/api",
    AK_DEV_AUTH_SECRET: DEV_SECRET,
    AMA_DEV_ACCESS_TOKEN: "ama-test-token",
    ...overrides,
  } satisfies Env;

  return {
    db,
    env,
    request(path, init = {}, identity = {}) {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Dev ${DEV_SECRET}`);
      headers.set("X-AK-Dev-Tenant", identity.tenant ?? "tenant-a");
      if (identity.issuer) headers.set("X-AK-Dev-Actor-Issuer", identity.issuer);
      if (identity.subject) headers.set("X-AK-Dev-Actor-Subject", identity.subject);
      if (
        !headers.has("API-Version") &&
        path.startsWith("/api/") &&
        !path.startsWith("/api/auth/") &&
        !["/api/health", "/api/ready", "/api/openapi.json"].includes(path)
      ) {
        headers.set("API-Version", API_VERSION);
      }
      return api.request(`${AK_ORIGIN}${path}`, { ...init, headers }, env);
    },
    close: () => miniflare.dispose(),
  };
}

export function jsonRequest(method: string, body: unknown, key?: string): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": method === "PATCH" ? "application/merge-patch+json" : "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  };
}

export async function responseJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
