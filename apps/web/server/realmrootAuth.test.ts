// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv, setupMiniflare } from "../../../tests/helpers/db";
import { amaBearerToken } from "./realmrootAuth";
import type { Env } from "./types";

const keyBase64 = "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=";
let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let db: D1Database;

beforeEach(async () => {
  ({ mf, db } = await setupMiniflare());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await mf.dispose();
});

describe("Realmroot AMA user grants", () => {
  it("decrypts a still-valid cached Bearer grant without a network request", async () => {
    await seedGrant("tenant-cached", "subject-cached", "cached-refresh", "cached-access", Date.now() + 120_000);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(amaBearerToken(env("https://cached.realmroot.test"), "tenant-cached")).resolves.toBe("cached-access");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("coalesces concurrent refreshes, rotates both encrypted credentials, and returns one Bearer grant", async () => {
    const issuer = "https://concurrent.realmroot.test";
    await seedGrant("tenant-concurrent", "subject-concurrent", "old-refresh", "expired-access", Date.now() - 1_000);
    const tokenRequests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/.well-known/openid-configuration")) return discovery(issuer);
        tokenRequests.push(request);
        await Promise.resolve();
        return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 600 });
      }),
    );

    await expect(Promise.all(Array.from({ length: 6 }, () => amaBearerToken(env(issuer), "tenant-concurrent")))).resolves.toEqual(
      Array(6).fill("rotated-access"),
    );
    expect(tokenRequests).toHaveLength(1);
    expect(new URLSearchParams(await tokenRequests[0].clone().text())).toEqual(
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: "old-refresh", resource: "https://ama.example.test/api" }),
    );
    const row = await db.prepare("SELECT * FROM realmroot_user_ama_grants WHERE tenant_id = 'tenant-concurrent'").first<{
      refresh_token_ciphertext: string;
      access_token_ciphertext: string;
      refresh_token_nonce: string;
      access_token_nonce: string;
    }>();
    expect(row?.refresh_token_ciphertext).not.toContain("rotated-refresh");
    expect(row?.access_token_ciphertext).not.toContain("rotated-access");
    expect(row?.refresh_token_nonce).not.toBe(row?.access_token_nonce);
    await expect(amaBearerToken(env(issuer), "tenant-concurrent")).resolves.toBe("rotated-access");
    expect(tokenRequests).toHaveLength(1);
  });

  it("runs a forced refresh after an overlapping non-forced refresh completes", async () => {
    const issuer = "https://force-after-shared.realmroot.test";
    await seedGrant("tenant-force-after-shared", "subject-force-after-shared", "initial-refresh", "expired-access", Date.now() - 1_000);
    let announceFirstRequest!: () => void;
    const firstRequestStarted = new Promise<void>((resolve) => {
      announceFirstRequest = resolve;
    });
    let releaseFirstRequest!: () => void;
    const firstRequestRelease = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    const tokenRequests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/.well-known/openid-configuration")) return discovery(issuer);
        tokenRequests.push(request);
        if (tokenRequests.length === 1) {
          announceFirstRequest();
          await firstRequestRelease;
          return Response.json({ access_token: "shared-access", refresh_token: "shared-refresh", expires_in: 600 });
        }
        return Response.json({ access_token: "forced-access", refresh_token: "forced-refresh", expires_in: 600 });
      }),
    );

    const shared = amaBearerToken(env(issuer), "tenant-force-after-shared");
    await firstRequestStarted;
    const forced = amaBearerToken(env(issuer), "tenant-force-after-shared", true);
    releaseFirstRequest();

    await expect(shared).resolves.toBe("shared-access");
    await expect(forced).resolves.toBe("forced-access");
    expect(tokenRequests).toHaveLength(2);
    expect(new URLSearchParams(await tokenRequests[0].clone().text()).get("refresh_token")).toBe("initial-refresh");
    expect(new URLSearchParams(await tokenRequests[1].clone().text()).get("refresh_token")).toBe("shared-refresh");
  });

  it("returns the winning encrypted grant when compare-and-swap loses a refresh race", async () => {
    const issuer = "https://cas.realmroot.test";
    await seedGrant("tenant-cas", "subject-cas", "stale-refresh", "stale-access", Date.now() - 1_000);
    const winnerRefresh = await encrypt("winner-refresh");
    const winnerAccess = await encrypt("winner-access");
    const originalPrepare = db.prepare.bind(db);
    const database = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          if (!sql.includes("UPDATE realmroot_user_ama_grants SET")) return originalPrepare(sql);
          return {
            bind: () => ({
              run: async () => {
                await originalPrepare(
                  `UPDATE realmroot_user_ama_grants SET
                     refresh_token_ciphertext = ?, refresh_token_nonce = ?,
                     access_token_ciphertext = ?, access_token_nonce = ?, access_token_expires_at = ?
                   WHERE tenant_id = 'tenant-cas'`,
                )
                  .bind(
                    winnerRefresh.ciphertext,
                    winnerRefresh.nonce,
                    winnerAccess.ciphertext,
                    winnerAccess.nonce,
                    new Date(Date.now() + 600_000).toISOString(),
                  )
                  .run();
                return { meta: { changes: 0 } };
              },
            }),
          };
        };
      },
    }) as D1Database;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/.well-known/openid-configuration")) return discovery(issuer);
        return Response.json({ access_token: "loser-access", refresh_token: "loser-refresh", expires_in: 600 });
      }),
    );

    await expect(amaBearerToken({ ...env(issuer), DB: database }, "tenant-cas", true)).resolves.toBe("winner-access");
  });

  it("recovers the grant rotated by another isolate when the stale refresh token is rejected", async () => {
    const issuer = "https://stale-refresh.realmroot.test";
    await seedGrant("tenant-stale-refresh", "subject-stale-refresh", "stale-refresh", "stale-access", Date.now() - 1_000);
    const tokenRequests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/.well-known/openid-configuration")) return discovery(issuer);
        tokenRequests.push(request);

        const winnerRefresh = await encrypt("winner-refresh");
        const winnerAccess = await encrypt("winner-access");
        await db
          .prepare(
            `UPDATE realmroot_user_ama_grants SET
               refresh_token_ciphertext = ?, refresh_token_nonce = ?,
               access_token_ciphertext = ?, access_token_nonce = ?, access_token_expires_at = ?
             WHERE tenant_id = ?`,
          )
          .bind(
            winnerRefresh.ciphertext,
            winnerRefresh.nonce,
            winnerAccess.ciphertext,
            winnerAccess.nonce,
            new Date(Date.now() + 600_000).toISOString(),
            "tenant-stale-refresh",
          )
          .run();
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }),
    );

    await expect(amaBearerToken(env(issuer), "tenant-stale-refresh", true)).resolves.toBe("winner-access");
    expect(tokenRequests).toHaveLength(1);
    expect(new URLSearchParams(await tokenRequests[0].clone().text()).get("refresh_token")).toBe("stale-refresh");
    await expect(amaBearerToken(env(issuer), "tenant-stale-refresh")).resolves.toBe("winner-access");
    expect(tokenRequests).toHaveLength(1);
  });
});

function env(issuer: string): Env {
  return { ...createTestEnv(), DB: db, REALMROOT_ISSUER: issuer } as never;
}

function discovery(issuer: string): Response {
  return Response.json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
  });
}

async function seedGrant(tenantId: string, subjectId: string, refresh: string, access: string, expiresAt: number): Promise<void> {
  await db.prepare("INSERT INTO realmroot_tenants (id) VALUES (?)").bind(tenantId).run();
  const encryptedRefresh = await encrypt(refresh);
  const encryptedAccess = await encrypt(access);
  await db
    .prepare(
      `INSERT INTO realmroot_user_ama_grants
        (tenant_id, subject_id, refresh_token_ciphertext, refresh_token_nonce,
         access_token_ciphertext, access_token_nonce, access_token_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      tenantId,
      subjectId,
      encryptedRefresh.ciphertext,
      encryptedRefresh.nonce,
      encryptedAccess.ciphertext,
      encryptedAccess.nonce,
      new Date(expiresAt).toISOString(),
    )
    .run();
}

async function encrypt(value: string): Promise<{ ciphertext: string; nonce: string }> {
  const raw = Uint8Array.from(atob(keyBase64), (character) => character.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(value)));
  return { ciphertext: base64Url(ciphertext), nonce: base64Url(nonce) };
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
