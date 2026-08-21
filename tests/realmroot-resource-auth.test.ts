// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
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

describe("Realmroot Resource Server authorization", () => {
  it("denies a valid human session when no route authorization rule exists", async () => {
    await seedUser(db, "tenant-human", "human@example.test");
    const session = await createTestWebSession(db, "tenant-human");
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", authMiddleware);
    app.get("/api/unlisted-operation", (c) => c.json({ leaked: true }));

    const response = await app.fetch(new Request("https://ak.example.test/api/unlisted-operation", { headers: { cookie: session.cookie } }), env());

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("accepts an AK Ed25519 agent+jwt once and rejects its replay", async () => {
    const agent = await createAkAgentSession("tenant-a", "agent-ak-1", "worker");
    const token = await agent.sign();
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", authMiddleware);
    app.post("/api/tasks/:id/claim", (c) =>
      c.json({ ownerId: c.get("ownerId"), agentId: c.get("agentId"), sessionId: c.get("sessionId"), identityType: c.get("identityType") }),
    );
    const request = () =>
      new Request(`${resource}/tasks/task-1/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });

    const accepted = await app.fetch(request(), env());
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      ownerId: "tenant-a",
      agentId: "agent-ak-1",
      sessionId: agent.sessionId,
      identityType: "agent:worker",
    });

    const replay = await app.fetch(request(), env());
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: { code: "UNAUTHORIZED", message: "Replayed AK Agent token" } });
  });

  it.each([
    ["stale iat", { issuedAtOffset: -121, expirationOffset: 10 }],
    ["future iat", { issuedAtOffset: 31, expirationOffset: 60 }],
    ["lifetime over 120 seconds", { issuedAtOffset: 0, expirationOffset: 121 }],
    ["expiration over 150 seconds in the future", { issuedAtOffset: 30, expirationOffset: 151 }],
  ])("rejects an AK Agent token with %s", async (_label, timing) => {
    const agent = await createAkAgentSession("tenant-timing", `agent-${randomUUID()}`, "worker");
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", authMiddleware);
    app.post("/api/tasks/:id/claim", (c) => c.json({ accepted: true }));
    const now = Math.floor(Date.now() / 1000);

    const response = await app.fetch(
      new Request(`${resource}/tasks/task-1/claim`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await agent.sign({ issuedAt: now + timing.issuedAtOffset, expirationTime: now + timing.expirationOffset })}`,
        },
      }),
      env(),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHORIZED", message: "Invalid AK Agent token claims" } });
  });

  it("rejects an AK Agent token whose session is closed or unknown", async () => {
    const agent = await createAkAgentSession("tenant-a", "agent-closed", "worker");
    await db.prepare("UPDATE agent_sessions SET status = 'closed' WHERE id = ?").bind(agent.sessionId).run();
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", authMiddleware);
    app.post("/api/tasks/:id/claim", (c) => c.json({ accepted: true }));

    const response = await app.fetch(
      new Request(`${resource}/tasks/task-1/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${await agent.sign()}` },
      }),
      env(),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { message: "AK Agent session is not active" } });
  });

  it("derives scopes from the AK Agent kind instead of accepting token-provided scopes", async () => {
    const agent = await createAkAgentSession("tenant-a", "agent-worker", "worker");
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", authMiddleware);
    app.delete("/api/tasks/:id", (c) => c.json({ accepted: true }));

    const response = await app.fetch(
      new Request(`${resource}/tasks/task-1`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${await agent.sign({ extraClaims: { scope: "task:cancel" } })}` },
      }),
      env(),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN", message: "Missing scope: task:cancel" } });
  });

  it("rejects Realmroot Agent actor tokens because AK Agents use internal sessions", async () => {
    const authority = await realmrootAgentAuthority(`${resource}/tasks/task-1/claim`);
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", authMiddleware);
    app.post("/api/tasks/:id/claim", (c) => c.json({ accepted: true }));

    const response = await app.fetch(
      new Request(`${resource}/tasks/task-1/claim`, {
        method: "POST",
        headers: { authorization: `DPoP ${authority.accessToken}`, dpop: authority.proof },
      }),
      env(),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { message: "Realmroot Agent tokens are not accepted by AK" } });
  });

  it("prevents an AK Agent from updating another Agent's session usage", async () => {
    const agentA = await createAkAgentSession("tenant-a", "agent-usage-a", "worker");
    const agentB = await createAkAgentSession("tenant-a", "agent-usage-b", "worker");
    const { api } = await import("../apps/web/server/routes");
    const response = await api.fetch(
      new Request(`${resource}/agents/${agentB.agentId}/sessions/${agentB.sessionId}/usage`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${await agentA.sign()}`, "content-type": "application/json" },
        body: JSON.stringify({ input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0, cost_micro_usd: 3 }),
      }),
      env(),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { message: "Agent authority is bound to a different Session" } });
  });

  it("rejects cross-tenant task mutation, review, notes, messages, SSE, boards, and repositories", async () => {
    const agent = await createAkAgentSession("tenant-a", "cross-tenant-agent", "worker");
    const leader = await createAkAgentSession("tenant-a", "cross-tenant-leader", "leader");
    await seedUser(db, "tenant-b", "tenant-b@example.test");
    const { createBoard, updateBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const board = await createBoard(db, "tenant-b", "Tenant B board", "ops");
    const task = await createTask(db, "tenant-b", { title: "Tenant B task", board_id: board.id });
    const { api } = await import("../apps/web/server/routes");
    for (const operation of [
      { method: "PATCH", suffix: "", body: { title: "cross-tenant update" }, authority: agent },
      { method: "DELETE", suffix: "", body: undefined, authority: leader },
      { method: "POST", suffix: "/review", body: { summary: "cross-tenant review" }, authority: agent },
      { method: "POST", suffix: "/notes", body: { detail: "cross-tenant note" }, authority: agent },
    ]) {
      const response = await api.fetch(
        new Request(`${resource}/tasks/${task.id}${operation.suffix}`, {
          method: operation.method,
          headers: { authorization: `Bearer ${await operation.authority.sign()}`, "content-type": "application/json" },
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
      new Request(`${resource}/tasks/${task.id}/stream`, { headers: { cookie: human.cookie, "Last-Event-ID": "foreign-event-id" } }),
      env(),
    );
    expect(sseResponse.status).toBe(404);

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
    const repository = await createRepository(db, "tenant-b", {
      name: "Tenant B repository",
      url: "https://github.com/tenant-b/repository",
    });
    const deleteResponse = await api.fetch(
      new Request(`${resource}/repositories/${repository.id}`, {
        method: "DELETE",
        headers: { cookie: human.cookie, "x-csrf-token": human.csrfToken },
      }),
      env(),
    );
    expect(deleteResponse.status).toBe(404);
    expect(await db.prepare("SELECT id FROM repositories WHERE id = ?").bind(repository.id).first()).toEqual({ id: repository.id });
  });
});

async function createAkAgentSession(ownerId: string, agentId: string, kind: "worker" | "leader") {
  const existingOwner = await db.prepare("SELECT 1 FROM user WHERE id = ?").bind(ownerId).first();
  if (!existingOwner) await seedUser(db, ownerId, `${ownerId}@example.test`);
  const keys = await generateKeyPair("EdDSA", { extractable: true });
  const publicJwk = await exportJWK(keys.publicKey);
  if (!publicJwk.x) throw new Error("Agent test key has no x coordinate");
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO agents
        (id, owner_id, name, runtime, public_key, private_key, fingerprint, kind, username, created_at, updated_at)
       VALUES (?, ?, ?, 'codex', ?, '{}', ?, ?, ?, ?, ?)`,
    )
    .bind(agentId, ownerId, agentId, publicJwk.x, `fingerprint-${agentId}`, kind, agentId, now, now)
    .run();
  const { upsertMachine } = await import("../apps/web/server/machineRepo");
  const machine = await upsertMachine(db, ownerId, {
    name: `${agentId} machine`,
    os: "test",
    version: "1",
    device_id: `device-${agentId}`,
    runtimes: [],
  });
  const sessionId = `session-${agentId}`;
  await db
    .prepare(
      `INSERT INTO agent_sessions (id, agent_id, machine_id, status, public_key, delegation_proof, created_at)
       VALUES (?, ?, ?, 'active', ?, 'test-delegation', ?)`,
    )
    .bind(sessionId, agentId, machine.id, publicJwk.x, now)
    .run();
  return {
    agentId,
    sessionId,
    sign: async (options: { extraClaims?: Record<string, unknown>; issuedAt?: number; expirationTime?: number } = {}) =>
      new SignJWT({ sub: sessionId, aid: agentId, jti: randomUUID(), ...options.extraClaims })
        .setProtectedHeader({ alg: "EdDSA", typ: "agent+jwt" })
        .setAudience("https://ak.example.test")
        .setIssuedAt(options.issuedAt)
        .setExpirationTime(options.expirationTime ?? "1m")
        .sign(keys.privateKey),
  };
}

async function realmrootAgentAuthority(htu: string) {
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
    scope: "task:claim",
    client_id: "realmroot-cli",
    cnf: { jkt: thumbprint },
    act: { sub: "realmroot-agent", sub_profile: "ai_agent" },
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
    htu,
    htm: "POST",
    ath: createHash("sha256").update(accessToken).digest("base64url"),
  })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: dpopPublicJwk })
    .setJti(randomUUID())
    .setIssuedAt()
    .sign(dpopKeys.privateKey);
  return { accessToken, proof };
}
