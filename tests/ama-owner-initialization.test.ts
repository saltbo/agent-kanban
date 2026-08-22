// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEnv, seedUser, setupMiniflare } from "./helpers/db";

const activeMiniflares: Array<Awaited<ReturnType<typeof setupMiniflare>>["mf"]> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(activeMiniflares.splice(0).map((mf) => mf.dispose()));
});

describe("AMA tenant resource initialization", () => {
  it("coalesces concurrent callers and uses stable idempotency keys for one project and vault", async () => {
    const ownerId = `ama-init-concurrent-${randomUUID()}`;
    const { db, env } = await harness(ownerId);
    const projectGate = deferred<Response>();
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        if (request.url === "https://ama.init.test/api/v1/projects") return projectGate.promise;
        if (request.url === "https://ama.init.test/api/v1/vaults") return vaultResponse("vault-concurrent", ownerId);
        throw new Error(`Unexpected initialization request: ${request.method} ${request.url}`);
      }),
    );
    const { ensureAmaOwnerIntegration } = await import("../apps/web/server/amaOwnerIntegrationRepo");

    const attempts = Array.from({ length: 8 }, () => ensureAmaOwnerIntegration(db, env, ownerId));
    await vi.waitFor(() => expect(requests.filter(({ url }) => url.endsWith("/projects"))).toHaveLength(1));
    let waiterSettled = false;
    void attempts[7].finally(() => {
      waiterSettled = true;
    });
    await Promise.resolve();
    expect(waiterSettled).toBe(false);
    projectGate.resolve(jsonResponse({ id: "project-concurrent", name: `Workspace ${ownerId}` }, 201));

    const results = await Promise.all(attempts);
    expect(results).toEqual(
      Array.from({ length: 8 }, () => ({
        tenantId: ownerId,
        amaProjectId: "project-concurrent",
        sessionSecretVaultId: "vault-concurrent",
        metadata: {},
      })),
    );
    const projectRequests = requests.filter(({ url }) => url.endsWith("/projects"));
    const vaultRequests = requests.filter(({ url }) => url.endsWith("/vaults"));
    expect(projectRequests).toHaveLength(1);
    expect(vaultRequests).toHaveLength(1);
    expect(projectRequests[0].headers.get("idempotency-key")).toMatch(/^ak-[a-f0-9]{64}$/);
    expect(vaultRequests[0].headers.get("idempotency-key")).toMatch(/^ak-[a-f0-9]{64}$/);
    expect(projectRequests[0].headers.get("idempotency-key")).not.toBe(vaultRequests[0].headers.get("idempotency-key"));
    expect(await db.prepare("SELECT tenant_id FROM ama_resource_initializations WHERE tenant_id = ?").bind(ownerId).first()).toBeNull();
  });

  it("waits for another claimant and returns its completed integration without duplicate AMA writes", async () => {
    const ownerId = `ama-init-waiter-${randomUUID()}`;
    const { db, env } = await harness(ownerId);
    await db
      .prepare("INSERT INTO ama_resource_initializations (tenant_id, claim_token, expires_at) VALUES (?, 'remote-claim', ?)")
      .bind(ownerId, new Date(Date.now() + 10_000).toISOString())
      .run();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://ama.init.test/api/v1/projects/project-winner") {
        return jsonResponse({ id: "project-winner", name: "Winner" });
      }
      throw new Error(`Unexpected waiter request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { ensureAmaOwnerIntegration } = await import("../apps/web/server/amaOwnerIntegrationRepo");

    const waiting = ensureAmaOwnerIntegration(db, env, ownerId);
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(fetchMock).not.toHaveBeenCalled();
    await db.batch([
      db
        .prepare(
          `INSERT INTO ama_owner_integrations (tenant_id, ama_project_id, session_secret_vault_id, metadata)
           VALUES (?, 'project-winner', 'vault-winner', '{}')`,
        )
        .bind(ownerId),
      db.prepare("DELETE FROM ama_resource_initializations WHERE tenant_id = ? AND claim_token = 'remote-claim'").bind(ownerId),
    ]);

    await expect(waiting).resolves.toEqual({
      tenantId: ownerId,
      amaProjectId: "project-winner",
      sessionSecretVaultId: "vault-winner",
      metadata: {},
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0] instanceof Request ? fetchMock.mock.calls[0][0].url : String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://ama.init.test/api/v1/projects/project-winner",
    );
  });

  it("takes over an expired lease", async () => {
    const expiredOwner = `ama-init-expired-${randomUUID()}`;
    const expired = await harness(expiredOwner);
    await expired.db
      .prepare("INSERT INTO ama_resource_initializations (tenant_id, claim_token, expires_at) VALUES (?, 'expired-claim', ?)")
      .bind(expiredOwner, new Date(Date.now() - 1_000).toISOString())
      .run();
    const expiredRequests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        expiredRequests.push(request.clone());
        if (request.url.endsWith("/projects")) return jsonResponse({ id: "project-takeover", name: "Takeover" }, 201);
        if (request.url.endsWith("/vaults")) return vaultResponse("vault-takeover", expiredOwner);
        throw new Error(`Unexpected takeover request: ${request.url}`);
      }),
    );
    const { ensureAmaOwnerIntegration } = await import("../apps/web/server/amaOwnerIntegrationRepo");
    await expect(ensureAmaOwnerIntegration(expired.db, expired.env, expiredOwner)).resolves.toMatchObject({
      amaProjectId: "project-takeover",
      sessionSecretVaultId: "vault-takeover",
    });
    expect(expiredRequests.filter(({ url }) => url.endsWith("/projects"))).toHaveLength(1);
    expect(
      await expired.db.prepare("SELECT claim_token FROM ama_resource_initializations WHERE tenant_id = ?").bind(expiredOwner).first(),
    ).toBeNull();
  });

  it("fences a slow claimant that loses ownership", { timeout: 15_000 }, async () => {
    const fencedOwner = `ama-init-fenced-${randomUUID()}`;
    const fenced = await harness(fencedOwner);
    const projectGate = deferred<Response>();
    const projectStarted = deferred<void>();
    let vaultWrites = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/projects")) {
          projectStarted.resolve();
          return projectGate.promise;
        }
        if (url.endsWith("/vaults")) {
          vaultWrites += 1;
          return vaultResponse("vault-loser", fencedOwner);
        }
        if (url === "https://ama.init.test/api/v1/projects/project-fencing-winner") {
          return jsonResponse({ id: "project-fencing-winner", name: "Winner" });
        }
        throw new Error(`Unexpected fencing request: ${url}`);
      }),
    );
    const { ensureAmaOwnerIntegration } = await import("../apps/web/server/amaOwnerIntegrationRepo");
    const slow = ensureAmaOwnerIntegration(fenced.db, fenced.env, fencedOwner);
    await projectStarted.promise;
    expect(
      await fenced.db.prepare("SELECT claim_token FROM ama_resource_initializations WHERE tenant_id = ?").bind(fencedOwner).first(),
    ).not.toBeNull();
    await fenced.db.batch([
      fenced.db
        .prepare(
          `INSERT INTO ama_owner_integrations (tenant_id, ama_project_id, session_secret_vault_id, metadata)
           VALUES (?, 'project-fencing-winner', 'vault-fencing-winner', '{}')`,
        )
        .bind(fencedOwner),
      fenced.db.prepare("DELETE FROM ama_resource_initializations WHERE tenant_id = ?").bind(fencedOwner),
    ]);
    projectGate.resolve(jsonResponse({ id: "project-loser", name: "Loser" }, 201));

    await expect(slow).resolves.toEqual({
      tenantId: fencedOwner,
      amaProjectId: "project-fencing-winner",
      sessionSecretVaultId: "vault-fencing-winner",
      metadata: {},
    });
    expect(vaultWrites).toBe(0);
    await expect(
      fenced.db.prepare("SELECT ama_project_id, session_secret_vault_id FROM ama_owner_integrations WHERE tenant_id = ?").bind(fencedOwner).first(),
    ).resolves.toEqual({ ama_project_id: "project-fencing-winner", session_secret_vault_id: "vault-fencing-winner" });
  });

  it("checkpoints a created project and retries only the failed vault phase", async () => {
    const ownerId = `ama-init-recovery-${randomUUID()}`;
    const { db, env } = await harness(ownerId);
    let projectAttempts = 0;
    let projectReads = 0;
    let vaultAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/projects") && request.method === "POST") {
          projectAttempts += 1;
          return jsonResponse({ id: "project-checkpointed", name: "Checkpointed" }, 201);
        }
        if (request.url.endsWith("/projects/project-checkpointed") && request.method === "GET") {
          projectReads += 1;
          return jsonResponse({ id: "project-checkpointed", name: "Checkpointed" });
        }
        if (request.url.endsWith("/vaults")) {
          vaultAttempts += 1;
          if (vaultAttempts === 1) return jsonResponse({ error: "temporary" }, 503);
          return vaultResponse("vault-recovered", ownerId);
        }
        throw new Error(`Unexpected recovery request: ${request.method} ${request.url}`);
      }),
    );
    const { ensureAmaOwnerIntegration } = await import("../apps/web/server/amaOwnerIntegrationRepo");

    await expect(ensureAmaOwnerIntegration(db, env, ownerId)).rejects.toThrow("AMA create vault failed HTTP 503");
    expect(await db.prepare("SELECT claim_token FROM ama_resource_initializations WHERE tenant_id = ?").bind(ownerId).first()).toBeNull();
    await expect(
      db.prepare("SELECT ama_project_id, session_secret_vault_id FROM ama_owner_integrations WHERE tenant_id = ?").bind(ownerId).first(),
    ).resolves.toEqual({ ama_project_id: "project-checkpointed", session_secret_vault_id: null });

    await expect(ensureAmaOwnerIntegration(db, env, ownerId)).resolves.toMatchObject({
      amaProjectId: "project-checkpointed",
      sessionSecretVaultId: "vault-recovered",
    });
    expect(projectAttempts).toBe(1);
    expect(projectReads).toBe(1);
    expect(vaultAttempts).toBe(2);
  });
});

async function harness(ownerId: string) {
  const { mf, db } = await setupMiniflare();
  activeMiniflares.push(mf);
  await seedUser(db, ownerId, `${ownerId}@example.test`);
  const env = {
    ...createTestEnv(),
    DB: db,
    AMA_ORIGIN: "https://ama.init.test",
    AMA_RESOURCE: "https://ama.init.test/api",
  } as never;
  return { db, env };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function vaultResponse(id: string, projectId: string): Response {
  return jsonResponse(
    {
      metadata: { uid: id, projectId, name: id, description: null, archivedAt: null },
      spec: { scope: "project" },
      status: {},
    },
    201,
  );
}
