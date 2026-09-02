// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoard } from "../../../server/adapters/d1/boardRepo";
import { createTask } from "../../../server/adapters/d1/taskRepo";
import { d1TaskAssignmentRepository } from "../../../server/adapters/d1/tasks/d1TaskAssignments";
import type { Env } from "../../../server/env";
import { api } from "../../../server/http/app";
import { replaceTaskAssignment } from "../../../server/usecases/tasks/replaceTaskAssignment";
import { installCloudflareWebSocketTestGlobals, TestWebSocket } from "../../helpers/cloudflareWebSocket";
import { createTestEnv, createTestWebSession, seedUser, setupMiniflare } from "../../helpers/db";

const issuer = "https://id.realmroot.dev/api/auth";
const resource = "https://agent-kanban.test/api";
const tenantId = "tenant-runtime-provenance";
const actorId = "realmroot-agent-a";
const issuerKeysPromise = generateKeyPair("ES256", { extractable: true });

let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let db: D1Database;
let env: Env;

beforeEach(async () => {
  ({ mf, db } = await setupMiniflare());
  env = { ...createTestEnv(), DB: db, AK_PUBLIC_ORIGIN: new URL(resource).origin, OIDC_ISSUER: issuer } as Env;
  await seedUser(db, tenantId, "runtime-provenance@example.test");
  await stubIssuer();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await mf.dispose();
});

describe("verified Task runtime provenance", () => {
  it("rejects a non-empty Task Claim body without creating a Claim while preserving the empty-body contract", async () => {
    const board = await createBoard(db, tenantId, "Bodyless Claim", "ops");
    const task = await createTask(db, tenantId, { title: "Bodyless Claim Task", board_id: board.id });
    await replaceTaskAssignment(d1TaskAssignmentRepository(db), {
      ownerId: tenantId,
      taskId: task.id,
      assigneeActorId: actorId,
      assignedByActorId: "assigner-a",
    });
    const path = `/task-claims/${task.id}`;
    const binding = { runtime: "codex", session_id: "resume-bodyless" };

    const rejected = await agentRequest("PUT", path, "task:claim", binding, { rawBody: "{}" });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      status: 400,
      type: expect.stringContaining("request-body-not-allowed"),
    });
    await expect(db.prepare("SELECT active_claim_id FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({ active_claim_id: null });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM task_session_bindings WHERE task_id = ?").bind(task.id).first()).resolves.toEqual({
      count: 0,
    });

    const created = await agentRequest("PUT", path, "task:claim", binding);
    expect(created.status, await created.clone().text()).toBe(201);
  });

  it("[spec: session-observation/trusted-binding] [spec: tasks/claim] requires a signed canonical runtime binding and makes exact retries idempotent while rejecting mismatch", async () => {
    const board = await createBoard(db, tenantId, "Runtime provenance", "ops");
    const task = await createTask(db, tenantId, { title: "Claim from Remote", board_id: board.id });
    await replaceTaskAssignment(d1TaskAssignmentRepository(db), {
      ownerId: tenantId,
      taskId: task.id,
      assigneeActorId: actorId,
      assignedByActorId: "assigner-a",
    });
    const path = `/task-claims/${task.id}`;

    const missing = await agentRequest("PUT", path, "task:claim");
    expect(missing.status).toBe(403);
    await expect(missing.json()).resolves.toMatchObject({ type: expect.stringContaining("runtime-session-required") });

    const unsupported = await agentRequest("PUT", path, "task:claim", { runtime: "remote", session_id: "resume-unsupported" });
    expect([401, 403]).toContain(unsupported.status);
    await expect(db.prepare("SELECT active_claim_id FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({ active_claim_id: null });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM task_session_bindings WHERE task_id = ?").bind(task.id).first()).resolves.toEqual({
      count: 0,
    });

    const binding = { runtime: "codex", session_id: "resume-token-a" };
    const created = await agentRequest("PUT", path, "task:claim", binding);
    expect(created.status, await created.clone().text()).toBe(201);
    const etag = created.headers.get("etag");
    await expect(created.json()).resolves.toMatchObject({ runtime: "codex", runtimeSessionId: "resume-token-a" });
    await expect(
      db.prepare("SELECT agent_actor_id, runtime, runtime_session_id FROM task_session_bindings WHERE task_id = ?").bind(task.id).first(),
    ).resolves.toEqual({ agent_actor_id: actorId, runtime: "codex", runtime_session_id: "resume-token-a" });

    const retry = await agentRequest("PUT", path, "task:claim", binding);
    expect(retry.status).toBe(200);
    expect(retry.headers.get("etag")).toBe(etag);

    const mismatch = await agentRequest("PUT", path, "task:claim", { runtime: "codex", session_id: "resume-token-other" });
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toMatchObject({ type: expect.stringContaining("task-claim-conflict") });
  });

  it("[spec: session-observation/exact-session] denies Agent observation and returns unavailable to a human when Agency is not configured", async () => {
    const board = await createBoard(db, tenantId, "Unavailable observation", "ops");
    const task = await createTask(db, tenantId, { title: "Bound Task", board_id: board.id });
    await replaceTaskAssignment(d1TaskAssignmentRepository(db), {
      ownerId: tenantId,
      taskId: task.id,
      assigneeActorId: actorId,
      assignedByActorId: "assigner-a",
    });
    expect((await agentRequest("PUT", `/task-claims/${task.id}`, "task:claim", { runtime: "codex", session_id: "resume-token-a" })).status).toBe(201);
    const session = await createTestWebSession(db, tenantId);

    for (const suffix of ["session", "session/ws"]) {
      const agentResponse = await agentRequest("GET", `/tasks/${task.id}/${suffix}`, "task:read");
      expect(agentResponse.status, suffix).toBe(403);
      await expect(agentResponse.json()).resolves.toMatchObject({
        error: { code: "FORBIDDEN", message: "Operation is not published by the Agent Kanban Resource Server" },
      });

      const response = await api.fetch(
        new Request(`${resource}/tasks/${task.id}/${suffix}`, {
          headers: { cookie: session.cookie, "API-Version": "2026-08-29" },
        }),
        env,
      );
      expect(response.status, suffix).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "AMA_SESSION_UNAVAILABLE" } });
    }
  });

  it("[spec: session-observation/exact-session] resolves the stored binding exactly and maps missing, ambiguous, and upstream results", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const board = await createBoard(db, tenantId, "Exact Session observation", "ops");
    const task = await createTask(db, tenantId, { title: "Observe exact Agency Session", board_id: board.id });
    await replaceTaskAssignment(d1TaskAssignmentRepository(db), {
      ownerId: tenantId,
      taskId: task.id,
      assigneeActorId: actorId,
      assignedByActorId: "assigner-a",
    });
    const runtimeSessionId = "agency-runtime-session-exact";
    expect((await agentRequest("PUT", `/task-claims/${task.id}`, "task:claim", { runtime: "codex", session_id: runtimeSessionId })).status).toBe(201);
    const session = await createTestWebSession(db, tenantId);
    env = {
      ...env,
      AMA_ORIGIN: "https://agency.test",
      OIDC_SERVICE_CLIENT_ID: "ak-observer",
      OIDC_SERVICE_CLIENT_SECRET: "ak-observer-secret",
    };
    const issuerFetch = fetch;
    const agencyRequests: Request[] = [];
    let outcome: "exact" | "missing" | "ambiguous" | "upstream" | "malformed" = "exact";
    const agencySession = (uid: string) => ({
      metadata: {
        uid,
        projectId: "agency-project",
        name: "Observed Session",
        createdAt: "2026-08-31T00:00:00.000Z",
        updatedAt: "2026-08-31T00:01:00.000Z",
        archivedAt: null,
      },
      spec: { runtime: "codex" },
      status: { phase: "idle" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.href === `${issuer}/oauth2/token`) return Response.json({ access_token: "agency-observer-token" });
        if (url.origin !== "https://agency.test") return issuerFetch(input, init);
        agencyRequests.push(request);
        if (outcome === "upstream") return new Response("unavailable", { status: 502 });
        if (outcome === "malformed") return new Response("{malformed", { status: 200, headers: { "Content-Type": "application/json" } });
        const data =
          outcome === "missing"
            ? []
            : outcome === "ambiguous"
              ? [agencySession("session-a"), agencySession("session-b")]
              : [agencySession("session-exact")];
        return Response.json({ data, pagination: { limit: 2, nextCursor: null, hasMore: false } });
      }),
    );
    const observe = () =>
      api.fetch(
        new Request(`${resource}/tasks/${task.id}/session`, {
          headers: { cookie: session.cookie, "API-Version": "2026-08-29" },
        }),
        env,
      );

    const exact = await observe();
    expect(exact.status, await exact.clone().text()).toBe(200);
    await expect(exact.json()).resolves.toMatchObject({ metadata: { uid: "session-exact" }, spec: { runtime: "codex" } });
    const lookup = new URL(agencyRequests.at(-1)!.url);
    expect(Object.fromEntries(lookup.searchParams)).toEqual({
      agentActorId: actorId,
      runtime: "codex",
      runtimeSessionId,
      limit: "2",
    });
    expect(agencyRequests.at(-1)!.headers.get("Authorization")).toBe("Bearer agency-observer-token");

    for (const [nextOutcome, status, code] of [
      ["missing", 404, "AMA_SESSION_NOT_FOUND"],
      ["ambiguous", 409, "AMA_SESSION_AMBIGUOUS"],
      ["upstream", 503, "AMA_SESSION_UNAVAILABLE"],
      ["malformed", 503, "AMA_SESSION_UNAVAILABLE"],
    ] as const) {
      outcome = nextOutcome;
      const response = await observe();
      expect(response.status, nextOutcome).toBe(status);
      const responseBody = await response.json();
      expect(responseBody).toMatchObject({ error: { code } });
      if (status === 503) {
        expect(responseBody).toEqual({ error: { code: "AMA_SESSION_UNAVAILABLE", message: "Agency Session observation is unavailable" } });
      }
    }

    const completionEvents = consoleError.mock.calls
      .map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
      .filter((entry) => entry.name === "api" && entry.msg === "request completed" && entry.status === 503);
    expect(completionEvents).toHaveLength(2);
    expect(completionEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          result: "server_error",
          error_name: "AgencySessionObservationFailure",
          error_message: "Agency Session lookup failed with HTTP 502",
          error_stack: expect.stringContaining("Agency Session lookup failed with HTTP 502"),
        }),
        expect.objectContaining({
          result: "server_error",
          error_name: "AgencySessionObservationFailure",
          error_message: "Agency returned malformed Session JSON",
          error_stack: expect.stringContaining("Agency returned malformed Session JSON"),
          error_cause: expect.objectContaining({ name: "SyntaxError", message: expect.any(String), stack: expect.any(String) }),
        }),
      ]),
    );
  });

  it("[spec: session-observation/exact-session] relays only read-only backfill frames to the exact Agency Session socket", async () => {
    const board = await createBoard(db, tenantId, "Read-only Session relay", "ops");
    const task = await createTask(db, tenantId, { title: "Observe Agency socket", board_id: board.id });
    await replaceTaskAssignment(d1TaskAssignmentRepository(db), {
      ownerId: tenantId,
      taskId: task.id,
      assigneeActorId: actorId,
      assignedByActorId: "assigner-a",
    });
    const runtimeSessionId = "agency-runtime-session-socket";
    expect((await agentRequest("PUT", `/task-claims/${task.id}`, "task:claim", { runtime: "codex", session_id: runtimeSessionId })).status).toBe(201);
    const session = await createTestWebSession(db, tenantId);
    env = {
      ...env,
      AMA_ORIGIN: "https://agency.test",
      OIDC_SERVICE_CLIENT_ID: "ak-observer",
      OIDC_SERVICE_CLIENT_SECRET: "ak-observer-secret",
    };
    const issuerFetch = fetch;
    const upstream = new TestWebSocket();
    installCloudflareWebSocketTestGlobals(vi.stubGlobal);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.href === `${issuer}/oauth2/token`) return Response.json({ access_token: "agency-observer-token" });
        if (url.origin !== "https://agency.test") return issuerFetch(input, init);
        if (url.pathname.endsWith("/socket")) {
          expect(Object.fromEntries(url.searchParams)).toEqual({
            agentActorId: actorId,
            runtime: "codex",
            runtimeSessionId,
          });
          return new Response(null, { status: 101, webSocket: upstream } as ResponseInit & { webSocket: TestWebSocket });
        }
        return Response.json({
          data: [
            {
              metadata: {
                uid: "session-exact",
                projectId: "agency-project",
                name: "Observed Session",
                createdAt: "2026-08-31T00:00:00.000Z",
                updatedAt: "2026-08-31T00:01:00.000Z",
                archivedAt: null,
              },
              spec: { runtime: "codex" },
              status: { phase: "idle" },
            },
          ],
          pagination: { limit: 2, nextCursor: null, hasMore: false },
        });
      }),
    );
    const response = (await api.fetch(
      new Request(`${resource}/tasks/${task.id}/session/ws`, {
        headers: { cookie: session.cookie, "API-Version": "2026-08-29", Upgrade: "websocket" },
      }),
      env,
    )) as Response & { webSocket: TestWebSocket };
    expect(response.status).toBe(101);
    const browser = response.webSocket;
    const backfill = JSON.stringify({ type: "backfill", requestId: "request-1", limit: 100, cursor: 0 });
    browser.send(backfill);
    expect(upstream.sent).toEqual([backfill]);

    for (const type of ["prompt", "abort", "steer"] as const) {
      browser.send(JSON.stringify({ type, content: "must not reach Agency" }));
      expect(upstream.sent).toEqual([backfill]);
      expect(browser.received.at(-1)).toBe(JSON.stringify({ type: "error", code: "read_only", message: "Task Session observation is read-only" }));
    }
    upstream.emitMessage(JSON.stringify({ type: "event", sequence: 1 }));
    expect(browser.received.at(-1)).toBe(JSON.stringify({ type: "event", sequence: 1 }));
  });

  it("forbids another same-tenant Agent from releasing the Claim and lets the assignee release it", async () => {
    const board = await createBoard(db, tenantId, "Release authority", "ops");
    const task = await createTask(db, tenantId, { title: "Assignee-owned Claim", board_id: board.id });
    await replaceTaskAssignment(d1TaskAssignmentRepository(db), {
      ownerId: tenantId,
      taskId: task.id,
      assigneeActorId: actorId,
      assignedByActorId: "assigner-a",
    });
    const claim = await agentRequest("PUT", `/task-claims/${task.id}`, "task:claim", {
      runtime: "codex",
      session_id: "resume-owned",
    });
    expect(claim.status).toBe(201);
    const etag = claim.headers.get("etag");
    expect(etag).toBeTruthy();

    const foreignRelease = await agentRequest("DELETE", `/task-claims/${task.id}`, "task:release", undefined, {
      agentActorId: "realmroot-agent-other",
      ifMatch: etag!,
    });
    expect(foreignRelease.status).toBe(403);
    await expect(foreignRelease.json()).resolves.toMatchObject({ type: expect.stringContaining("task-claim-deletion-forbidden") });
    await expect(db.prepare("SELECT status, active_claim_id FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({
      status: "in_progress",
      active_claim_id: etag!.replaceAll('"', ""),
    });
    await expect(
      db.prepare("SELECT agent_actor_id, runtime_session_id FROM task_session_bindings WHERE task_id = ?").bind(task.id).first(),
    ).resolves.toEqual({ agent_actor_id: actorId, runtime_session_id: "resume-owned" });

    const assigneeRelease = await agentRequest("DELETE", `/task-claims/${task.id}`, "task:release", undefined, { ifMatch: etag! });
    expect(assigneeRelease.status).toBe(204);
    await expect(db.prepare("SELECT status, active_claim_id FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({
      status: "todo",
      active_claim_id: null,
    });
    await expect(db.prepare("SELECT * FROM task_session_bindings WHERE task_id = ?").bind(task.id).first()).resolves.toBeNull();
  });
});

async function agentRequest(
  method: string,
  path: string,
  scope: string,
  binding?: { runtime: string; session_id: string },
  options: { agentActorId?: string; ifMatch?: string; rawBody?: string } = {},
): Promise<Response> {
  const url = `${resource}${path}`;
  const authority = await agentAuthority(url, method, scope, binding, options.agentActorId);
  return api.fetch(
    new Request(url, {
      method,
      headers: {
        authorization: `DPoP ${authority.accessToken}`,
        dpop: authority.proof,
        "API-Version": "2026-08-29",
        ...(options.ifMatch ? { "If-Match": options.ifMatch } : {}),
        ...(options.rawBody === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.rawBody === undefined ? {} : { body: options.rawBody }),
    }),
    env,
  );
}

async function stubIssuer(): Promise<void> {
  const keys = await issuerKeysPromise;
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = "runtime-provenance-key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: RequestInfo | URL) => {
      const url = target instanceof Request ? target.url : String(target);
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`,
          jwks_uri: `${issuer}/jwks`,
        });
      }
      if (url === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
}

async function agentAuthority(htu: string, method: string, scope: string, binding?: { runtime: string; session_id: string }, agentActorId = actorId) {
  const issuerKeys = await issuerKeysPromise;
  const issuerJwk = await exportJWK(issuerKeys.publicKey);
  issuerJwk.kid = "runtime-provenance-key";
  const dpopKeys = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(dpopKeys.publicKey);
  const thumbprint = await calculateJwkThumbprint(publicJwk);
  const claims = {
    scope,
    client_id: "realmroot-cli",
    cnf: { jkt: thumbprint },
    act: { iss: issuer, sub: agentActorId },
    "urn:realmroot:params:oauth:org": tenantId,
    ...(binding ? { "urn:realmroot:params:agent:binding": binding } : {}),
  };
  const accessToken = await new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: issuerJwk.kid, typ: "at+jwt" })
    .setIssuer(issuer)
    .setAudience(resource)
    .setSubject("controller-a")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(issuerKeys.privateKey);
  const proof = await new SignJWT({ htu, htm: method, ath: createHash("sha256").update(accessToken).digest("base64url") })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk })
    .setJti(randomUUID())
    .setIssuedAt()
    .sign(dpopKeys.privateKey);
  return { accessToken, proof };
}
