// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api } from "../apps/web/server/routes";
import { createTestAgent, createTestEnv, createTestWebSession, seedUser, setupMiniflare } from "./helpers/db";

const env = createTestEnv();
let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let authority: Awaited<ReturnType<typeof createTestWebSession>>;
let boardId: string;

async function request(method: string, path: string, body?: unknown, authenticated = true) {
  const headers = new Headers({ "content-type": "application/json", host: "localhost:8788", "x-forwarded-proto": "http" });
  if (authenticated) {
    headers.set("cookie", authority.cookie);
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") headers.set("x-csrf-token", authority.csrfToken);
  }
  return api.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
}

beforeAll(async () => {
  ({ mf, db: env.DB } = await setupMiniflare());
  await seedUser(env.DB, "tenant-business", "business@example.test");
  authority = await createTestWebSession(env.DB, "tenant-business");
});

afterAll(async () => mf.dispose());

describe("Realmroot-authenticated business routes", () => {
  it("creates and lists only boards owned by the session tenant", async () => {
    await seedUser(env.DB, "tenant-other", "other@example.test");
    const { createBoard } = await import("../apps/web/server/boardRepo");
    await createBoard(env.DB, "tenant-other", "Other tenant", "ops");

    const created = await request("POST", "/api/boards", { name: "Realmroot board", type: "ops" });
    expect(created.status).toBe(201);
    boardId = ((await created.json()) as { id: string }).id;

    const listed = await request("GET", "/api/boards");
    expect(listed.status).toBe(200);
    const boards = (await listed.json()) as { id: string; name: string }[];
    expect(boards).toEqual(expect.arrayContaining([expect.objectContaining({ id: boardId, name: "Realmroot board" })]));
    expect(boards).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "Other tenant" })]));
  });

  it("keeps task read paths stable behind the Web Session", async () => {
    const { createTask } = await import("../apps/web/server/taskRepo");
    const task = await createTask(env.DB, "tenant-business", { title: "Realmroot task", board_id: boardId });
    const fetched = await request("GET", `/api/tasks/${task.id}`);
    expect(fetched.status).toBe(200);
    await expect(fetched.json()).resolves.toMatchObject({ id: task.id, title: "Realmroot task" });
  });

  it("preserves board lookup, update, not-found, and delete semantics", async () => {
    const found = await request("GET", "/api/boards?name=Realmroot%20board");
    expect(found.status).toBe(200);
    await expect(found.json()).resolves.toMatchObject({ id: boardId, name: "Realmroot board" });

    const updated = await request("PATCH", `/api/boards/${boardId}`, { name: "Realmroot board updated" });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ id: boardId, name: "Realmroot board updated" });

    const unknown = await request("PATCH", "/api/boards/unknown-board", { name: "Missing" });
    expect(unknown.status).toBe(404);

    const temporary = await request("POST", "/api/boards", { name: "Temporary Realmroot board", type: "ops" });
    const temporaryId = ((await temporary.json()) as { id: string }).id;
    const deleted = await request("DELETE", `/api/boards/${temporaryId}`);
    expect(deleted.status).toBe(200);
    expect((await request("GET", `/api/boards/${temporaryId}`)).status).toBe(404);
  });

  it.each(["GET", "POST", "PATCH", "DELETE"])("default-denies unknown board subresources for %s", async (method) => {
    const response = await request(method, `/api/boards/${boardId}/future`, method === "GET" ? undefined : {});
    expect(response.status).toBe(403);
  });

  it.each(["GET", "POST", "PATCH", "DELETE"])("default-denies unknown maintainer subresources for %s", async (method) => {
    const response = await request(method, `/api/boards/${boardId}/maintainers/unknown/future`, method === "GET" ? undefined : {});
    expect(response.status).toBe(403);
  });

  it("preserves tenant-scoped repository CRUD, filtering, and validation", async () => {
    const created = await request("POST", "/api/repositories", {
      name: "Realmroot repository",
      url: "https://github.com/example/realmroot-repository",
    });
    expect(created.status).toBe(201);
    const repository = (await created.json()) as { id: string; name: string; url: string };

    const filtered = await request("GET", `/api/repositories?url=${encodeURIComponent(repository.url)}`);
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toEqual([expect.objectContaining({ id: repository.id, name: repository.name })]);

    const invalid = await request("POST", "/api/repositories", { name: "Local", url: "file:///tmp/repository" });
    expect(invalid.status).toBe(400);

    const deleted = await request("DELETE", `/api/repositories/${repository.id}`);
    expect(deleted.status).toBe(200);
    expect((await request("GET", `/api/repositories/${repository.id}`)).status).toBe(404);
  });

  it("rejects write requests without a Realmroot authority", async () => {
    const response = await request("POST", "/api/boards", { name: "Unauthorized", type: "ops" }, false);
    expect(response.status).toBe(401);
  });

  it("keeps Realmroot Agent bindings immutable across profile upserts", async () => {
    const agent = await createTestAgent(env.DB, "tenant-business", {
      username: "immutable-binding-agent",
      runtime: "claude",
      realmroot_agent_id: "realmroot-agent-original",
      realmroot_credential_ref: "ama://vaults/vault-business/credentials/original",
    });

    const response = await request("POST", "/api/agents", {
      username: agent.username,
      runtime: "claude",
      realmroot_agent_id: "realmroot-agent-replacement",
      realmroot_credential_ref: "ama://vaults/vault-business/credentials/replacement",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { message: "Realmroot Agent bindings are immutable; create a new Agent identity instead" },
    });
  });

  it("rejects Agent session operations across Realmroot tenant and Agent boundaries", async () => {
    const tenantAgent = await createTestAgent(env.DB, "tenant-business", {
      username: "session-owner-agent",
      runtime: "claude",
    });
    const otherTenantAgent = await createTestAgent(env.DB, "tenant-other", {
      username: "other-tenant-session-agent",
      runtime: "claude",
    });
    const otherAgent = await createTestAgent(env.DB, "tenant-business", {
      username: "other-session-agent",
      runtime: "claude",
    });
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO ama_agent_sessions
          (id, owner_id, agent_id, ama_session_id, status, public_key, delegation_proof, created_at)
         VALUES ('foreign-session', 'tenant-business', ?, 'ama-foreign-session', 'active', 'public', 'proof', ?)`,
    )
      .bind(tenantAgent.id, now)
      .run();

    for (const [method, path, body] of [
      ["POST", `/api/agents/${otherTenantAgent.id}/sessions`, { session_id: "cross-tenant", session_public_key: "public" }],
      ["GET", `/api/agents/${otherTenantAgent.id}/sessions`, undefined],
      ["DELETE", `/api/agents/${otherAgent.id}/sessions/foreign-session`, undefined],
      ["POST", `/api/agents/${otherAgent.id}/sessions/foreign-session/reopen`, undefined],
    ] as const) {
      const response = await request(method, path, body);
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });
});
