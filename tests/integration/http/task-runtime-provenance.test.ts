// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoard } from "../../../server/adapters/d1/boardRepo";
import { createTask } from "../../../server/adapters/d1/taskRepo";
import { d1TaskAssignmentRepository } from "../../../server/adapters/d1/tasks/d1TaskAssignments";
import { storeWebSessionGrant } from "../../../server/adapters/realmroot/delegatedAgencyToken";
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
  it("creates, reads, and conditionally deletes the Task Claim subresource by claimId", async () => {
    const board = await createBoard(db, tenantId, "Claim subresource", "ops");
    const task = await createTask(db, tenantId, { title: "Claim subresource Task", board_id: board.id });
    await replaceTaskAssignment(d1TaskAssignmentRepository(db), {
      ownerId: tenantId,
      taskId: task.id,
      assigneeActorId: actorId,
      assignedByActorId: "assigner-a",
    });
    const binding = { runtime: "codex", session_id: "claim-subresource-session" };

    const created = await agentRequest("POST", `/tasks/${task.id}/claims`, "task:claim", binding, {
      idempotencyKey: "claim-subresource-create",
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const claim = (await created.json()) as { id: string; taskId: string; runtimeSessionId: string };
    expect(claim).toMatchObject({ id: expect.any(String), taskId: task.id, runtimeSessionId: binding.session_id });
    expect(created.headers.get("Location")).toBe(`${resource}/tasks/${task.id}/claims/${claim.id}`);
    expect(created.headers.get("ETag")).toBe(`"${claim.id}"`);

    const existing = await agentRequest("POST", `/tasks/${task.id}/claims`, "task:claim", binding, {
      idempotencyKey: "claim-subresource-existing",
    });
    expect(existing.status).toBe(200);
    expect(existing.headers.get("ETag")).toBe(`"${claim.id}"`);
    const existingBody = await existing.text();
    const replayed = await agentRequest("POST", `/tasks/${task.id}/claims`, "task:claim", binding, {
      idempotencyKey: "claim-subresource-existing",
    });
    expect(replayed.status).toBe(200);
    expect(replayed.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replayed.text()).toBe(existingBody);

    const read = await agentRequest("GET", `/tasks/${task.id}/claims/${claim.id}`, "task:read");
    expect(read.status).toBe(200);
    expect(read.headers.get("ETag")).toBe(`"${claim.id}"`);
    await expect(read.json()).resolves.toMatchObject({ id: claim.id, taskId: task.id });

    const stale = await agentRequest("DELETE", `/tasks/${task.id}/claims/${claim.id}`, "task:release", undefined, {
      ifMatch: '"stale-claim"',
    });
    expect(stale.status).toBe(412);
    await expect(stale.json()).resolves.toMatchObject({ type: expect.stringContaining("task-claim-precondition-failed") });

    const released = await agentRequest("DELETE", `/tasks/${task.id}/claims/${claim.id}`, "task:release", undefined, {
      ifMatch: `"${claim.id}"`,
    });
    expect(released.status).toBe(204);
    expect((await agentRequest("GET", `/tasks/${task.id}/claims/${claim.id}`, "task:read")).status).toBe(404);
  });

  it("rejects a non-empty Task Claim body without creating a Claim while preserving the empty-body contract", async () => {
    const board = await createBoard(db, tenantId, "Bodyless Claim", "ops");
    const task = await createTask(db, tenantId, { title: "Bodyless Claim Task", board_id: board.id });
    await replaceTaskAssignment(d1TaskAssignmentRepository(db), {
      ownerId: tenantId,
      taskId: task.id,
      assigneeActorId: actorId,
      assignedByActorId: "assigner-a",
    });
    const path = `/tasks/${task.id}/claims`;
    const binding = { runtime: "codex", session_id: "resume-bodyless" };

    const rejected = await agentRequest("POST", path, "task:claim", binding, { rawBody: "{}" });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      status: 400,
      type: expect.stringContaining("request-body-not-allowed"),
    });
    await expect(db.prepare("SELECT active_claim_id FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({ active_claim_id: null });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM task_session_bindings WHERE task_id = ?").bind(task.id).first()).resolves.toEqual({
      count: 0,
    });

    const created = await agentRequest("POST", path, "task:claim", binding);
    expect(created.status, await created.clone().text()).toBe(201);
  });

  it("[spec: session-observation/trusted-binding] [spec: tasks/claim] requires a signed canonical runtime binding and makes exact retries idempotent while rejecting mismatch", async () => {
    const board = await createBoard(db, tenantId, "Runtime provenance", "ops");
    const task = await createTask(db, tenantId, { title: "Claim from Agency Session", board_id: board.id });
    await replaceTaskAssignment(d1TaskAssignmentRepository(db), {
      ownerId: tenantId,
      taskId: task.id,
      assigneeActorId: actorId,
      assignedByActorId: "assigner-a",
    });
    const path = `/tasks/${task.id}/claims`;

    const missing = await agentRequest("POST", path, "task:claim");
    expect(missing.status).toBe(409);
    await expect(missing.json()).resolves.toMatchObject({ type: expect.stringContaining("runtime-session-required") });

    const unsupported = await agentRequest("POST", path, "task:claim", { runtime: "remote", session_id: "resume-unsupported" });
    expect([401, 403]).toContain(unsupported.status);
    await expect(db.prepare("SELECT active_claim_id FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({ active_claim_id: null });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM task_session_bindings WHERE task_id = ?").bind(task.id).first()).resolves.toEqual({
      count: 0,
    });

    const binding = { runtime: "codex", session_id: "resume-token-a" };
    const created = await agentRequest("POST", path, "task:claim", binding);
    expect(created.status, await created.clone().text()).toBe(201);
    const etag = created.headers.get("etag");
    await expect(created.json()).resolves.toMatchObject({ runtime: "codex", runtimeSessionId: "resume-token-a" });
    await expect(
      db.prepare("SELECT agent_actor_id, runtime, runtime_session_id FROM task_session_bindings WHERE task_id = ?").bind(task.id).first(),
    ).resolves.toEqual({ agent_actor_id: actorId, runtime: "codex", runtime_session_id: "resume-token-a" });

    const retry = await agentRequest("POST", path, "task:claim", binding);
    expect(retry.status).toBe(200);
    expect(retry.headers.get("etag")).toBe(etag);

    const mismatch = await agentRequest("POST", path, "task:claim", { runtime: "codex", session_id: "resume-token-other" });
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toMatchObject({ type: expect.stringContaining("task-claim-conflict") });
  });

  it("[spec: session-observation/exact-session] returns the same RFC Problem to token and browser Session callers when Agency is unavailable", async () => {
    delete env.AGENCY_ORIGIN;
    const board = await createBoard(db, tenantId, "Unavailable observation", "ops");
    const task = await createTask(db, tenantId, { title: "Bound Task", board_id: board.id });
    await replaceTaskAssignment(d1TaskAssignmentRepository(db), {
      ownerId: tenantId,
      taskId: task.id,
      assigneeActorId: actorId,
      assignedByActorId: "assigner-a",
    });
    expect((await agentRequest("POST", `/tasks/${task.id}/claims`, "task:claim", { runtime: "codex", session_id: "resume-token-a" })).status).toBe(
      201,
    );
    const session = await createTestWebSession(db, tenantId);

    for (const suffix of ["session", "session/ws"]) {
      const tokenResponse = await agentRequest("GET", `/tasks/${task.id}/${suffix}`, "task:read");
      const sessionResponse = await api.fetch(
        new Request(`${resource}/tasks/${task.id}/${suffix}`, {
          headers: { cookie: session.cookie, "API-Version": "2026-08-29" },
        }),
        env,
      );
      for (const response of [tokenResponse, sessionResponse]) {
        expect(response.status, suffix).toBe(503);
        expect(response.headers.get("content-type")).toContain("application/problem+json");
        await expect(response.json()).resolves.toMatchObject({
          type: `${resource}/problems/agency-session-unavailable`,
          title: "Agency Session unavailable",
          status: 503,
        });
      }
    }
  });

  it("[spec: session-observation/exact-session] resolves the canonical stored Session and maps boundary failures", async () => {
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
        await agentRequest("POST", `/tasks/${task.id}/claims`, "task:claim", {
          runtime: "codex",
          session_id: canonicalSessionId,
        })
      ).status,
    ).toBe(201);
    await db.prepare("INSERT INTO agency_owner_integrations (tenant_id, agency_project_id) VALUES (?, ?)").bind(tenantId, "agency-project").run();
    const session = await createTestWebSession(db, tenantId);
    env = {
      ...env,
      AGENCY_ORIGIN: "https://agency.test",
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
    expect(lookup.headers.get("X-Enbor-Project-ID")).toBe("agency-project");

    outcome = "mismatch";
    const mismatch = await observe();
    expect(mismatch.status).toBe(502);
    await expect(mismatch.json()).resolves.toMatchObject({
      type: `${resource}/problems/agency-session-invalid-response`,
      status: 502,
    });
    for (const [nextOutcome, status, problemType] of [
      ["missing", 404, "agency-session-not-found"],
      ["upstream", 503, "agency-session-unavailable"],
      ["malformed", 502, "agency-session-invalid-response"],
    ] as const) {
      outcome = nextOutcome;
      const response = await observe();
      expect(response.status, nextOutcome).toBe(status);
      expect(response.headers.get("content-type"), nextOutcome).toContain("application/problem+json");
      await expect(response.json()).resolves.toMatchObject({ type: `${resource}/problems/${problemType}`, status });
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
    expect((await agentRequest("POST", `/tasks/${task.id}/claims`, "task:claim", { runtime: "codex", session_id: runtimeSessionId })).status).toBe(
      201,
    );
    await db.prepare("INSERT INTO agency_owner_integrations (tenant_id, agency_project_id) VALUES (?, ?)").bind(tenantId, "agency-project").run();
    const session = await createTestWebSession(db, tenantId);
    env = {
      ...env,
      AGENCY_ORIGIN: "https://agency.test",
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
          expect(request.headers.get("X-Enbor-Project-ID")).toBe("agency-project");
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
    const claim = await agentRequest("POST", `/tasks/${task.id}/claims`, "task:claim", {
      runtime: "codex",
      session_id: "resume-owned",
    });
    expect(claim.status).toBe(201);
    const etag = claim.headers.get("etag");
    const claimId = ((await claim.clone().json()) as { id: string }).id;
    expect(etag).toBeTruthy();

    const foreignRelease = await agentRequest("DELETE", `/tasks/${task.id}/claims/${claimId}`, "task:release", undefined, {
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

    const staleRelease = await agentRequest("DELETE", `/tasks/${task.id}/claims/${claimId}`, "task:release", undefined, {
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

    const assigneeRelease = await agentRequest("DELETE", `/tasks/${task.id}/claims/${claimId}`, "task:release", undefined, { ifMatch: etag! });
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
  options: { agentActorId?: string; ifMatch?: string; rawBody?: string; idempotencyKey?: string } = {},
): Promise<Response> {
  const url = `${resource}${path}`;
  const authority = await agentAuthority(url, method, scope, binding, options.agentActorId);
  const idempotencyKey = options.idempotencyKey ?? (method === "POST" ? `test-${randomUUID()}` : undefined);
  return api.fetch(
    new Request(url, {
      method,
      headers: {
        authorization: `DPoP ${authority.accessToken}`,
        dpop: authority.proof,
        "API-Version": "2026-08-29",
        ...(options.ifMatch ? { "If-Match": options.ifMatch } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": JSON.stringify(idempotencyKey) } : {}),
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
