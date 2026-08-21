// @vitest-environment node

import { createHash } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "../apps/web/node_modules/hono/dist/index.js";
import { authMiddleware } from "../apps/web/server/auth";
import type { Env } from "../apps/web/server/types";
import { createTestEnv, createTestWebSession, seedUser, setupMiniflare } from "./helpers/db";

const issuer = "https://id.realmroot.dev/api/auth";
const resource = "https://ak.example.test/api";
const jwksUri = `${issuer}/jwks`;
const issuerKeysPromise = generateKeyPair("ES256", { extractable: true });

let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let db: D1Database;

beforeEach(async () => {
  ({ mf, db } = await setupMiniflare());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await mf.dispose();
});

function env(): Env {
  return { ...createTestEnv(), DB: db, AK_RESOURCE: resource, REALMROOT_CLI_CLIENT_ID: "ak-cli" } as never;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("Realmroot Resource Server authorization", () => {
  it("denies a valid human session when no route authorization rule exists", async () => {
    await db.prepare("INSERT INTO realmroot_tenants (id) VALUES ('tenant-human')").run();
    await db
      .prepare(
        `INSERT INTO realmroot_web_sessions
          (id, token_hash, tenant_id, subject_id, email, name, role, csrf_token, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "session-human",
        await sha256Hex("human-session-token"),
        "tenant-human",
        "human-1",
        "human@example.test",
        "Human",
        "member",
        "csrf-token",
        new Date(Date.now() + 60_000).toISOString(),
      )
      .run();
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", authMiddleware);
    app.get("/api/unlisted-operation", (c) => c.json({ leaked: true }));

    const response = await app.fetch(
      new Request("https://ak.example.test/api/unlisted-operation", { headers: { cookie: "ak_session=human-session-token" } }),
      env(),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("accepts an at+jwt-bound Agent proof once and rejects replay", async () => {
    await db
      .prepare(
        `INSERT INTO agents
          (id, owner_id, name, runtime, public_key, private_key, fingerprint, kind, username, realmroot_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "agent-ak-1",
        "tenant-a",
        "Worker",
        "codex",
        "public",
        "private",
        "fingerprint",
        "worker",
        "worker",
        "rr-agent-1",
        "2026-08-19T00:00:00.000Z",
        "2026-08-19T00:00:00.000Z",
      )
      .run();
    const { accessToken, proof } = await realmrootAgentAuthority({ scope: "task:claim", htu: `${resource}/tasks/task-1/claim` });
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", authMiddleware);
    app.post("/api/tasks/:id/claim", (c) => c.json({ ownerId: c.get("ownerId"), agentId: c.get("agentId"), identityType: c.get("identityType") }));
    const request = () =>
      new Request(`${resource}/tasks/task-1/claim`, {
        method: "POST",
        headers: { authorization: `DPoP ${accessToken}`, dpop: proof },
      });

    const accepted = await app.fetch(request(), env());
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ownerId: "tenant-a", agentId: "agent-ak-1", identityType: "agent:worker" });

    const replay = await app.fetch(request(), env());
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: { code: "UNAUTHORIZED", message: "Replayed DPoP proof" } });
  });

  it("rejects a valid Agent authority when the operation scope is missing", async () => {
    await db
      .prepare(
        `INSERT INTO agents
          (id, owner_id, name, runtime, public_key, private_key, fingerprint, kind, username, realmroot_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "agent-ak-2",
        "tenant-a",
        "Worker",
        "codex",
        "public",
        "private",
        "fingerprint-2",
        "worker",
        "worker-2",
        "rr-agent-2",
        "2026-08-19T00:00:00.000Z",
        "2026-08-19T00:00:00.000Z",
      )
      .run();
    const { accessToken, proof } = await realmrootAgentAuthority({
      agentId: "rr-agent-2",
      scope: "task:review",
      htu: `${resource}/tasks/task-1/claim`,
    });
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", authMiddleware);
    app.post("/api/tasks/:id/claim", (c) => c.json({ accepted: true }));

    const response = await app.fetch(
      new Request(`${resource}/tasks/task-1/claim`, {
        method: "POST",
        headers: { authorization: `DPoP ${accessToken}`, dpop: proof },
      }),
      env(),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN", message: "Missing scope: task:claim" } });
  });

  it("rejects an Agent access token issued to a non-Realmroot CLI client", async () => {
    await db
      .prepare(
        `INSERT INTO agents
          (id, owner_id, name, runtime, public_key, private_key, fingerprint, kind, username, realmroot_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "agent-ak-invalid-client",
        "tenant-a",
        "Worker",
        "codex",
        "public",
        "private",
        "fingerprint-invalid-client",
        "worker",
        "worker-invalid-client",
        "rr-agent-invalid-client",
        "2026-08-19T00:00:00.000Z",
        "2026-08-19T00:00:00.000Z",
      )
      .run();
    const { accessToken, proof } = await realmrootAgentAuthority({
      agentId: "rr-agent-invalid-client",
      clientId: "unknown-native-client",
      scope: "task:claim",
      htu: `${resource}/tasks/task-1/claim`,
    });
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", authMiddleware);
    app.post("/api/tasks/:id/claim", (c) => c.json({ accepted: true }));

    const response = await app.fetch(
      new Request(`${resource}/tasks/task-1/claim`, {
        method: "POST",
        headers: { authorization: `DPoP ${accessToken}`, dpop: proof },
      }),
      env(),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHORIZED", message: "Access token client is not allowed for AK" } });
  });

  it("rejects an Agent request carrying a session context not bound to that Agent", async () => {
    await db
      .prepare(
        `INSERT INTO agents
          (id, owner_id, name, runtime, public_key, private_key, fingerprint, kind, username, realmroot_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "agent-ak-session",
        "tenant-a",
        "Worker",
        "codex",
        "public",
        "private",
        "fingerprint-session",
        "worker",
        "worker-session",
        "rr-agent-session",
        "2026-08-19T00:00:00.000Z",
        "2026-08-19T00:00:00.000Z",
      )
      .run();
    const { accessToken, proof } = await realmrootAgentAuthority({
      agentId: "rr-agent-session",
      scope: "task:claim",
      htu: `${resource}/tasks/task-1/claim`,
    });
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", authMiddleware);
    app.post("/api/tasks/:id/claim", (c) => c.json({ accepted: true }));

    const response = await app.fetch(
      new Request(`${resource}/tasks/task-1/claim`, {
        method: "POST",
        headers: {
          authorization: `DPoP ${accessToken}`,
          dpop: proof,
          "x-ak-session-id": "not-bound-to-this-agent",
        },
      }),
      env(),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { message: "AK Agent session context is invalid" } });
  });

  it("prevents a Realmroot Agent from updating another Agent's session usage", async () => {
    for (const [id, realmrootAgentId] of [
      ["agent-usage-a", "rr-agent-usage-a"],
      ["agent-usage-b", "rr-agent-usage-b"],
    ]) {
      await db
        .prepare(
          `INSERT INTO agents
            (id, owner_id, name, runtime, public_key, private_key, fingerprint, kind, username, realmroot_agent_id, created_at, updated_at)
           VALUES (?, 'tenant-a', 'Worker', 'codex', 'public', 'private', ?, 'worker', ?, ?, ?, ?)`,
        )
        .bind(id, `fingerprint-${id}`, `worker-${id}`, realmrootAgentId, "2026-08-19T00:00:00.000Z", "2026-08-19T00:00:00.000Z")
        .run();
    }
    const { upsertMachine } = await import("../apps/web/server/machineRepo");
    const machine = await upsertMachine(db, "tenant-a", {
      name: "Usage machine",
      os: "test",
      version: "1",
      device_id: "usage-machine",
      runtimes: [],
    });
    await db
      .prepare(
        `INSERT INTO agent_sessions
          (id, agent_id, machine_id, status, public_key, delegation_proof, created_at)
         VALUES ('usage-session-b', 'agent-usage-b', ?, 'active', 'public', 'proof', ?)`,
      )
      .bind(machine.id, new Date().toISOString())
      .run();
    const path = "/api/agents/agent-usage-b/sessions/usage-session-b/usage";
    const { accessToken, proof } = await realmrootAgentAuthority({
      agentId: "rr-agent-usage-a",
      scope: "agent:usage",
      htu: `${resource}/agents/agent-usage-b/sessions/usage-session-b/usage`,
      htm: "PATCH",
    });
    const { api } = await import("../apps/web/server/routes");

    const response = await api.fetch(
      new Request(`https://ak.example.test${path}`, {
        method: "PATCH",
        headers: { authorization: `DPoP ${accessToken}`, dpop: proof, "content-type": "application/json" },
        body: JSON.stringify({ input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0, cost_micro_usd: 3 }),
      }),
      env(),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { message: "Realmroot Agent authority is bound to a different AK Agent" },
    });
  });

  it("rejects cross-tenant task mutation, review, notes, messages, and SSE resume", async () => {
    await seedUser(db, "tenant-a", "tenant-a@example.test");
    await seedUser(db, "tenant-b", "tenant-b@example.test");
    await db
      .prepare(
        `INSERT INTO agents
          (id, owner_id, name, runtime, public_key, private_key, fingerprint, kind, username, realmroot_agent_id, created_at, updated_at)
         VALUES ('cross-tenant-agent', 'tenant-a', 'Worker', 'codex', 'public', 'private', 'cross-fingerprint', 'worker',
                 'cross-tenant-agent', 'rr-cross-tenant-agent', ?, ?)`,
      )
      .bind(new Date().toISOString(), new Date().toISOString())
      .run();
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const board = await createBoard(db, "tenant-b", "Tenant B board", "ops");
    const task = await createTask(db, "tenant-b", { title: "Tenant B task", board_id: board.id });
    const { api } = await import("../apps/web/server/routes");
    const agentOperations = [
      { method: "PATCH", suffix: "", scope: "task:log", body: { title: "cross-tenant update" } },
      { method: "DELETE", suffix: "", scope: "task:cancel", body: undefined },
      { method: "POST", suffix: "/review", scope: "task:review", body: { summary: "cross-tenant review" } },
      { method: "POST", suffix: "/notes", scope: "task:log", body: { detail: "cross-tenant note" } },
    ];
    for (const operation of agentOperations) {
      const url = `${resource}/tasks/${task.id}${operation.suffix}`;
      const authority = await realmrootAgentAuthority({
        agentId: "rr-cross-tenant-agent",
        scope: operation.scope,
        htu: url,
        htm: operation.method,
      });
      const response = await api.fetch(
        new Request(url, {
          method: operation.method,
          headers: { authorization: `DPoP ${authority.accessToken}`, dpop: authority.proof, "content-type": "application/json" },
          ...(operation.body === undefined ? {} : { body: JSON.stringify(operation.body) }),
        }),
        env(),
      );
      expect(response.status, `${operation.method} ${operation.suffix}`).toBe(404);
    }

    const human = await createTestWebSession(db, "tenant-a", { subjectId: "tenant-a-human" });
    const messageResponse = await api.fetch(
      new Request(`${resource}/tasks/${task.id}/messages`, {
        method: "POST",
        headers: { cookie: human.cookie, "x-csrf-token": human.csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ sender_type: "human", sender_id: "tenant-a-human", content: "cross-tenant" }),
      }),
      env(),
    );
    expect(messageResponse.status).toBe(404);

    const sseResponse = await api.fetch(
      new Request(`${resource}/tasks/${task.id}/stream`, {
        headers: { cookie: human.cookie, "Last-Event-ID": "foreign-event-id" },
      }),
      env(),
    );
    expect(sseResponse.status).toBe(404);

    const { updateBoard } = await import("../apps/web/server/boardRepo");
    await updateBoard(db, board.id, "tenant-b", { labels: [{ name: "security", color: "#22D3EE", description: "" }] });
    for (const operation of [
      { method: "GET", suffix: "", body: undefined },
      { method: "PATCH", suffix: "", body: { name: "cross-tenant board update" } },
      { method: "POST", suffix: "/labels", body: { name: "forbidden", color: "#22D3EE" } },
      { method: "PATCH", suffix: "/labels/security", body: { color: "#FFFFFF" } },
      { method: "DELETE", suffix: "/labels/security", body: undefined },
      { method: "DELETE", suffix: "", body: undefined },
    ]) {
      const response = await api.fetch(
        new Request(`${resource}/boards/${board.id}${operation.suffix}`, {
          method: operation.method,
          headers: {
            cookie: human.cookie,
            ...(operation.method === "GET" ? {} : { "x-csrf-token": human.csrfToken }),
            "content-type": "application/json",
          },
          ...(operation.body === undefined ? {} : { body: JSON.stringify(operation.body) }),
        }),
        env(),
      );
      expect(response.status, `board ${operation.method} ${operation.suffix}`).toBe(404);
    }

    const { createRepository } = await import("../apps/web/server/repositoryRepo");
    const foreignRepository = await createRepository(db, "tenant-b", {
      name: "Tenant B repository",
      url: "https://github.com/tenant-b/repository",
    });
    const deleteRepositoryResponse = await api.fetch(
      new Request(`${resource}/repositories/${foreignRepository.id}`, {
        method: "DELETE",
        headers: { cookie: human.cookie, "x-csrf-token": human.csrfToken },
      }),
      env(),
    );
    expect(deleteRepositoryResponse.status).toBe(404);
    expect(await db.prepare("SELECT id FROM repositories WHERE id = ?").bind(foreignRepository.id).first()).toEqual({ id: foreignRepository.id });
  });
});

async function realmrootAgentAuthority(input: { agentId?: string; clientId?: string; scope: string; htu: string; htm?: string }) {
  const issuerKeys = await issuerKeysPromise;
  const issuerPublicJwk = await exportJWK(issuerKeys.publicKey);
  issuerPublicJwk.kid = "realmroot-resource-test-key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: RequestInfo | URL) => {
      const url = target instanceof Request ? target.url : String(target);
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`,
          jwks_uri: jwksUri,
          id_token_signing_alg_values_supported: ["ES256"],
        });
      }
      if (url === jwksUri) return Response.json({ keys: [issuerPublicJwk] });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const dpopKeys = await generateKeyPair("ES256", { extractable: true });
  const dpopPublicJwk = await exportJWK(dpopKeys.publicKey);
  const thumbprint = await calculateJwkThumbprint(dpopPublicJwk);
  const accessToken = await new SignJWT({
    scope: input.scope,
    client_id: input.clientId ?? "realmroot-cli",
    cnf: { jkt: thumbprint },
    act: { sub: input.agentId ?? "rr-agent-1", sub_profile: "ai_agent" },
    "urn:realmroot:params:oauth:org": "tenant-a",
  })
    .setProtectedHeader({ alg: "ES256", kid: issuerPublicJwk.kid, typ: "at+jwt" })
    .setIssuer(issuer)
    .setAudience(resource)
    .setSubject("controller-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(issuerKeys.privateKey);
  const proof = await new SignJWT({
    htu: input.htu,
    htm: input.htm ?? "POST",
    ath: createHash("sha256").update(accessToken).digest("base64url"),
  })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: dpopPublicJwk })
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .sign(dpopKeys.privateKey);
  return { accessToken, proof };
}
