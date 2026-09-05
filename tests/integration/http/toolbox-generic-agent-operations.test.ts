// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
import { storeWebSessionGrant } from "@server/adapters/realmroot/delegatedAgencyToken";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoard } from "../../../server/adapters/d1/boardRepo";
import { createRepository } from "../../../server/adapters/d1/repositoryRepo";
import { addTaskAction, createTask } from "../../../server/adapters/d1/taskRepo";
import { d1TaskReviewSubmissionRepository } from "../../../server/adapters/d1/tasks/d1TaskReviewSubmissions";
import type { Env } from "../../../server/env";
import { api } from "../../../server/http/app";
import { replaceTaskReviewSubmission } from "../../../server/usecases/tasks/replaceTaskReviewSubmission";
import { createTestEnv, createTestWebSession, seedUser, setupMiniflare } from "../../helpers/db";

const issuer = "https://id.realmroot.dev/api/auth";
const resource = "https://ak.toolbox.test/api";
const jwksUri = `${issuer}/jwks`;
const issuerKeysPromise = generateKeyPair("ES256", { extractable: true });
const tenantId = "tenant-toolbox-generic";
const foreignTenantId = "tenant-toolbox-foreign";
const inboxResource = "https://inbox.test/api";

let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let db: D1Database;
let env: Env;
let inboxMessageRequests: Request[];
let sessionMessageRequests: Request[];

beforeEach(async () => {
  ({ mf, db } = await setupMiniflare());
  env = { ...createTestEnv(), DB: db, AK_PUBLIC_ORIGIN: new URL(resource).origin } as Env;
  inboxMessageRequests = [];
  sessionMessageRequests = [];
  await seedUser(db, tenantId, "toolbox-generic@example.test");
  await seedUser(db, foreignTenantId, "toolbox-foreign@example.test");
  const browser = await createTestWebSession(db, tenantId, { subjectId: "controller-toolbox" });
  await storeWebSessionGrant(env, browser.id, { access_token: "user-ak-token", refresh_token: "user-refresh", expires_in: 300 });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await mf.dispose();
});

describe("Realmroot Agent generic Toolbox operations", () => {
  it("[spec: tasks/user-authorization] requires the Agent controller to log in before Task creation", async () => {
    const board = await createBoard(db, tenantId, "User authorization", "ops");
    await db.prepare("DELETE FROM realmroot_user_grants WHERE tenant_id = ?").bind(tenantId).run();
    // Another member's grant must not authorize this Agent's controller.
    const other = await createTestWebSession(db, tenantId, { subjectId: "another-user" });
    await storeWebSessionGrant(env, other.id, { access_token: "other-token", refresh_token: "other-refresh", expires_in: 300 });
    const denied = await request("POST", "/tasks", "task:write", { title: "Requires login", boardId: board.id });
    expect(denied.status).toBe(409);
    await expect(denied.json()).resolves.toMatchObject({
      type: expect.stringMatching(/user-login-required$/),
      detail: expect.stringContaining("sign in to Agent Kanban in a web browser"),
    });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE board_id = ?").bind(board.id).first()).resolves.toEqual({ count: 0 });
    const browser = await createTestWebSession(db, tenantId, { subjectId: "controller-toolbox" });
    await storeWebSessionGrant(env, browser.id, { access_token: "user-token", refresh_token: "user-refresh", expires_in: 300 });
    const created = await request("POST", "/tasks", "task:write", { title: "Authorized", boardId: board.id });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({ metadata: { "agent-kanban.dev/authorization-subject": "controller-toolbox" } });
  });
  it("[spec: tasks/scheduling-not-supported] rejects scheduled creation and updates without writing a Task or schedule", async () => {
    const board = await createBoard(db, tenantId, "Scheduling unsupported", "ops");
    for (const scheduledAt of ["2030-01-01T00:00:00Z", "2000-01-01T00:00:00Z"]) {
      const rejected = await request("POST", "/tasks", "task:write", { title: "Unsupported schedule", boardId: board.id, scheduledAt });
      expect(rejected.status).toBe(422);
      await expect(rejected.json()).resolves.toMatchObject({ detail: expect.stringContaining("Delayed task scheduling is not implemented") });
    }
    await expect(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE board_id = ?").bind(board.id).first()).resolves.toEqual({ count: 0 });
    const created = await request("POST", "/tasks", "task:write", { title: "Unscheduled Task", boardId: board.id });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string };
    const patchSchedule = async (scheduledAt: string | null) => {
      const url = `${resource}/tasks/${task.id}`;
      const authority = await realmrootAgentAuthority(url, "PATCH", "task:write", "actor-toolbox");
      return api.fetch(
        new Request(url, {
          method: "PATCH",
          headers: {
            authorization: `DPoP ${authority.accessToken}`,
            dpop: authority.proof,
            "API-Version": "2026-08-29",
            "content-type": "application/merge-patch+json",
          },
          body: JSON.stringify({ scheduledAt }),
        }),
        env,
      );
    };
    const rejected = await patchSchedule("2030-01-01T00:00:00Z");
    expect(rejected.status).toBe(422);
    await expect(rejected.json()).resolves.toMatchObject({ detail: expect.stringContaining("Delayed task scheduling is not implemented") });
    await expect(db.prepare("SELECT scheduled_at, version FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({
      scheduled_at: null,
      version: 1,
    });
    await db.prepare("UPDATE tasks SET scheduled_at = '2030-01-01T00:00:00Z' WHERE id = ?").bind(task.id).run();
    const cleared = await patchSchedule(null);
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({ scheduledAt: null });
  });

  it.each([
    ["PUT", "/task-assignments/task-id"],
    ["PUT", "/task-claims/task-id"],
    ["DELETE", "/task-claims/task-id"],
    ["GET", "/task-review-submissions/task-id"],
    ["PUT", "/task-review-submissions/task-id"],
    ["PUT", "/task-review-rejections/task-id"],
    ["PUT", "/task-review-completions/task-id"],
    ["PUT", "/task-cancellations/task-id"],
    ["GET", "/task-events?taskId=task-id&until=done"],
  ] as const)("returns 404 for the removed legacy Task workflow operation %s %s", async (method, path) => {
    const response = await request(method, path, "task:read");

    expect(response.status).toBe(404);
  });
  it("rejects schema-invalid resource writes without durable side effects", async () => {
    const board = await createBoard(db, tenantId, "Schema validation board", "ops");
    const noteParent = await createTask(db, tenantId, { title: "Schema validation note parent", board_id: board.id });
    const before = await Promise.all([
      db.prepare("SELECT COUNT(*) AS count FROM boards WHERE owner_id = ?").bind(tenantId).first<{ count: number }>(),
      db.prepare("SELECT COUNT(*) AS count FROM repositories WHERE owner_id = ?").bind(tenantId).first<{ count: number }>(),
      db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE board_id = ?").bind(board.id).first<{ count: number }>(),
      db.prepare("SELECT COUNT(*) AS count FROM task_actions WHERE task_id = ?").bind(noteParent.id).first<{ count: number }>(),
    ]);

    for (const [path, scope, body] of [
      ["/boards", "board:write", { name: 42, type: "ops" }],
      ["/repositories", "repository:write", { name: 42, url: "https://github.com/example/schema-invalid.git" }],
      ["/tasks", "task:write", { title: 42, boardId: board.id }],
      ["/tasks", "task:write", { title: "Array input", boardId: board.id, input: [] }],
      ["/tasks", "task:write", { title: "Null schedule", boardId: board.id, scheduledAt: null }],
      [`/tasks/${noteParent.id}/notes`, "task:write", { detail: { text: "not a string" } }],
    ] as const) {
      const response = await request("POST", path, scope, body);
      expect([400, 422], `${path} ${JSON.stringify(body)}`).toContain(response.status);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      await expect(response.json()).resolves.toMatchObject({ status: response.status, type: expect.stringContaining("/problems/") });
    }

    await expect(
      Promise.all([
        db.prepare("SELECT COUNT(*) AS count FROM boards WHERE owner_id = ?").bind(tenantId).first(),
        db.prepare("SELECT COUNT(*) AS count FROM repositories WHERE owner_id = ?").bind(tenantId).first(),
        db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE board_id = ?").bind(board.id).first(),
        db.prepare("SELECT COUNT(*) AS count FROM task_actions WHERE task_id = ?").bind(noteParent.id).first(),
      ]),
    ).resolves.toEqual(before);
    await expect(db.prepare("SELECT COUNT(*) AS count FROM resource_idempotency_records").first()).resolves.toEqual({ count: 0 });
  });

  it("coalesces concurrent same-key Task POSTs into one durable response snapshot", async () => {
    const board = await createBoard(db, tenantId, "Concurrent idempotency board", "ops");
    const key = "concurrent-task-create";
    const body = { title: "Concurrent idempotent Task", boardId: board.id };

    const responses = await Promise.all(Array.from({ length: 8 }, () => request("POST", "/tasks", "task:write", body, true, "2026-08-29", key)));
    expect(responses.map((response) => response.status)).toEqual(Array.from({ length: 8 }, () => 201));

    const snapshot = await db
      .prepare(
        `SELECT resource_id, response_status, response_body, response_location, response_etag
         FROM resource_idempotency_records
         WHERE owner_id = ? AND actor_id = ? AND api_version = ? AND idempotency_key = ?`,
      )
      .bind(tenantId, "actor-toolbox", "2026-08-29", key)
      .first<{
        resource_id: string;
        response_status: number;
        response_body: string;
        response_location: string;
        response_etag: string;
      }>();
    expect(snapshot).not.toBeNull();
    for (const response of responses) {
      expect(response.status).toBe(snapshot?.response_status);
      expect(await response.text()).toBe(snapshot?.response_body);
      expect(response.headers.get("Location")).toBe(snapshot?.response_location);
      expect(response.headers.get("ETag")).toBe(snapshot?.response_etag);
    }
    expect(responses.filter((response) => response.headers.get("Idempotency-Replayed") === null)).toHaveLength(1);
    expect(responses.filter((response) => response.headers.get("Idempotency-Replayed") === "true")).toHaveLength(7);

    await expect(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE board_id = ?").bind(board.id).first()).resolves.toEqual({ count: 1 });
    await expect(
      db.prepare("SELECT COUNT(*) AS count FROM task_actions WHERE task_id = ? AND action = 'created'").bind(snapshot?.resource_id).first(),
    ).resolves.toEqual({ count: 1 });
    await expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM resource_idempotency_records WHERE owner_id = ? AND actor_id = ? AND api_version = ? AND idempotency_key = ?",
        )
        .bind(tenantId, "actor-toolbox", "2026-08-29", key)
        .first(),
    ).resolves.toEqual({ count: 1 });
  });

  it.each(["human", "agent"] as const)("rejects a Bearer %s Resource token while accepting valid DPoP", async (principalType) => {
    const bearerToken = await realmrootBearerToken(principalType);
    const bearer = await api.fetch(
      new Request(`${resource}/boards`, {
        headers: { authorization: `Bearer ${bearerToken}`, "API-Version": "2026-08-29" },
      }),
      env,
    );

    expect(bearer.status).toBe(401);
    await expect(bearer.json()).resolves.toMatchObject({
      type: `${resource}/problems/authentication-required`,
      title: "Authentication required",
      status: 401,
      detail: "Realmroot Resource token requires DPoP",
      instance: expect.stringMatching(/^urn:request:/),
    });

    const dpop = await request("GET", "/boards", "board:read");
    expect(dpop.status, await dpop.clone().text()).toBe(200);
  });

  it.each(["ak_legacy", "opaque-resource-token"])("returns RFC 9457 authentication failure for non-JWT Bearer token %s", async (token) => {
    const response = await api.fetch(
      new Request(`${resource}/boards`, {
        headers: { authorization: `Bearer ${token}`, "API-Version": "2026-08-29" },
      }),
      env,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).toContain("application/problem+json");
    await expect(response.json()).resolves.toMatchObject({
      type: `${resource}/problems/authentication-required`,
      title: "Authentication required",
      status: 401,
      detail: "Invalid OIDC access token",
      instance: expect.stringMatching(/^urn:request:/),
    });
  });

  it("returns a 5xx Problem for OIDC discovery and signing-key failures while malformed credentials remain 401", async () => {
    const url = `${resource}/boards`;
    const dependencyIssuer = `https://id-dependency-${randomUUID()}.test/api/auth`;
    const dependencyJwksUri = `${dependencyIssuer}/jwks`;
    env = { ...env, OIDC_ISSUER: dependencyIssuer };
    const authority = await realmrootAgentAuthority(url, "GET", "board:read", "actor-toolbox", {
      issuer: dependencyIssuer,
      jwksUri: dependencyJwksUri,
    });
    const requestWithAuthority = () =>
      api.fetch(
        new Request(url, {
          headers: {
            authorization: `DPoP ${authority.accessToken}`,
            dpop: authority.proof,
            "API-Version": "2026-08-29",
          },
        }),
        env,
      );

    const unavailableFetch = vi.fn(async () => Promise.reject(new Error("discovery unavailable sentinel")));
    vi.stubGlobal("fetch", unavailableFetch);
    const malformedCompact = await api.fetch(new Request(url, { headers: { authorization: "Bearer aaa.bbb.ccc" } }), env);
    expect(malformedCompact.status).toBe(401);
    await expect(malformedCompact.json()).resolves.toMatchObject({
      type: `${resource}/problems/authentication-required`,
      status: 401,
      detail: "Invalid OIDC access token",
    });
    expect(unavailableFetch).not.toHaveBeenCalled();

    const discoveryFailure = await requestWithAuthority();
    expect(discoveryFailure.status).toBe(500);
    await expect(discoveryFailure.json()).resolves.toMatchObject({
      type: `${resource}/problems/internal-error`,
      status: 500,
      detail: "The server could not complete the request",
    });

    const invalidMetadata = [
      { name: "null document", value: null },
      {
        name: "wrong-type endpoint",
        value: {
          issuer: "replace-at-request-time",
          authorization_endpoint: 42,
          token_endpoint: "https://id.example.test/token",
          jwks_uri: "https://id.example.test/jwks",
        },
      },
      {
        name: "invalid endpoint URL",
        value: {
          issuer: "replace-at-request-time",
          authorization_endpoint: "not-an-absolute-url",
          token_endpoint: "https://id.example.test/token",
          jwks_uri: "https://id.example.test/jwks",
        },
      },
      {
        name: "non-HTTPS endpoint",
        value: {
          issuer: "replace-at-request-time",
          authorization_endpoint: "http://id.example.test/authorize",
          token_endpoint: "https://id.example.test/token",
          jwks_uri: "https://id.example.test/jwks",
        },
      },
      {
        name: "empty algorithms",
        value: {
          issuer: "replace-at-request-time",
          authorization_endpoint: "https://id.example.test/authorize",
          token_endpoint: "https://id.example.test/token",
          jwks_uri: "https://id.example.test/jwks",
          id_token_signing_alg_values_supported: [],
        },
      },
      {
        name: "only unsafe algorithms",
        value: {
          issuer: "replace-at-request-time",
          authorization_endpoint: "https://id.example.test/authorize",
          token_endpoint: "https://id.example.test/token",
          jwks_uri: "https://id.example.test/jwks",
          id_token_signing_alg_values_supported: ["none", "HS256"],
        },
      },
    ] as const;
    for (const invalid of invalidMetadata) {
      const metadataIssuer = `https://id-metadata-${randomUUID()}.test/api/auth`;
      env = { ...env, OIDC_ISSUER: metadataIssuer };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const target = input instanceof Request ? input.url : String(input);
          expect(target, invalid.name).toBe(`${metadataIssuer}/.well-known/openid-configuration`);
          const value = invalid.value && typeof invalid.value === "object" ? { ...invalid.value, issuer: metadataIssuer } : invalid.value;
          return Response.json(value);
        }),
      );

      const response = await requestWithAuthority();
      expect(response.status, invalid.name).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        type: `${resource}/problems/internal-error`,
        status: 500,
        detail: "The server could not complete the request",
      });
    }

    env = { ...env, OIDC_ISSUER: dependencyIssuer };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const target = input instanceof Request ? input.url : String(input);
        if (target === `${dependencyIssuer}/.well-known/openid-configuration`) {
          return Response.json({
            issuer: dependencyIssuer,
            authorization_endpoint: `${dependencyIssuer}/oauth2/authorize`,
            token_endpoint: `${dependencyIssuer}/oauth2/token`,
            jwks_uri: dependencyJwksUri,
          });
        }
        if (target === dependencyJwksUri) return new Response(null, { status: 503 });
        throw new Error(`Unexpected request: ${target}`);
      }),
    );
    const jwksFailure = await requestWithAuthority();
    expect(jwksFailure.status).toBe(500);
    await expect(jwksFailure.json()).resolves.toMatchObject({
      type: `${resource}/problems/internal-error`,
      status: 500,
      detail: "The server could not complete the request",
    });
  });

  it.each(["boards", "repositories"] as const)(
    "[spec: resource-server/generic-operations] creates %s without an Idempotency-Key",
    async (resourceKind) => {
      const fixture = await creationFixture(resourceKind);
      const before = await fixture.count();

      const created = await request("POST", fixture.path, fixture.scope, fixture.body, true, "2026-08-29", null);

      expect(created.status, await created.clone().text()).toBe(201);
      await expect(fixture.count()).resolves.toBe(before + 1);
    },
  );

  it.each(["tasks", "notes"] as const)(
    "[spec: resource-server/generic-operations] requires and replays an RFC 8941 Idempotency-Key without duplicating %s creations",
    async (resourceKind) => {
      const fixture = await creationFixture(resourceKind);
      const before = await fixture.count();

      const missing = await request("POST", fixture.path, fixture.scope, fixture.body, true, "2026-08-29", null);
      expect(missing.status).toBe(400);
      await expect(missing.json()).resolves.toMatchObject({ type: expect.stringContaining("idempotency-key-required") });
      await expect(fixture.count()).resolves.toBe(before);

      const invalidRaw = await request("POST", fixture.path, fixture.scope, fixture.body, true, "2026-08-29", "unquoted-key", "actor-toolbox", false);
      expect(invalidRaw.status).toBe(400);
      await expect(invalidRaw.json()).resolves.toMatchObject({ type: expect.stringContaining("invalid-idempotency-key") });
      await expect(fixture.count()).resolves.toBe(before);

      const key = `generic-${resourceKind}-same-key`;
      const created = await request("POST", fixture.path, fixture.scope, fixture.body, true, "2026-08-29", key);
      expect(created.status, await created.clone().text()).toBe(201);
      const createdBody = await created.clone().text();
      const createdHeaders = {
        location: created.headers.get("Location"),
        etag: created.headers.get("ETag"),
      };
      expect(createdHeaders.location).toMatch(/^https:\/\/ak\.toolbox\.test\/api\//);
      expect(createdHeaders.etag).toMatch(/^".+"$/);
      const expectedCount = await mutateCreatedResource(resourceKind, (JSON.parse(createdBody) as { id: string }).id, before);

      const replayed = await request("POST", fixture.path, fixture.scope, fixture.body, true, "2026-08-29", key);
      expect(replayed.status).toBe(201);
      expect(await replayed.text()).toBe(createdBody);
      expect({ location: replayed.headers.get("Location"), etag: replayed.headers.get("ETag") }).toEqual(createdHeaders);
      expect(replayed.headers.get("Idempotency-Replayed")).toBe("true");
      await expect(fixture.count()).resolves.toBe(expectedCount);

      const conflict = await request("POST", fixture.path, fixture.scope, fixture.conflictingBody, true, "2026-08-29", key);
      expect(conflict.status).toBe(422);
      await expect(conflict.json()).resolves.toMatchObject({ type: expect.stringContaining("idempotency-key-conflict") });
      await expect(fixture.count()).resolves.toBe(expectedCount);
    },
  );

  it("replays the same idempotent creation across token and browser Session authentication", async () => {
    const board = await createBoard(db, tenantId, "Cross-auth idempotency", "ops");
    const body = { title: "Cross-auth Task", boardId: board.id };
    const key = "cross-auth-same-request";
    const session = await createTestWebSession(db, tenantId, { subjectId: "actor-toolbox", scopes: ["task:write"] });

    const created = await request("POST", "/tasks", "task:write", body, true, "2026-08-29", key);
    const deniedReplay = await request("POST", "/tasks", "task:read", body, true, "2026-08-29", key);
    const replayed = await browserMutation(session, "POST", "/tasks", body, key);

    expect(created.status, await created.clone().text()).toBe(201);
    expect(deniedReplay.status).toBe(403);
    expect(deniedReplay.headers.get("Idempotency-Replayed")).toBeNull();
    await expect(deniedReplay.json()).resolves.toMatchObject({ detail: "Missing scope: task:write" });
    expect(replayed.status, await replayed.clone().text()).toBe(201);
    expect(replayed.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replayed.text()).toBe(await created.text());
    await expect(
      db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE board_id = ? AND title = ?").bind(board.id, body.title).first(),
    ).resolves.toEqual({
      count: 1,
    });
  });

  it("returns canonical paginated resources identically to tokens and browser Sessions", async () => {
    const firstBoard = await createBoard(db, tenantId, "Collection board one", "ops");
    const secondBoard = await createBoard(db, tenantId, "Collection board two", "ops");
    const repository = await createRepository(db, tenantId, { name: "collection-repository", url: "https://github.com/example/collection.git" });
    const task = await createTask(db, tenantId, { title: "Collection Task", board_id: firstBoard.id });
    await db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").bind(task.id).run();
    const note = await addTaskAction(db, task.id, "realmroot:agent", "actor-toolbox", "commented", "Collection note");

    const firstPage = await request("GET", "/boards?pageSize=1", "board:read");
    expect(firstPage.status).toBe(200);
    const firstPageBody = (await firstPage.json()) as {
      items: Array<Record<string, unknown>>;
      pagination: { pageSize: number; nextPageToken?: string };
    };
    expect(firstPageBody.items).toHaveLength(1);
    expect(firstPageBody.pagination.nextPageToken).toEqual(expect.any(String));
    expect(firstPageBody.pagination.pageSize).toBe(1);
    expect(firstPage.headers.get("Link")).toContain('rel="next"');
    expect(firstPageBody.items[0]).toHaveProperty("createdAt");
    expect(firstPageBody.items[0]).not.toHaveProperty("created_at");

    const secondPage = await request("GET", `/boards?pageSize=1&pageToken=${firstPageBody.pagination.nextPageToken}`, "board:read");
    const secondPageBody = (await secondPage.json()) as { items: Array<{ id: string }> };
    expect(secondPageBody.items).toHaveLength(1);
    expect(secondPageBody.items[0].id).not.toBe(firstPageBody.items[0].id);

    const tampered = await request("GET", `/boards?pageToken=${firstPageBody.pagination.nextPageToken}x`, "board:read");
    expect(tampered.status).toBe(400);
    const crossActor = await request(
      "GET",
      `/boards?pageToken=${firstPageBody.pagination.nextPageToken}`,
      "board:read",
      undefined,
      true,
      "2026-08-29",
      null,
      "actor-other",
    );
    expect(crossActor.status).toBe(400);

    for (const [path, scope] of [
      ["/repositories", "repository:read"],
      ["/tasks?status=in-progress", "task:read"],
      [`/tasks/${task.id}/notes`, "task:read"],
    ] as const) {
      const response = await request("GET", path, scope);
      expect(response.status, path).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ items: expect.any(Array), pagination: { pageSize: expect.any(Number) } });
    }
    const agentTasks = await request("GET", "/tasks?status=in-progress", "task:read");
    await expect(agentTasks.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ id: task.id, boardId: firstBoard.id, status: "in-progress" })],
    });
    const agentNotes = await request("GET", `/tasks/${task.id}/notes`, "task:read");
    await expect(agentNotes.json()).resolves.toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ taskId: task.id })]) });

    const session = await createTestWebSession(db, tenantId);
    for (const [path, scope] of [
      ["/boards", "board:read"],
      ["/repositories", "repository:read"],
      ["/tasks?status=in-progress", "task:read"],
      [`/tasks/${task.id}/notes`, "task:read"],
      [`/boards/${firstBoard.id}`, "board:read"],
      [`/repositories/${repository.id}`, "repository:read"],
      [`/tasks/${task.id}`, "task:read"],
      [`/tasks/${task.id}/notes/${note.id}`, "task:read"],
    ] as const) {
      const tokenResponse = await request("GET", path, scope);
      const sessionResponse = await browserRequest(session, path);
      expect(sessionResponse.status, path).toBe(tokenResponse.status);
      expect(await sessionResponse.json(), path).toEqual(await tokenResponse.json());
    }
    expect([firstBoard.id, secondBoard.id]).toHaveLength(2);
  });

  it("[spec: resource-server/generic-operations] [spec: tasks/wait] defaults API-Version and signs pagination and Task Event cursors independently of the Web secret", async () => {
    const boardResponse = await request("POST", "/boards", "board:write", { name: "Default version board", type: "ops" }, false, "2026-08-29", null);
    expect(boardResponse.status, await boardResponse.clone().text()).toBe(201);
    const boardId = (await boardResponse.json<{ id: string }>()).id;
    const key = "default-version-idempotency";
    const createBody = { title: "Default version Task", boardId };
    const created = await request("POST", "/tasks", "task:write", createBody, false, "2026-08-29", key);
    expect(created.status, await created.clone().text()).toBe(201);
    expect(created.headers.get("API-Version")).toBe("2026-08-29");
    const replayed = await request("POST", "/tasks", "task:write", createBody, true, "2026-08-29", key);
    expect(replayed.status).toBe(201);
    expect(replayed.headers.get("Idempotency-Replayed")).toBe("true");
    await expect(
      db
        .prepare("SELECT api_version, request_hash FROM resource_idempotency_records WHERE owner_id = ? AND actor_id = ? AND idempotency_key = ?")
        .bind(tenantId, "actor-toolbox", key)
        .first(),
    ).resolves.toMatchObject({ api_version: "2026-08-29", request_hash: expect.any(String) });

    await createBoard(db, tenantId, "Default version second page", "ops");
    const firstPage = await request("GET", "/boards?pageSize=1", "board:read", undefined, false);
    const firstPageBody = (await firstPage.json()) as { pagination: { nextPageToken: string } };
    env = { ...env, OIDC_WEB_CLIENT_SECRET: "rotated-web-secret" };
    const nextPage = await request(
      "GET",
      `/boards?pageSize=1&pageToken=${encodeURIComponent(firstPageBody.pagination.nextPageToken)}`,
      "board:read",
      undefined,
      false,
    );
    expect(nextPage.status, await nextPage.clone().text()).toBe(200);
    expect(nextPage.headers.get("API-Version")).toBe("2026-08-29");

    const task = await createTask(db, tenantId, { title: "Default version Task Event", board_id: boardId });
    await db.prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").bind(task.id).run();
    const event = await request("GET", `/tasks/${task.id}/events?until=in-review&waitSeconds=0`, "task:read", undefined, false);
    const eventBody = (await event.json()) as { cursor: string };
    env = { ...env, OIDC_WEB_CLIENT_SECRET: "rotated-web-secret-again" };
    const eventContinuation = await request(
      "GET",
      `/tasks/${task.id}/events?until=in-review&waitSeconds=0&cursor=${encodeURIComponent(eventBody.cursor)}`,
      "task:read",
      undefined,
      false,
    );
    expect(eventContinuation.status, await eventContinuation.clone().text()).toBe(200);
    expect(eventContinuation.headers.get("API-Version")).toBe("2026-08-29");
  });

  it("[spec: resource-server/generic-operations] surfaces an invalid AK_SIGNING_KEY during page-token decoding instead of reporting an invalid cursor", async () => {
    await createBoard(db, tenantId, "Signing key first board", "ops");
    await createBoard(db, tenantId, "Signing key second board", "ops");
    const firstPage = await request("GET", "/boards?pageSize=1", "board:read");
    const token = ((await firstPage.json()) as { pagination: { nextPageToken: string } }).pagination.nextPageToken;

    env = { ...env, AK_SIGNING_KEY: btoa("short") };
    const response = await request("GET", `/boards?pageSize=1&pageToken=${encodeURIComponent(token)}`, "board:read");

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      type: `${resource}/problems/internal-error`,
      status: 500,
      detail: "The server could not complete the request",
    });
  });

  it("[spec: tasks/notes-and-stream] returns only commented Notes and exposes one Agent Note with lowerCamel fields and ETag", async () => {
    const board = await createBoard(db, tenantId, "Task Note resources", "ops");
    const task = await createTask(db, tenantId, { title: "Task Note parent", board_id: board.id });
    const claim = await addTaskAction(db, task.id, "realmroot:agent", "actor-toolbox", "claimed", null, "agency-session");
    await addTaskAction(db, task.id, "realmroot:agent", "actor-toolbox", "review_requested", null, "agency-session");
    const note = await addTaskAction(db, task.id, "realmroot:agent", "actor-toolbox", "commented", "Only this is a Note", "agency-session");

    const collection = await request("GET", `/tasks/${task.id}/notes`, "task:read");
    expect(collection.status).toBe(200);
    await expect(collection.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ id: note.id, taskId: task.id, action: "commented" })],
      pagination: { pageSize: expect.any(Number) },
    });

    const single = await request("GET", `/tasks/${task.id}/notes/${note.id}`, "task:read");
    expect(single.status).toBe(200);
    expect(single.headers.get("ETag")).toBe(`"${note.id}"`);
    await expect(single.json()).resolves.toMatchObject({
      id: note.id,
      taskId: task.id,
      actorType: "realmroot:agent",
      actorId: "actor-toolbox",
      createdAt: expect.any(String),
    });

    const nonNote = await request("GET", `/tasks/${task.id}/notes/${claim.id}`, "task:read");
    expect(nonNote.status).toBe(404);
    await expect(nonNote.json()).resolves.toMatchObject({
      type: `${resource}/problems/request-rejected`,
      status: 404,
      detail: "Task Note not found",
    });
  });

  it("changes the parent Task ETag when a Task Note is created", async () => {
    const board = await createBoard(db, tenantId, "Task Note ETag", "ops");
    const task = await createTask(db, tenantId, { title: "Task Note ETag parent", board_id: board.id });
    const session = await createTestWebSession(db, tenantId, { subjectId: "task-note-author" });
    const before = await browserRequest(session, `/tasks/${task.id}`);
    const beforeEtag = before.headers.get("ETag");

    const created = await browserMutation(
      session,
      "POST",
      `/tasks/${task.id}/notes`,
      { detail: "This Note changes the Task representation" },
      "task-note-etag",
    );

    expect(created.status, await created.clone().text()).toBe(201);
    const after = await browserRequest(session, `/tasks/${task.id}`);
    expect(after.status).toBe(200);
    expect(after.headers.get("ETag")).not.toBe(beforeEtag);
  });

  it("changes the parent Task ETag when a createdFrom child is created and deleted", async () => {
    const board = await createBoard(db, tenantId, "Subtask parent ETag", "ops");
    const parent = await createTask(db, tenantId, { title: "Subtask parent", board_id: board.id });
    const session = await createTestWebSession(db, tenantId, { subjectId: "subtask-author" });
    const initialParent = await browserRequest(session, `/tasks/${parent.id}`);
    const initialEtag = initialParent.headers.get("ETag");

    const created = await browserMutation(
      session,
      "POST",
      "/tasks",
      { title: "Child Task", boardId: board.id, createdFrom: parent.id },
      "created-from-child",
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const child = (await created.json()) as { id: string };

    const afterCreate = await browserRequest(session, `/tasks/${parent.id}`);
    expect(afterCreate.headers.get("ETag")).not.toBe(initialEtag);
    const childCurrent = await browserRequest(session, `/tasks/${child.id}`);
    const deleted = await browserTaskDelete(session, child.id, childCurrent.headers.get("ETag")!);
    expect(deleted.status, await deleted.clone().text()).toBe(204);

    const afterDelete = await browserRequest(session, `/tasks/${parent.id}`);
    expect(afterDelete.headers.get("ETag")).not.toBe(afterCreate.headers.get("ETag"));
  });

  it("changes an associated Task ETag and clears its Repository projection when the Repository is deleted", async () => {
    const board = await createBoard(db, tenantId, "Repository deletion Task ETag", "dev");
    const repository = await createRepository(db, tenantId, {
      name: "deleted-repository",
      url: "https://github.com/example/deleted-repository.git",
    });
    const task = await createTask(db, tenantId, {
      title: "Repository-linked Task",
      board_id: board.id,
      repository_id: repository.id,
    });
    const session = await createTestWebSession(db, tenantId, { subjectId: "repository-deleter" });
    const before = await browserRequest(session, `/tasks/${task.id}`);
    expect(await before.clone().json()).toMatchObject({ repositoryId: repository.id, repositoryName: repository.name });
    const beforeEtag = before.headers.get("ETag");

    const deleted = await request("DELETE", `/repositories/${repository.id}`, "repository:write");

    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const after = await browserRequest(session, `/tasks/${task.id}`);
    expect(after.headers.get("ETag")).not.toBe(beforeEtag);
    expect(await after.json()).toMatchObject({ repositoryId: null, repositoryName: null });
  });

  it("changes a createdFrom child ETag and clears its parent reference when the parent Task is deleted", async () => {
    const board = await createBoard(db, tenantId, "Parent deletion child ETag", "ops");
    const parent = await createTask(db, tenantId, { title: "Deleted parent", board_id: board.id });
    const child = await createTask(db, tenantId, { title: "Surviving child", board_id: board.id, created_from: parent.id });
    const session = await createTestWebSession(db, tenantId, { subjectId: "parent-deleter" });
    const before = await browserRequest(session, `/tasks/${child.id}`);
    expect(await before.clone().json()).toMatchObject({ createdFrom: parent.id });
    const beforeEtag = before.headers.get("ETag");
    const parentCurrent = await browserRequest(session, `/tasks/${parent.id}`);

    const deleted = await browserTaskDelete(session, parent.id, parentCurrent.headers.get("ETag")!);

    expect(deleted.status, await deleted.clone().text()).toBe(204);
    const after = await browserRequest(session, `/tasks/${child.id}`);
    expect(after.headers.get("ETag")).not.toBe(beforeEtag);
    expect(await after.json()).toMatchObject({ createdFrom: null });
  });

  it("rejects a non-HTTP pullRequestUrl without writing and accepts an absolute HTTPS URL", async () => {
    const board = await createBoard(db, tenantId, "Task pull request URL", "ops");
    const task = await createTask(db, tenantId, { title: "Task pull request URL", board_id: board.id });
    const session = await createTestWebSession(db, tenantId, { subjectId: "pull-request-editor" });
    const before = await browserRequest(session, `/tasks/${task.id}`);
    const beforeEtag = before.headers.get("ETag")!;

    const invalid = await browserTaskPatch(session, task.id, { pullRequestUrl: "not-a-url" });

    expect(invalid.status).toBe(422);
    const unchanged = await browserRequest(session, `/tasks/${task.id}`);
    expect(unchanged.headers.get("ETag")).toBe(beforeEtag);
    expect(await unchanged.json()).toMatchObject({ pullRequestUrl: null });

    const pullRequestUrl = "https://github.com/example/repository/pull/42";
    const updated = await browserTaskPatch(session, task.id, { pullRequestUrl });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(updated.headers.get("ETag")).not.toBe(beforeEtag);
    await expect(updated.json()).resolves.toMatchObject({ pullRequestUrl });
  });

  it.each(["done", "cancelled"] as const)("changes a dependent Task ETag when its dependency becomes %s", async (terminalStatus) => {
    const board = await createBoard(db, tenantId, `Dependency ${terminalStatus} ETag`, "ops");
    const dependency =
      terminalStatus === "done"
        ? await reviewReadyTask(tenantId, board.id, "Review-ready dependency", "dependency-assignee")
        : await createTask(db, tenantId, { title: "Cancellable dependency", board_id: board.id });
    if (terminalStatus === "done") {
      await replaceTaskReviewSubmission(d1TaskReviewSubmissionRepository(db), {
        ownerId: tenantId,
        taskId: dependency.id,
        agentActorId: "dependency-assignee",
        pullRequestUrl: null,
      });
    }
    const dependent = await createTask(db, tenantId, {
      title: "Blocked dependent",
      board_id: board.id,
      depends_on: [dependency.id],
    });
    const session = await createTestWebSession(db, tenantId, { subjectId: "dependency-reviewer" });
    const before = await browserRequest(session, `/tasks/${dependent.id}`);
    expect(await before.clone().json()).toMatchObject({ blocked: true });
    const beforeEtag = before.headers.get("ETag");
    const transitioned = await browserTaskPatch(session, dependency.id, { status: terminalStatus });

    expect(transitioned.status, await transitioned.clone().text()).toBe(200);
    const after = await browserRequest(session, `/tasks/${dependent.id}`);
    expect(after.headers.get("ETag")).not.toBe(beforeEtag);
    expect(await after.json()).toMatchObject({ blocked: false });
  });

  it("returns an RFC 9457 Problem for an invalid Task stream Last-Event-ID", async () => {
    const board = await createBoard(db, tenantId, "Invalid Task stream cursor", "ops");
    const task = await createTask(db, tenantId, { title: "Invalid stream cursor", board_id: board.id });
    const url = `${resource}/tasks/${task.id}/stream`;
    const authority = await realmrootAgentAuthority(url, "GET", "task:read");

    const response = await api.fetch(
      new Request(url, {
        headers: {
          authorization: `DPoP ${authority.accessToken}`,
          dpop: authority.proof,
          "API-Version": "2026-08-29",
          "Last-Event-ID": "unknown-note",
        },
      }),
      env,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    await expect(response.json()).resolves.toMatchObject({
      type: `${resource}/problems/request-rejected`,
      title: "Request rejected",
      status: 400,
      detail: "Unknown event ID, reconnect without Last-Event-ID",
    });
  });

  it("represents Task Events with lowerCamel Task fields and kebab-case status, until, and outcome", async () => {
    const board = await createBoard(db, tenantId, "Task Event representation", "ops");
    const task = await createTask(db, tenantId, { title: "Event representation", board_id: board.id });
    await db.prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").bind(task.id).run();

    const response = await request("GET", `/tasks/${task.id}/events?until=in-review&waitSeconds=0`, "task:read");
    expect(response.status, await response.clone().text()).toBe(200);
    const snapshot = (await response.json()) as { cursor: string };
    expect(snapshot).toMatchObject({
      cursor: expect.stringMatching(/^v2:[0-9]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/),
      outcome: "reached",
      until: "in-review",
      tasks: [
        expect.objectContaining({
          id: task.id,
          boardId: board.id,
          status: "in-review",
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        }),
      ],
    });
    const continuation = await request(
      "GET",
      `/tasks/${task.id}/events?until=in-review&waitSeconds=0&cursor=${encodeURIComponent(snapshot.cursor)}`,
      "task:read",
    );
    expect(continuation.status, await continuation.clone().text()).toBe(200);
  });

  it.each([
    ["POST", "/boards/missing/labels", "board:write", { name: "private", color: "#112233" }],
    ["PATCH", "/boards/missing", "board:write", { name: "private" }],
    ["DELETE", "/boards/missing", "board:write", undefined],
    ["DELETE", "/repositories/missing", "repository:write", undefined],
    ["GET", "/tasks/missing/session", "task:read", undefined],
    ["GET", "/tasks/missing/stream", "task:read", undefined],
  ] as const)("lets a scoped caller reach the published operation %s %s", async (method, path, scope, body) => {
    const response = await request(method, path, scope, body);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    await expect(response.json()).resolves.toMatchObject({ status: 404 });
  });

  it("lets a scoped caller with a Task precondition reach DELETE for a missing Task", async () => {
    const url = `${resource}/tasks/missing`;
    const authority = await realmrootAgentAuthority(url, "DELETE", "task:write");
    const response = await api.fetch(
      new Request(url, {
        method: "DELETE",
        headers: {
          authorization: `DPoP ${authority.accessToken}`,
          dpop: authority.proof,
          "API-Version": "2026-08-29",
          "If-Match": '"1"',
        },
      }),
      env,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    await expect(response.json()).resolves.toMatchObject({ status: 404 });
  });

  it("lets a scope-valid human Claim caller reach the runtime binding precondition", async () => {
    const url = `${resource}/tasks/missing-task/claims`;
    const authority = await realmrootAgentAuthority(url, "POST", "task:claim", "unused-agent", undefined, {
      principalType: "human",
      subjectId: "human-claimer",
    });

    const response = await api.fetch(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: `DPoP ${authority.accessToken}`,
          dpop: authority.proof,
          "API-Version": "2026-08-29",
          "Idempotency-Key": '"human-claim"',
        },
      }),
      env,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      type: `${resource}/problems/runtime-session-required`,
      status: 409,
    });
  });

  it("restores browser Session scopes without Agent workflow authority", async () => {
    const session = await createTestWebSession(db, tenantId, { subjectId: "human-session-claimer" });
    const response = await api.fetch(
      new Request(`${resource}/tasks/missing-task/claims`, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          "x-csrf-token": session.csrfToken,
          "API-Version": "2026-08-29",
          "Idempotency-Key": '"browser-claim"',
        },
      }),
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      type: `${resource}/problems/permission-denied`,
      status: 403,
      detail: "Missing scope: task:claim",
    });
  });

  it("[spec: tasks/assign] rejects assignment patches with the wrong media type or mixed transitions", async () => {
    const board = await createBoard(db, tenantId, "Human assignment board", "ops");
    const task = await createTask(db, tenantId, { title: "Human assigned Task", board_id: board.id });
    const session = await createTestWebSession(db, tenantId, { subjectId: "human-assigner" });
    const wrongMedia = await browserTaskPatch(session, task.id, { assignedTo: "realmroot-agent-target" }, "application/json");
    expect(wrongMedia.status).toBe(415);
    const mixed = await browserTaskPatch(session, task.id, { assignedTo: "another-agent", status: "cancelled" });
    expect(mixed.status).toBe(422);
    await expect(mixed.json()).resolves.toMatchObject({ detail: "Assignment and status changes must be separate requests" });
    await expect(db.prepare("SELECT assigned_to FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({ assigned_to: null });
    expect(inboxMessageRequests).toHaveLength(0);
  });

  it("[spec: tasks/structured-fields] recursively merges Task JSON fields without losing untouched data", async () => {
    const board = await createBoard(db, tenantId, "Merge patch fields", "ops");
    const original = { keep: "important", nested: { keep: true, change: "old", remove: "discard" }, list: [1, 2], scalar: "old" };
    const task = await createTask(db, tenantId, { title: "Preserve planning data", board_id: board.id, metadata: original, input: original });
    const session = await createTestWebSession(db, tenantId);
    const patch = { nested: { change: "new", remove: null }, list: [3], scalar: { added: true, absent: null }, missing: null };
    const response = await browserTaskPatch(session, task.id, { metadata: patch, input: patch });
    const expected = { keep: "important", nested: { keep: true, change: "new" }, list: [3], scalar: { added: true } };

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ metadata: expected, input: expected });
    const stored = await db
      .prepare("SELECT metadata, input, version FROM tasks WHERE id = ?")
      .bind(task.id)
      .first<{ metadata: string; input: string; version: number }>();
    expect(JSON.parse(stored!.metadata)).toEqual(expected);
    expect(JSON.parse(stored!.input)).toEqual(expected);
    expect(stored!.version).toBe(2);
  });

  it("commits only one concurrent Task patch and tells the loser to reread", async () => {
    const board = await createBoard(db, tenantId, "Concurrent Task patch", "ops");
    const task = await createTask(db, tenantId, { title: "Before concurrent patch", board_id: board.id });
    const session = await createTestWebSession(db, tenantId, { subjectId: "concurrent-task-editor" });
    const responses = await Promise.all([
      browserTaskPatch(session, task.id, { title: "Concurrent winner A" }),
      browserTaskPatch(session, task.id, { title: "Concurrent winner B" }),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const loser = responses.find(({ status }) => status === 409)!;
    await expect(loser.json()).resolves.toMatchObject({
      type: `${resource}/problems/task-update-conflict`,
      detail: expect.stringMatching(/reread/i),
    });
    const persisted = await db.prepare("SELECT title, version FROM tasks WHERE id = ?").bind(task.id).first<{ title: string; version: number }>();
    expect(["Concurrent winner A", "Concurrent winner B"]).toContain(persisted!.title);
    expect(persisted!.version).toBe(2);
  });

  it("[spec: tasks/submit-review] [spec: tasks/reject-review] [spec: tasks/complete-review] [spec: tasks/cancel] transitions lifecycle through Task status patches", async () => {
    env = {
      ...env,
      OIDC_ISSUER: issuer,
      INBOX_RESOURCE: inboxResource,
      INBOX_API_VERSION: "2026-08-31",
      OIDC_SERVICE_CLIENT_ID: "agent-kanban",
      OIDC_SERVICE_CLIENT_SECRET: "inbox-client-secret",
    };
    const board = await createBoard(db, tenantId, "Task status patches", "ops");
    const task = await reviewReadyTask(tenantId, board.id, "Review through Task PATCH", "actor-toolbox");
    await db.prepare("INSERT INTO agency_owner_integrations (tenant_id, agency_project_id) VALUES (?, ?)").bind(tenantId, "review-project").run();
    await db
      .prepare(`UPDATE tasks SET metadata = json_set(metadata, '$.annotations."agent-kanban.dev/session-id"', 'review-session') WHERE id = ?`)
      .bind(task.id)
      .run();
    await db.prepare("UPDATE tasks SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(task.id).run();
    const submitted = await taskPatchToken(task.id, { status: "in-review", pullRequestUrl: "https://github.com/example/repo/pull/1" });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    await expect(submitted.json()).resolves.toMatchObject({
      id: task.id,
      status: "in-review",
      pullRequestUrl: "https://github.com/example/repo/pull/1",
    });
    const selfReview = await taskPatchToken(task.id, { status: "done" });
    expect(selfReview.status).toBe(403);
    await expect(selfReview.json()).resolves.toMatchObject({ type: `${resource}/problems/task-transition-forbidden` });

    const rejected = await taskPatchToken(
      task.id,
      { status: "in-progress", statusReason: "needs changes" },
      {
        principalType: "human",
        subjectId: "human-reviewer",
      },
    );
    expect(rejected.status, await rejected.clone().text()).toBe(200);
    await expect(rejected.json()).resolves.toMatchObject({ id: task.id, status: "in-progress" });
    expect(inboxMessageRequests).toHaveLength(0);
    expect(sessionMessageRequests).toHaveLength(1);

    const resubmitted = await taskPatchToken(task.id, { status: "in-review" });
    expect(resubmitted.status, await resubmitted.clone().text()).toBe(200);
    const completed = await taskPatchToken(
      task.id,
      { status: "done" },
      {
        principalType: "human",
        subjectId: "human-reviewer",
      },
    );
    expect(completed.status, await completed.clone().text()).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({ id: task.id, status: "done" });

    const invalidTask = await createTask(db, tenantId, { title: "Invalid direct completion", board_id: board.id });
    const invalid = await taskPatchToken(
      invalidTask.id,
      { status: "done" },
      {
        principalType: "human",
        subjectId: "human-reviewer",
      },
    );
    expect(invalid.status).toBe(409);
    await expect(invalid.json()).resolves.toMatchObject({ type: `${resource}/problems/task-transition-conflict` });

    const cancelledTask = await createTask(db, tenantId, { title: "Cancel through Task PATCH", board_id: board.id });
    const cancelled = await taskPatchToken(
      cancelledTask.id,
      { status: "cancelled" },
      {
        principalType: "human",
        subjectId: "human-reviewer",
      },
    );
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    await expect(cancelled.json()).resolves.toMatchObject({ id: cancelledTask.id, status: "cancelled" });
  });

  it("[spec: tasks/create] creates only an unassigned Task through the generic collection operation", async () => {
    const board = await createBoard(db, tenantId, "Unassigned task board", "ops");

    const response = await request("POST", "/tasks", "task:write", { title: "Unassigned v2 Task", boardId: board.id });

    expect(response.status, await response.clone().text()).toBe(201);
    const task = (await response.json()) as { id: string; assignedTo: string | null };
    expect(task).toMatchObject({ assignedTo: null });
    expect(task).not.toHaveProperty("assigneeIdentityType");
    await expect(db.prepare("SELECT actor_type, action FROM task_actions WHERE task_id = ?").bind(task.id).first()).resolves.toEqual({
      actor_type: "realmroot:agent",
      action: "created",
    });
  });

  it.each(["assigned_to", "agent_id"] as const)("rejects Task create field %s before Task, action, or Agency side effects", async (field) => {
    const board = await createBoard(db, tenantId, `Rejected ${field} board`, "ops");
    const before = await Promise.all([
      db.prepare("SELECT COUNT(*) AS count FROM tasks").first(),
      db.prepare("SELECT COUNT(*) AS count FROM task_actions").first(),
    ]);

    const response = await request("POST", "/tasks", "task:write", {
      title: `Rejected ${field} Task`,
      boardId: board.id,
      [field]: "actor-not-assignable-at-create",
    });

    expect(response.status, await response.clone().text()).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      type: `${resource}/problems/request-rejected`,
      status: 422,
      detail: `Task contains unsupported properties: ${field}`,
    });
    await expect(
      Promise.all([db.prepare("SELECT COUNT(*) AS count FROM tasks").first(), db.prepare("SELECT COUNT(*) AS count FROM task_actions").first()]),
    ).resolves.toEqual(before);
  });

  it("rejects an unknown Task create field before Task or action side effects", async () => {
    const board = await createBoard(db, tenantId, "Rejected unknown field board", "ops");
    const before = await Promise.all([
      db.prepare("SELECT COUNT(*) AS count FROM tasks").first(),
      db.prepare("SELECT COUNT(*) AS count FROM task_actions").first(),
    ]);

    const response = await request("POST", "/tasks", "task:write", {
      title: "Rejected unknown field Task",
      boardId: board.id,
      unexpected: true,
    });

    expect(response.status, await response.clone().text()).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      type: `${resource}/problems/request-rejected`,
      status: 422,
      detail: "Task contains unsupported properties: unexpected",
    });
    await expect(
      Promise.all([db.prepare("SELECT COUNT(*) AS count FROM tasks").first(), db.prepare("SELECT COUNT(*) AS count FROM task_actions").first()]),
    ).resolves.toEqual(before);
  });

  it.each(["assigned_to", "agent_id", "assignee_identity_type"] as const)(
    "rejects Task PATCH field %s without creating a wire or persisted assignment",
    async (field) => {
      const board = await createBoard(db, tenantId, `Rejected patch ${field}`, "ops");
      const task = await createTask(db, tenantId, { title: `Unassigned ${field}`, board_id: board.id });
      const before = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(task.id).first();

      const response = await taskPatchToken(task.id, {
        [field]: field === "assignee_identity_type" ? "realmroot_actor" : "actor-not-assignable-by-patch",
      });

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        type: `${resource}/problems/request-rejected`,
        status: 422,
        detail: `Task contains unsupported properties: ${field}`,
      });
      await expect(db.prepare("SELECT * FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual(before);
      const read = await request("GET", `/tasks/${task.id}`, "task:read");
      expect(read.status).toBe(200);
      const representation = (await read.json()) as Record<string, unknown>;
      expect(representation).toMatchObject({ assignedTo: null });
      expect(representation).not.toHaveProperty("assigneeIdentityType");
    },
  );

  it.each([
    ["title", null, "Task.title cannot be null"],
    ["metadata", null, "Task.metadata cannot be null"],
    ["position", "first", "Task.position must be a finite number"],
  ] as const)("rejects invalid Task merge patch value %s", async (field, value, detail) => {
    const board = await createBoard(db, tenantId, `Invalid ${field} patch`, "ops");
    const task = await createTask(db, tenantId, { title: `Task for invalid ${field}`, board_id: board.id });
    const before = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(task.id).first();

    const response = await taskPatchToken(task.id, { [field]: value });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      type: `${resource}/problems/request-rejected`,
      status: 422,
      detail,
    });
    await expect(db.prepare("SELECT * FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual(before);
  });

  it("[spec: resource-server/generic-operations] executes representative verb-first Board, unassigned Task, Note, and Repository operations with exact scopes", async () => {
    const ownBoard = await createBoard(db, tenantId, "Own board", "ops");
    const foreignBoard = await createBoard(db, foreignTenantId, "Foreign board", "ops");

    const boards = await request("GET", "/boards", "board:read");
    expect(boards.status).toBe(200);
    const boardItems = ((await boards.json()) as { items: Array<{ id: string }> }).items;
    expect(boardItems).toEqual(expect.arrayContaining([expect.objectContaining({ id: ownBoard.id })]));
    expect(boardItems).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: foreignBoard.id })]));

    const createdTask = await request("POST", "/tasks", "task:write", { title: "Toolbox Task", boardId: ownBoard.id });
    expect(createdTask.status).toBe(201);
    const task = (await createdTask.json()) as { id: string; assignedTo: string | null };
    expect(task.assignedTo).toBeNull();

    const note = await request("POST", `/tasks/${task.id}/notes`, "task:write", { detail: "Toolbox note" });
    expect(note.status).toBe(201);
    await expect(note.json()).resolves.toMatchObject({ taskId: task.id, action: "commented", detail: "Toolbox note" });

    const repository = await request("POST", "/repositories", "repository:write", {
      name: "toolbox-repository",
      url: "https://gitlab.com/example/toolbox-repository.git",
    });
    expect(repository.status).toBe(201);
    const repositoryBody = (await repository.json()) as Record<string, unknown>;
    expect(repositoryBody).toMatchObject({ name: "toolbox-repository" });
    expect(repositoryBody).not.toHaveProperty("ownerId");

    const wrongScope = await request("POST", "/repositories", "task:read", {
      name: "forbidden-repository",
      url: "https://gitlab.com/example/forbidden.git",
    });
    expect(wrongScope.status).toBe(403);
    await expect(wrongScope.json()).resolves.toMatchObject({
      type: `${resource}/problems/permission-denied`,
      title: "Permission denied",
      status: 403,
      detail: "Missing scope: repository:write",
    });

    const readOnlySession = await createTestWebSession(db, tenantId, { scopes: ["repository:read"] });
    expect((await browserRequest(readOnlySession, "/repositories")).status).toBe(200);
    const deniedSessionWrite = await browserMutation(readOnlySession, "POST", "/repositories", {
      name: "forbidden-session-repository",
      url: "https://gitlab.com/example/forbidden-session.git",
    });
    expect(deniedSessionWrite.status).toBe(403);
    await expect(deniedSessionWrite.json()).resolves.toMatchObject({
      type: `${resource}/problems/permission-denied`,
      status: 403,
      detail: "Missing scope: repository:write",
    });

    const foreignTask = await createTask(db, foreignTenantId, { title: "Foreign Task", board_id: foreignBoard.id });
    const hidden = await request("POST", `/tasks/${foreignTask.id}/notes`, "task:write", { detail: "Must not write" });
    expect(hidden.status).toBe(404);
    await expect(
      db.prepare("SELECT COUNT(*) AS count FROM task_actions WHERE task_id = ? AND detail = ?").bind(foreignTask.id, "Must not write").first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("defaults and echoes API-Version on a published generic route while rejecting a wrong explicit version", async () => {
    const missing = await request("GET", "/boards", "board:read", undefined, false);
    expect(missing.status).toBe(200);
    expect(missing.headers.get("API-Version")).toBe("2026-08-29");
    expect(missing.headers.get("Vary")).toContain("API-Version");
    const empty = await request("GET", "/boards", "board:read", undefined, true, "");
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toMatchObject({ detail: "Unsupported API-Version: " });

    const wrong = await request("GET", "/boards", "board:read", undefined, true, "1999-01-01");
    expect(wrong.status).toBe(400);
    await expect(wrong.json()).resolves.toMatchObject({ detail: "Unsupported API-Version: 1999-01-01" });
  });

  it.each([
    ["text/plain", JSON.stringify({ title: "Wrong media type" }), 415, "unsupported-media-type"],
    ["application/json", "{malformed", 400, "invalid-json"],
  ] as const)("maps %s Task creation input to a concrete Problem", async (contentType, body, status, problemType) => {
    const url = `${resource}/tasks`;
    const authority = await realmrootAgentAuthority(url, "POST", "task:write");
    const response = await api.fetch(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: `DPoP ${authority.accessToken}`,
          dpop: authority.proof,
          "API-Version": "2026-08-29",
          "Idempotency-Key": JSON.stringify(`invalid-${problemType}`),
          "content-type": contentType,
        },
        body,
      }),
      env,
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    await expect(response.json()).resolves.toMatchObject({ status, type: `${resource}/problems/${problemType}` });
  });
});

async function request(
  method: string,
  path: string,
  scope: string,
  body?: unknown,
  versioned = true,
  apiVersion = "2026-08-29",
  idempotencyKey: string | null = method === "POST" ? `test-${randomUUID()}` : null,
  actorId = "actor-toolbox",
  structuredIdempotencyKey = true,
): Promise<Response> {
  const url = `${resource}${path}`;
  const requestUrl = new URL(url);
  const authority = await realmrootAgentAuthority(`${requestUrl.origin}${requestUrl.pathname}`, method, scope, actorId);
  return api.fetch(
    new Request(url, {
      method,
      headers: {
        authorization: `DPoP ${authority.accessToken}`,
        dpop: authority.proof,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(versioned ? { "API-Version": apiVersion } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": structuredIdempotencyKey ? JSON.stringify(idempotencyKey) : idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
}

async function browserRequest(session: Awaited<ReturnType<typeof createTestWebSession>>, path: string): Promise<Response> {
  return api.fetch(new Request(`${resource}${path}`, { headers: { cookie: session.cookie, "API-Version": "2026-08-29" } }), env);
}

async function browserMutation(
  session: Awaited<ReturnType<typeof createTestWebSession>>,
  method: string,
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<Response> {
  return api.fetch(
    new Request(`${resource}${path}`, {
      method,
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken,
        "API-Version": "2026-08-29",
        "content-type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": JSON.stringify(idempotencyKey) } : {}),
      },
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function browserTaskPatch(
  session: Awaited<ReturnType<typeof createTestWebSession>>,
  taskId: string,
  body: unknown,
  contentType = "application/merge-patch+json",
): Promise<Response> {
  return api.fetch(
    new Request(`${resource}/tasks/${taskId}`, {
      method: "PATCH",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken,
        "API-Version": "2026-08-29",
        "content-type": contentType,
      },
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function browserTaskDelete(session: Awaited<ReturnType<typeof createTestWebSession>>, taskId: string, ifMatch: string): Promise<Response> {
  return api.fetch(
    new Request(`${resource}/tasks/${taskId}`, {
      method: "DELETE",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken,
        "API-Version": "2026-08-29",
        "If-Match": ifMatch,
      },
    }),
    env,
  );
}

async function taskPatchToken(
  taskId: string,
  body: unknown,
  options: { actorId?: string; principalType?: "human" | "agent"; subjectId?: string } = {},
): Promise<Response> {
  const url = `${resource}/tasks/${taskId}`;
  const authority = await realmrootAgentAuthority(url, "PATCH", "task:write", options.actorId, undefined, {
    principalType: options.principalType,
    subjectId: options.subjectId,
  });
  return api.fetch(
    new Request(url, {
      method: "PATCH",
      headers: {
        authorization: `DPoP ${authority.accessToken}`,
        dpop: authority.proof,
        "API-Version": "2026-08-29",
        "Content-Type": "application/merge-patch+json",
      },
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function creationFixture(resourceKind: "boards" | "repositories" | "tasks" | "notes") {
  if (resourceKind === "boards") {
    return {
      path: "/boards",
      scope: "board:write",
      body: { name: "Idempotent board", type: "ops" },
      conflictingBody: { name: "Different board", type: "ops" },
      count: async () =>
        (await db.prepare("SELECT COUNT(*) AS count FROM boards WHERE owner_id = ?").bind(tenantId).first<{ count: number }>())!.count,
    };
  }
  if (resourceKind === "repositories") {
    return {
      path: "/repositories",
      scope: "repository:write",
      body: { name: "idempotent-repository", url: "https://github.com/example/idempotent.git" },
      conflictingBody: { name: "different-repository", url: "https://github.com/example/different.git" },
      count: async () =>
        (await db.prepare("SELECT COUNT(*) AS count FROM repositories WHERE owner_id = ?").bind(tenantId).first<{ count: number }>())!.count,
    };
  }
  const board = await createBoard(db, tenantId, `Idempotent ${resourceKind} board`, "ops");
  if (resourceKind === "tasks") {
    return {
      path: "/tasks",
      scope: "task:write",
      body: { title: "Idempotent Task", boardId: board.id },
      conflictingBody: { title: "Different Task", boardId: board.id },
      count: async () =>
        (await db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE board_id = ?").bind(board.id).first<{ count: number }>())!.count,
    };
  }
  const task = await createTask(db, tenantId, { title: "Note parent", board_id: board.id });
  return {
    path: `/tasks/${task.id}/notes`,
    scope: "task:write",
    body: { detail: "Idempotent note" },
    conflictingBody: { detail: "Different note" },
    count: async () =>
      (await db
        .prepare("SELECT COUNT(*) AS count FROM task_actions WHERE task_id = ? AND action = 'commented'")
        .bind(task.id)
        .first<{ count: number }>())!.count,
  };
}

async function mutateCreatedResource(resourceKind: "boards" | "repositories" | "tasks" | "notes", id: string, before: number): Promise<number> {
  if (resourceKind === "boards") {
    await db.prepare("UPDATE boards SET name = 'mutated after creation' WHERE id = ?").bind(id).run();
    return before + 1;
  }
  if (resourceKind === "tasks") {
    await db.prepare("UPDATE tasks SET title = 'mutated after creation' WHERE id = ?").bind(id).run();
    return before + 1;
  }
  const table = resourceKind === "repositories" ? "repositories" : "task_actions";
  await db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
  return before;
}

async function realmrootAgentAuthority(
  htu: string,
  method: string,
  scope: string,
  actorId = "actor-toolbox",
  authorityUrls: { issuer: string; jwksUri: string } = { issuer, jwksUri },
  options: { organizationId?: string | null; principalType?: "human" | "agent"; subjectId?: string } = {},
) {
  const authorityIssuer = authorityUrls.issuer;
  const authorityJwksUri = authorityUrls.jwksUri;
  const issuerKeys = await issuerKeysPromise;
  const issuerPublicJwk = await exportJWK(issuerKeys.publicKey);
  issuerPublicJwk.kid = "toolbox-generic-issuer-key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: RequestInfo | URL, init?: RequestInit) => {
      const request = target instanceof Request ? target : new Request(String(target), init);
      const url = request.url;
      if (url === `${authorityIssuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer: authorityIssuer,
          authorization_endpoint: `${authorityIssuer}/oauth2/authorize`,
          token_endpoint: `${authorityIssuer}/oauth2/token`,
          jwks_uri: authorityJwksUri,
        });
      }
      if (url === authorityJwksUri) return Response.json({ keys: [issuerPublicJwk] });
      if (url === `${authorityIssuer}/oauth2/token`) {
        return Response.json({ access_token: "inbox-machine-token" });
      }
      if (url === `${env.AGENCY_ORIGIN}/api/v1/sessions/review-session/messages`) {
        sessionMessageRequests.push(request);
        expect(request.headers.get("x-enbor-project-id")).toBe("review-project");
        expect(await request.clone().json()).toMatchObject({ type: "prompt", content: expect.stringContaining("needs changes") });
        return Response.json({ metadata: { uid: "review-message" } }, { status: 201 });
      }
      if (url === `${inboxResource}/messages`) {
        inboxMessageRequests.push(request);
        return new Response(null, { status: 201 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const dpopKeys = await generateKeyPair("ES256", { extractable: true });
  const dpopPublicJwk = await exportJWK(dpopKeys.publicKey);
  const thumbprint = await calculateJwkThumbprint(dpopPublicJwk);
  const organizationId = options.organizationId === undefined ? tenantId : options.organizationId;
  const accessToken = await new SignJWT({
    scope,
    client_id: "realmroot-cli",
    cnf: { jkt: thumbprint },
    ...(options.principalType === "human" ? {} : { act: { iss: authorityIssuer, sub: actorId } }),
    ...(organizationId === null ? {} : { "urn:realmroot:params:oauth:org": organizationId }),
  })
    .setProtectedHeader({ alg: "ES256", kid: issuerPublicJwk.kid, typ: "at+jwt" })
    .setIssuer(authorityIssuer)
    .setAudience(resource)
    .setSubject(options.subjectId ?? "controller-toolbox")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(issuerKeys.privateKey);
  const proof = await new SignJWT({ htu, htm: method, ath: createHash("sha256").update(accessToken).digest("base64url") })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: dpopPublicJwk })
    .setJti(randomUUID())
    .setIssuedAt()
    .sign(dpopKeys.privateKey);
  return { accessToken, proof };
}

async function realmrootBearerToken(principalType: "human" | "agent"): Promise<string> {
  const issuerKeys = await issuerKeysPromise;
  const issuerPublicJwk = await exportJWK(issuerKeys.publicKey);
  issuerPublicJwk.kid = "toolbox-generic-issuer-key";
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
        });
      }
      if (url === jwksUri) return Response.json({ keys: [issuerPublicJwk] });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  return new SignJWT({
    scope: "task:read",
    client_id: "realmroot-cli",
    ...(principalType === "agent" ? { act: { iss: issuer, sub: "actor-toolbox" } } : {}),
    "urn:realmroot:params:oauth:org": tenantId,
  })
    .setProtectedHeader({ alg: "ES256", kid: issuerPublicJwk.kid, typ: "at+jwt" })
    .setIssuer(issuer)
    .setAudience(resource)
    .setSubject("controller-toolbox")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(issuerKeys.privateKey);
}

async function reviewReadyTask(ownerId: string, boardId: string, title: string, actorId: string) {
  const task = await createTask(db, ownerId, { title, board_id: boardId });
  await db
    .prepare("UPDATE tasks SET status = 'in_progress', assigned_to = ?, assignee_identity_type = 'realmroot_actor' WHERE id = ?")
    .bind(actorId, task.id)
    .run();
  return task;
}
