// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoard } from "../../../server/adapters/d1/boardRepo";
import { createTask } from "../../../server/adapters/d1/taskRepo";
import { d1TaskAssignmentRepository } from "../../../server/adapters/d1/tasks/d1TaskAssignments";
import { storeWebSessionGrant } from "../../../server/adapters/realmroot/delegatedAmaToken";
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
  vi.restoreAllMocks();
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
    delete env.AMA_ORIGIN;
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

  it("[spec: session-observation/exact-session] resolves the canonical stored Session and maps boundary failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const board = await createBoard(db, tenantId, "Exact Session observation", "ops");
    const task = await createTask(db, tenantId, { title: "Observe exact Agency Session", board_id: board.id });
    await replaceTaskAssignment(d1TaskAssignmentRepository(db), {
      ownerId: tenantId,
      taskId: task.id,
      assigneeActorId: actorId,
      assignedByActorId: "assigner-a",
    });
    const canonicalSessionId = "agency-session-canonical";
    expect(
      (
        await agentRequest("PUT", `/task-claims/${task.id}`, "task:claim", {
          runtime: "codex",
          session_id: canonicalSessionId,
        })
      ).status,
    ).toBe(201);
    await db.prepare("INSERT INTO ama_owner_integrations (tenant_id, ama_project_id) VALUES (?, ?)").bind(tenantId, "agency-project").run();
    const session = await createTestWebSession(db, tenantId);
    env = {
      ...env,
      AMA_ORIGIN: "https://agency.test",
      OIDC_SERVICE_CLIENT_ID: "ak-service",
      OIDC_SERVICE_CLIENT_SECRET: "ak-service-secret",
    };
    await storeWebSessionGrant(env, session.id, {
      access_token: "browser-ak-token",
      refresh_token: "browser-refresh-token",
      expires_in: 300,
    });
    const issuerFetch = fetch;
    const agencyRequests: Request[] = [];
    let outcome: "exact" | "missing" | "mismatch" | "upstream" | "malformed" = "exact";
    const agencySession = (projectId = "agency-project") => ({
      metadata: {
        uid: canonicalSessionId,
        projectId,
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
        if (url.href === `${issuer}/oauth2/token`) return Response.json({ access_token: "agency-session-token" });
        if (url.origin !== "https://agency.test") return issuerFetch(input, init);
        agencyRequests.push(request);
        if (outcome === "missing") return new Response(null, { status: 404 });
        if (outcome === "upstream") return new Response("unavailable", { status: 502 });
        if (outcome === "malformed") return new Response("{malformed", { status: 200 });
        return Response.json(agencySession(outcome === "mismatch" ? "other-project" : undefined));
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
    await expect(exact.json()).resolves.toMatchObject({
      metadata: { uid: canonicalSessionId, projectId: "agency-project" },
      spec: { runtime: "codex" },
    });
    const lookup = agencyRequests.at(-1)!;
    expect(new URL(lookup.url).href).toBe(`https://agency.test/api/v1/sessions/${canonicalSessionId}`);
    expect([...new URL(lookup.url).searchParams]).toEqual([]);
    expect(lookup.headers.get("Authorization")).toBe("Bearer agency-session-token");
    expect(lookup.headers.get("X-AMA-Project-ID")).toBe("agency-project");

    consoleError.mockClear();
    outcome = "mismatch";
    const mismatch = await observe();
    expect(mismatch.status).toBe(503);
    await expect(mismatch.json()).resolves.toEqual({
      error: {
        code: "AMA_SESSION_UNAVAILABLE",
        message: "Agency Session observation is unavailable",
      },
    });
    const mismatchCompletion = consoleError.mock.calls
      .map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
      .filter((entry) => entry.msg === "request completed" && entry.status === 503);
    expect(mismatchCompletion).toEqual([
      expect.objectContaining({
        result: "server_error",
        error_name: "AgencySessionObservationFailure",
        error_message: "Agency returned a Session outside the requested identity or Project",
        error_stack: expect.stringContaining("Agency returned a Session outside the requested identity or Project"),
      }),
    ]);

    for (const [nextOutcome, status, code] of [
      ["missing", 404, "AMA_SESSION_NOT_FOUND"],
      ["upstream", 503, "AMA_SESSION_UNAVAILABLE"],
      ["malformed", 503, "AMA_SESSION_UNAVAILABLE"],
    ] as const) {
      outcome = nextOutcome;
      const response = await observe();
      expect(response.status, nextOutcome).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ error: { code } });
    }
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
    await db.prepare("INSERT INTO ama_owner_integrations (tenant_id, ama_project_id) VALUES (?, ?)").bind(tenantId, "agency-project").run();
    const session = await createTestWebSession(db, tenantId);
    env = {
      ...env,
      AMA_ORIGIN: "https://agency.test",
      OIDC_SERVICE_CLIENT_ID: "ak-service",
      OIDC_SERVICE_CLIENT_SECRET: "ak-service-secret",
    };
    await storeWebSessionGrant(env, session.id, {
      access_token: "browser-ak-token",
      refresh_token: "browser-refresh-token",
      expires_in: 300,
    });
    const issuerFetch = fetch;
    const upstream = new TestWebSocket();
    installCloudflareWebSocketTestGlobals(vi.stubGlobal);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.href === `${issuer}/oauth2/token`) return Response.json({ access_token: "agency-session-token" });
        if (url.origin !== "https://agency.test") return issuerFetch(input, init);
        if (url.pathname.endsWith("/socket")) {
          expect(url.href).toBe(`https://agency.test/api/v1/sessions/${runtimeSessionId}/socket`);
          expect([...url.searchParams]).toEqual([]);
          expect(request.headers.get("Authorization")).toBe("Bearer agency-session-token");
          expect(request.headers.get("X-AMA-Project-ID")).toBe("agency-project");
          return new Response(null, { status: 101, webSocket: upstream } as ResponseInit & { webSocket: TestWebSocket });
        }
        return Response.json({
          metadata: {
            uid: runtimeSessionId,
            projectId: "agency-project",
            name: "Observed Session",
            createdAt: "2026-08-31T00:00:00.000Z",
            updatedAt: "2026-08-31T00:01:00.000Z",
            archivedAt: null,
          },
          spec: { runtime: "codex" },
          status: { phase: "idle" },
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

  it("[spec: tasks/release] forbids another same-tenant Agent from releasing the Claim and lets the assignee release it", async () => {
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

    const staleRelease = await agentRequest("DELETE", `/task-claims/${task.id}`, "task:release", undefined, {
      ifMatch: '"stale-claim-id"',
    });
    expect(staleRelease.status).toBe(412);
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
