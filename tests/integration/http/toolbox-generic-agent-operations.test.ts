// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoard } from "../../../server/adapters/d1/boardRepo";
import { createRepository } from "../../../server/adapters/d1/repositoryRepo";
import { addTaskAction, createTask } from "../../../server/adapters/d1/taskRepo";
import { d1TaskAssignmentRepository } from "../../../server/adapters/d1/tasks/d1TaskAssignments";
import { d1TaskReviewSubmissionRepository } from "../../../server/adapters/d1/tasks/d1TaskReviewSubmissions";
import type { Env } from "../../../server/env";
import { api } from "../../../server/http/app";
import { replaceTaskAssignment } from "../../../server/usecases/tasks/replaceTaskAssignment";
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
let inboxResponseStatus: number;
let oidcDiscoveryRequests: number;
let machineTokenRequests: Request[];
let inboxMessageRequests: Request[];

beforeEach(async () => {
  ({ mf, db } = await setupMiniflare());
  env = { ...createTestEnv(), DB: db, AK_PUBLIC_ORIGIN: new URL(resource).origin } as Env;
  inboxResponseStatus = 201;
  oidcDiscoveryRequests = 0;
  machineTokenRequests = [];
  inboxMessageRequests = [];
  await seedUser(db, tenantId, "toolbox-generic@example.test");
  await seedUser(db, foreignTenantId, "toolbox-foreign@example.test");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await mf.dispose();
});

describe("Realmroot Agent generic Toolbox operations", () => {
  it("[spec: tasks/cancel] notifies Inbox after Task lifecycle writes, retries notification on idempotent replay, and maps failure to 503", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    env = {
      ...env,
      OIDC_ISSUER: issuer,
      INBOX_RESOURCE: inboxResource,
      INBOX_API_VERSION: "2026-08-31",
      OIDC_SERVICE_CLIENT_ID: "agent-kanban",
      OIDC_SERVICE_CLIENT_SECRET: "inbox-client-secret",
    };

    for (const kind of ["assignment", "rejection", "completion", "cancellation"] as const) {
      inboxResponseStatus = 201;
      oidcDiscoveryRequests = 0;
      machineTokenRequests = [];
      inboxMessageRequests = [];
      const assigneeActorId = `notified-${kind}-agent`;
      const board = await createBoard(db, tenantId, `Inbox ${kind}`, "ops");
      const task = await createTask(db, tenantId, { title: `Inbox ${kind} Task`, board_id: board.id });
      let path: string;
      let scope: string;
      let body: unknown;
      let event: string;

      if (kind === "assignment") {
        path = `/task-assignments/${task.id}`;
        scope = "task:assign";
        body = { agentActorId: assigneeActorId };
        event = "assigned";
      } else if (kind === "cancellation") {
        await replaceTaskAssignment(d1TaskAssignmentRepository(db), {
          ownerId: tenantId,
          taskId: task.id,
          assigneeActorId,
          assignedByActorId: "assigner",
        });
        path = `/task-cancellations/${task.id}`;
        scope = "task:cancel";
        body = undefined;
        event = "cancelled";
      } else {
        await replaceTaskAssignment(d1TaskAssignmentRepository(db), {
          ownerId: tenantId,
          taskId: task.id,
          assigneeActorId,
          assignedByActorId: "assigner",
        });
        await db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").bind(task.id).run();
        const submission = await replaceTaskReviewSubmission(d1TaskReviewSubmissionRepository(db), {
          ownerId: tenantId,
          taskId: task.id,
          agentActorId: assigneeActorId,
          pullRequestUrl: null,
        });
        path = `/task-review-${kind === "rejection" ? "rejections" : "completions"}/${task.id}`;
        scope = kind === "rejection" ? "task:reject" : "task:complete";
        body = { reviewSubmissionVersion: submission.version, ...(kind === "rejection" ? { reason: "needs changes" } : {}) };
        event = kind === "rejection" ? "review_rejected" : "completed";
      }

      const invoke = () => request("PUT", path, scope, body, true, "2026-08-29", null, "lifecycle-reviewer");
      const created = await invoke();
      expect([200, 201], `${kind} create: ${await created.clone().text()}`).toContain(created.status);
      const replayed = await invoke();
      expect(replayed.status, `${kind} replay: ${await replayed.clone().text()}`).toBe(200);
      inboxResponseStatus = 503;
      const unavailable = await invoke();
      expect(unavailable.status).toBe(503);
      expect(unavailable.headers.get("Retry-After")).toBe("5");
      await expect(unavailable.json()).resolves.toMatchObject({
        status: 503,
        type: `${resource}/problems/task-notification-unavailable`,
      });

      expect(oidcDiscoveryRequests).toBeGreaterThanOrEqual(3);
      expect(machineTokenRequests).toHaveLength(3);
      expect(inboxMessageRequests).toHaveLength(3);
      for (const tokenRequest of machineTokenRequests) {
        expect(tokenRequest.headers.get("Authorization")).toBe(`Basic ${btoa("agent-kanban:inbox-client-secret")}`);
        await expect(tokenRequest.clone().text()).resolves.toContain(`resource=${encodeURIComponent(inboxResource)}`);
        await expect(tokenRequest.clone().text()).resolves.toContain("scope=messages%3Acreate");
      }
      const idempotencyKeys = new Set<string>();
      for (const messageRequest of inboxMessageRequests) {
        expect(messageRequest.headers.get("Authorization")).toBe("Bearer inbox-machine-token");
        expect(messageRequest.headers.get("API-Version")).toBe("2026-08-31");
        idempotencyKeys.add(messageRequest.headers.get("Idempotency-Key")!);
        const message = (await messageRequest.clone().json()) as {
          recipients: string[];
          content: { text: string };
          routingKey: string;
        };
        expect(message).toMatchObject({
          recipients: [`agent:${assigneeActorId}`],
          content: { text: expect.stringContaining(event) },
          routingKey: `agent-kanban:task:${task.id}`,
        });
        expect(message.content.text).toContain(`${resource}/tasks/${task.id}`);
        expect(message.content.text).not.toContain("API-Version");
        expect(message.content.text).not.toContain("agent-kanban");
      }
      expect(idempotencyKeys.size).toBe(1);
      if (kind === "cancellation") {
        await expect(db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({ status: "cancelled" });
      }
    }

    const completionEvents = consoleError.mock.calls
      .map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
      .filter((entry) => entry.name === "api" && entry.msg === "request completed" && entry.status === 503);
    expect(completionEvents).toHaveLength(4);
    for (const event of completionEvents) {
      expect(event).toEqual(
        expect.objectContaining({
          result: "server_error",
          error_name: "TaskLifecycleNotificationFailure",
          error_message: "Inbox rejected the task notification",
          error_stack: expect.stringContaining("Inbox rejected the task notification"),
          error_cause: expect.objectContaining({
            name: "Error",
            message: "Inbox responded with HTTP 503",
            stack: expect.stringContaining("Inbox responded with HTTP 503"),
          }),
        }),
      );
    }
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

  it("returns paginated lowerCamel Agent collections while preserving browser arrays and snake_case", async () => {
    const firstBoard = await createBoard(db, tenantId, "Collection board one", "ops");
    const secondBoard = await createBoard(db, tenantId, "Collection board two", "ops");
    await createRepository(db, tenantId, { name: "collection-repository", url: "https://github.com/example/collection.git" });
    const task = await createTask(db, tenantId, { title: "Collection Task", board_id: firstBoard.id });
    await db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").bind(task.id).run();
    await addTaskAction(db, task.id, "realmroot:agent", "actor-toolbox", "commented", "Collection note");

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
    for (const path of ["/boards", "/repositories", "/tasks", `/tasks/${task.id}/notes`] as const) {
      const response = await browserRequest(session, path);
      expect(response.status, path).toBe(200);
      expect(await response.json()).toEqual(expect.any(Array));
    }
    const browserTasks = await browserRequest(session, "/tasks");
    await expect(browserTasks.json()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ board_id: firstBoard.id, status: "in_progress" })]),
    );
    const browserNotes = await browserRequest(session, `/tasks/${task.id}/notes`);
    await expect(browserNotes.json()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ task_id: task.id })]));
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
    const event = await request("GET", `/task-events?taskId=${task.id}&until=in-review&waitSeconds=0`, "task:read", undefined, false);
    const eventBody = (await event.json()) as { cursor: string };
    env = { ...env, OIDC_WEB_CLIENT_SECRET: "rotated-web-secret-again" };
    const eventContinuation = await request(
      "GET",
      `/task-events?taskId=${task.id}&until=in-review&waitSeconds=0&cursor=${encodeURIComponent(eventBody.cursor)}`,
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

  it("represents Task Events with lowerCamel Task fields and kebab-case status, until, and outcome", async () => {
    const board = await createBoard(db, tenantId, "Task Event representation", "ops");
    const task = await createTask(db, tenantId, { title: "Event representation", board_id: board.id });
    await db.prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").bind(task.id).run();

    const response = await request("GET", `/task-events?taskId=${task.id}&until=in-review&waitSeconds=0`, "task:read");
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
      `/task-events?taskId=${task.id}&until=in-review&waitSeconds=0&cursor=${encodeURIComponent(snapshot.cursor)}`,
      "task:read",
    );
    expect(continuation.status, await continuation.clone().text()).toBe(200);
  });

  it.each([
    ["POST", "/boards/missing/labels", "board:write", { name: "private", color: "#112233" }],
    ["PATCH", "/boards/missing", "board:write", { name: "private" }],
    ["DELETE", "/boards/missing", "board:write", undefined],
    ["PATCH", "/tasks/missing", "task:write", { title: "private" }],
    ["DELETE", "/tasks/missing", "task:write", undefined],
    ["DELETE", "/repositories/missing", "repository:write", undefined],
    ["GET", "/tasks/missing/session", "task:read", undefined],
    ["GET", "/tasks/missing/stream", "task:read", undefined],
    ["GET", "/github-app/config", "repository:read", undefined],
  ] as const)("denies unpublished Agent management operation %s %s", async (method, path, scope, body) => {
    const response = await request(method, path, scope, body);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("[spec: tasks/assign] allows an authenticated human to create an Assignment for the requested Realmroot Agent", async () => {
    const board = await createBoard(db, tenantId, "Human assignment board", "ops");
    const task = await createTask(db, tenantId, { title: "Human assigned Task", board_id: board.id });
    const session = await createTestWebSession(db, tenantId, { subjectId: "human-assigner" });
    env = {
      ...env,
      OIDC_ISSUER: issuer,
      INBOX_RESOURCE: inboxResource,
      INBOX_API_VERSION: "2026-08-31",
      OIDC_SERVICE_CLIENT_ID: "agent-kanban",
      OIDC_SERVICE_CLIENT_SECRET: "inbox-client-secret",
    };
    await realmrootAgentAuthority(`${resource}/task-assignments/${task.id}`, "PUT", "task:assign");

    const response = await api.fetch(
      new Request(`${resource}/task-assignments/${task.id}`, {
        method: "PUT",
        headers: {
          cookie: session.cookie,
          "x-csrf-token": session.csrfToken,
          "content-type": "application/json",
          "API-Version": "2026-08-29",
        },
        body: JSON.stringify({ agentActorId: "realmroot-agent-target" }),
      }),
      env,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      agentActorId: "realmroot-agent-target",
      assignedByActorId: "human-assigner",
    });
    expect(inboxMessageRequests).toHaveLength(1);
    await expect(db.prepare("SELECT assigned_to, assignee_identity_type FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({
      assigned_to: "realmroot-agent-target",
      assignee_identity_type: "realmroot_actor",
    });
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

  it.each(["assigned_to", "agent_id"] as const)("rejects Task create field %s before Task, action, or AMA side effects", async (field) => {
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

  it.each([
    ["claim", "task:claim"],
    ["assign", "task:assign"],
    ["release", "task:release"],
    ["review", "task:review"],
    ["complete", "task:complete"],
    ["reject", "task:reject"],
    ["cancel", "task:cancel"],
  ] as const)("does not expose the removed POST Task %s command to a Realmroot Agent", async (command, scope) => {
    const response = await request("POST", `/tasks/missing-task/${command}`, scope, {});

    expect(response.status).toBe(403);
    await expect(db.prepare("SELECT COUNT(*) AS count FROM task_actions").first()).resolves.toEqual({ count: 0 });
  });

  it.each(["assigned_to", "agent_id", "assignee_identity_type"] as const)(
    "rejects Task PATCH field %s without creating a wire or persisted assignment",
    async (field) => {
      const board = await createBoard(db, tenantId, `Rejected patch ${field}`, "ops");
      const task = await createTask(db, tenantId, { title: `Unassigned ${field}`, board_id: board.id });
      const before = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(task.id).first();

      const response = await request("PATCH", `/tasks/${task.id}`, "task:write", {
        [field]: field === "assignee_identity_type" ? "realmroot_actor" : "actor-not-assignable-by-patch",
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "FORBIDDEN",
          message: "Operation is not published by the Agent Kanban Resource Server",
        },
      });
      await expect(db.prepare("SELECT * FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual(before);
      const read = await request("GET", `/tasks/${task.id}`, "task:read");
      expect(read.status).toBe(200);
      const representation = (await read.json()) as Record<string, unknown>;
      expect(representation).toMatchObject({ assignedTo: null });
      expect(representation).not.toHaveProperty("assigneeIdentityType");
    },
  );

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

    const foreignTask = await createTask(db, foreignTenantId, { title: "Foreign Task", board_id: foreignBoard.id });
    const hidden = await request("POST", `/tasks/${foreignTask.id}/notes`, "task:write", { detail: "Must not write" });
    expect(hidden.status).toBe(404);
    await expect(
      db.prepare("SELECT COUNT(*) AS count FROM task_actions WHERE task_id = ? AND detail = ?").bind(foreignTask.id, "Must not write").first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("[spec: tasks/submit-review] lets the assigned Agent submit its Task through the HTTP resource", async () => {
    const board = await createBoard(db, tenantId, "Submit review", "ops");
    const task = await reviewReadyTask(tenantId, board.id, "Submit through HTTP", "actor-toolbox");

    const response = await request("PUT", `/task-review-submissions/${task.id}`, "task:review", undefined, true);

    expect(response.status, await response.clone().text()).toBe(201);
    const submission = (await response.json()) as { taskId: string; agentActorId: string; reviewSubmissionVersion: string };
    expect(submission).toMatchObject({ taskId: task.id, agentActorId: "actor-toolbox", reviewSubmissionVersion: expect.any(String) });
    expect(response.headers.get("ETag")).toBe(`"${submission.reviewSubmissionVersion}"`);
    await expect(db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({ status: "in_review" });
  });

  it("accepts an empty Toolbox Task Cancellation body without Content-Type and rejects an untyped non-empty body", async () => {
    const board = await createBoard(db, tenantId, "Cancellation route", "ops");
    const task = await createTask(db, tenantId, { title: "Cancel through HTTP", board_id: board.id });

    const response = await request("PUT", `/task-cancellations/${task.id}`, "task:cancel");

    expect(response.status, await response.clone().text()).toBe(201);
    expect(response.headers.get("Location")).toBe(`${resource}/task-cancellations/${task.id}`);
    expect(response.headers.get("ETag")).toMatch(/^".+"$/);
    await expect(response.json()).resolves.toMatchObject({ taskId: task.id, cancelledByActorId: "actor-toolbox" });
    await expect(db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({ status: "cancelled" });

    const invalidTask = await createTask(db, tenantId, { title: "Reject untyped body", board_id: board.id });
    const url = `${resource}/task-cancellations/${invalidTask.id}`;
    const authority = await realmrootAgentAuthority(url, "PUT", "task:cancel", "actor-toolbox");
    const invalidRequest = new Request(url, {
      method: "PUT",
      headers: {
        authorization: `DPoP ${authority.accessToken}`,
        dpop: authority.proof,
        "API-Version": "2026-08-29",
      },
      body: new TextEncoder().encode("{}"),
    });
    expect(invalidRequest.headers.get("Content-Type")).toBeNull();
    const invalid = await api.fetch(invalidRequest, env);
    expect(invalid.status).toBe(415);
    await expect(invalid.json()).resolves.toMatchObject({
      status: 415,
      type: `${resource}/problems/unsupported-media-type`,
    });
    await expect(db.prepare("SELECT status FROM tasks WHERE id = ?").bind(invalidTask.id).first()).resolves.toEqual({ status: "todo" });
  });

  it("[spec: tasks/reject-review] [spec: tasks/complete-review] lets a different human decide Review Submissions through HTTP", async () => {
    const board = await createBoard(db, tenantId, "Human review decisions", "ops");
    const session = await createTestWebSession(db, tenantId, { subjectId: "human-reviewer" });
    env = {
      ...env,
      OIDC_ISSUER: issuer,
      INBOX_RESOURCE: inboxResource,
      INBOX_API_VERSION: "2026-08-31",
      OIDC_SERVICE_CLIENT_ID: "agent-kanban",
      OIDC_SERVICE_CLIENT_SECRET: "inbox-client-secret",
    };
    await realmrootAgentAuthority(`${resource}/task-review-rejections/bootstrap`, "PUT", "task:reject");

    for (const kind of ["rejections", "completions"] as const) {
      const task = await reviewReadyTask(tenantId, board.id, `Human ${kind}`, "assigned-agent");
      const submitted = await replaceTaskReviewSubmission(d1TaskReviewSubmissionRepository(db), {
        ownerId: tenantId,
        taskId: task.id,
        agentActorId: "assigned-agent",
        pullRequestUrl: null,
      });
      const response = await api.fetch(
        new Request(`${resource}/task-review-${kind}/${task.id}`, {
          method: "PUT",
          headers: {
            cookie: session.cookie,
            "x-csrf-token": session.csrfToken,
            "API-Version": "2026-08-29",
            "content-type": "application/json",
          },
          body: JSON.stringify({ reviewSubmissionVersion: submitted.version, ...(kind === "rejections" ? { reason: "needs changes" } : {}) }),
        }),
        env,
      );

      expect(response.status, `${kind}: ${await response.clone().text()}`).toBe(201);
      await expect(db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({
        status: kind === "rejections" ? "in_progress" : "done",
      });
    }

    expect(machineTokenRequests).toHaveLength(2);
    expect(inboxMessageRequests).toHaveLength(2);
    const messages = await Promise.all(
      inboxMessageRequests.map(
        async (messageRequest) =>
          (await messageRequest.clone().json()) as {
            recipients: string[];
            content: { text: string };
          },
      ),
    );
    expect(messages.map(({ recipients }) => recipients)).toEqual([["agent:assigned-agent"], ["agent:assigned-agent"]]);
    expect(messages[0].content.text).toContain("review_rejected");
    expect(messages[1].content.text).toContain("completed");
  });

  it("rejects stale reviewSubmissionVersion bodies for rejection and completion", async () => {
    const board = await createBoard(db, tenantId, "Stale review decisions", "ops");
    const session = await createTestWebSession(db, tenantId, { subjectId: "stale-reviewer" });

    for (const kind of ["rejections", "completions"] as const) {
      const task = await reviewReadyTask(tenantId, board.id, `Stale ${kind}`, "assigned-agent");
      await replaceTaskReviewSubmission(d1TaskReviewSubmissionRepository(db), {
        ownerId: tenantId,
        taskId: task.id,
        agentActorId: "assigned-agent",
        pullRequestUrl: null,
      });

      const response = await reviewDecisionRequest(session, kind, task.id, {
        reviewSubmissionVersion: "stale-review-version",
        ...(kind === "rejections" ? { reason: "stale" } : {}),
      });

      expect(response.status, kind).toBe(412);
      await expect(response.json()).resolves.toMatchObject({ type: expect.stringContaining("task-review-precondition-failed") });
      await expect(db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({ status: "in_review" });
    }
  });

  it("rejects malformed rejection and completion bodies without changing the Task", async () => {
    const board = await createBoard(db, tenantId, "Malformed review decisions", "ops");
    const session = await createTestWebSession(db, tenantId, { subjectId: "malformed-reviewer" });

    for (const kind of ["rejections", "completions"] as const) {
      const task = await reviewReadyTask(tenantId, board.id, `Malformed ${kind}`, "assigned-agent");
      await replaceTaskReviewSubmission(d1TaskReviewSubmissionRepository(db), {
        ownerId: tenantId,
        taskId: task.id,
        agentActorId: "assigned-agent",
        pullRequestUrl: null,
      });

      const response = await reviewDecisionRequest(session, kind, task.id, {});

      expect(response.status, kind).toBe(422);
      await expect(response.json()).resolves.toMatchObject({ type: expect.stringContaining(`invalid-task-review-${kind.slice(0, -1)}`) });
      await expect(db.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({ status: "in_review" });
    }
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

  it("reads the current Task Review Submission with ETag and hides absent or cross-tenant submissions", async () => {
    const ownBoard = await createBoard(db, tenantId, "Review board", "ops");
    const ownTask = await reviewReadyTask(tenantId, ownBoard.id, "Current review", "actor-reviewer");
    const submitted = await replaceTaskReviewSubmission(d1TaskReviewSubmissionRepository(db), {
      ownerId: tenantId,
      taskId: ownTask.id,
      agentActorId: "actor-reviewer",
      pullRequestUrl: "https://github.com/example/repository/pull/42",
    });

    const current = await request("GET", `/task-review-submissions/${ownTask.id}`, "task:read", undefined, true);
    expect(current.status).toBe(200);
    expect(current.headers.get("ETag")).toBe(`"${submitted.version}"`);
    const currentBody = (await current.json()) as { reviewSubmissionVersion: string };
    expect(currentBody).toEqual(submitted.submission);
    expect(currentBody.reviewSubmissionVersion).toBe(submitted.version);
    expect(current.headers.get("ETag")).toBe(`"${currentBody.reviewSubmissionVersion}"`);

    const webSession = await createTestWebSession(db, tenantId);
    const webCurrent = await api.fetch(
      new Request(`${resource}/task-review-submissions/${ownTask.id}`, {
        headers: { cookie: webSession.cookie, "API-Version": "2026-08-29" },
      }),
      env,
    );
    expect(webCurrent.status).toBe(200);
    expect(webCurrent.headers.get("ETag")).toBe(`"${submitted.version}"`);
    await expect(webCurrent.json()).resolves.toEqual(submitted.submission);

    const withoutSubmission = await createTask(db, tenantId, { title: "No submission", board_id: ownBoard.id });
    const absent = await request("GET", `/task-review-submissions/${withoutSubmission.id}`, "task:read", undefined, true);
    await expectProblem(absent, "task-review-submission-not-found");

    const foreignBoard = await createBoard(db, foreignTenantId, "Foreign review", "ops");
    const foreignTask = await reviewReadyTask(foreignTenantId, foreignBoard.id, "Foreign current review", "actor-foreign");
    await replaceTaskReviewSubmission(d1TaskReviewSubmissionRepository(db), {
      ownerId: foreignTenantId,
      taskId: foreignTask.id,
      agentActorId: "actor-foreign",
      pullRequestUrl: null,
    });
    const hidden = await request("GET", `/task-review-submissions/${foreignTask.id}`, "task:read", undefined, true);
    await expectProblem(hidden, "task-not-found");
  });
});

async function reviewDecisionRequest(
  session: Awaited<ReturnType<typeof createTestWebSession>>,
  kind: "rejections" | "completions",
  taskId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return api.fetch(
    new Request(`${resource}/task-review-${kind}/${taskId}`, {
      method: "PUT",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken,
        "API-Version": "2026-08-29",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env,
  );
}

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
        oidcDiscoveryRequests += 1;
        return Response.json({
          issuer: authorityIssuer,
          authorization_endpoint: `${authorityIssuer}/oauth2/authorize`,
          token_endpoint: `${authorityIssuer}/oauth2/token`,
          jwks_uri: authorityJwksUri,
        });
      }
      if (url === authorityJwksUri) return Response.json({ keys: [issuerPublicJwk] });
      if (url === `${authorityIssuer}/oauth2/token`) {
        machineTokenRequests.push(request);
        return Response.json({ access_token: "inbox-machine-token" });
      }
      if (url === `${inboxResource}/messages`) {
        inboxMessageRequests.push(request);
        return new Response(null, { status: inboxResponseStatus });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const dpopKeys = await generateKeyPair("ES256", { extractable: true });
  const dpopPublicJwk = await exportJWK(dpopKeys.publicKey);
  const thumbprint = await calculateJwkThumbprint(dpopPublicJwk);
  const accessToken = await new SignJWT({
    scope,
    client_id: "realmroot-cli",
    cnf: { jkt: thumbprint },
    act: { iss: authorityIssuer, sub: actorId },
    "urn:realmroot:params:oauth:org": tenantId,
  })
    .setProtectedHeader({ alg: "ES256", kid: issuerPublicJwk.kid, typ: "at+jwt" })
    .setIssuer(authorityIssuer)
    .setAudience(resource)
    .setSubject("controller-toolbox")
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

async function expectProblem(response: Response, type: string): Promise<void> {
  expect(response.status).toBe(404);
  expect(response.headers.get("API-Version")).toBe("2026-08-29");
  await expect(response.json()).resolves.toMatchObject({ type: `${resource}/problems/${type}`, status: 404 });
}
