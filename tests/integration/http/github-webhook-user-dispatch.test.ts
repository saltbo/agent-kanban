import { createBoard } from "@server/adapters/d1/boardRepo";
import { createTask, getTask } from "@server/adapters/d1/taskRepo";
import { commitTaskClaim } from "@server/adapters/d1/tasks/d1TaskClaims";
import { d1TaskReviewSubmissionRepository } from "@server/adapters/d1/tasks/d1TaskReviewSubmissions";
import { storeWebSessionGrant } from "@server/adapters/realmroot/delegatedAgencyToken";
import type { Env } from "@server/env";
import { api } from "@server/http/app";
import { replaceTaskReviewSubmission } from "@server/usecases/tasks/replaceTaskReviewSubmission";
import { afterEach, expect, it, vi } from "vitest";
import { createTestEnv, createTestWebSession, seedUser, setupMiniflare } from "../../helpers/db";

let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
afterEach(async () => {
  vi.unstubAllGlobals();
  await mf?.dispose();
});

it.each([true, false])(
  "[spec: repositories/pull-request-update] dispatches after a signed PR webhook using each Task user grant after logout (merged: %s)",
  async (merged) => {
    const setup = await setupMiniflare();
    mf = setup.mf;
    const db = setup.db;
    const ownerId = "webhook-tenant";
    await seedUser(db, ownerId, "webhook@example.test");
    const env = { ...createTestEnv(), DB: db, GITHUB_APP_WEBHOOK_SECRET: "webhook-secret" } as Env;
    await db.prepare("INSERT INTO agency_owner_integrations (tenant_id, agency_project_id) VALUES (?, ?)").bind(ownerId, "project-1").run();
    const firstUser = await createTestWebSession(db, ownerId, { subjectId: "user-1" });
    const secondUser = await createTestWebSession(db, ownerId, { subjectId: "user-2" });
    await storeWebSessionGrant(env, firstUser.id, { access_token: "user-1-token", refresh_token: "user-1-refresh", expires_in: 300 });
    await storeWebSessionGrant(env, secondUser.id, { access_token: "user-2-token", refresh_token: "user-2-refresh", expires_in: 300 });
    const board = await createBoard(db, ownerId, "Webhook", "ops");
    const parent = await createTask(db, ownerId, { title: "First", board_id: board.id });
    const dependent = await createTask(db, ownerId, { title: "Second", board_id: board.id, depends_on: [parent.id] });
    const anotherDependent = await createTask(db, ownerId, { title: "Third", board_id: board.id, depends_on: [parent.id] });
    const sessionCreates: string[] = [];
    const sessionCloses: string[] = [];
    let refreshes = 0;
    const exchangedSubjects: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (target: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(target, init);
        const url = new URL(request.url);
        if (url.pathname.endsWith("/.well-known/openid-configuration"))
          return Response.json({ issuer: env.OIDC_ISSUER, token_endpoint: `${env.OIDC_ISSUER}/token` });
        if (url.pathname.endsWith("/token")) {
          const body = new URLSearchParams(await request.text());
          expect(request.headers.get("authorization")).toBe(`Basic ${btoa(`${env.OIDC_WEB_CLIENT_ID}:${env.OIDC_WEB_CLIENT_SECRET}`)}`);
          if (body.get("grant_type") === "refresh_token") {
            expect(body.get("refresh_token")).toBe("user-1-refresh");
            refreshes++;
            return Response.json({ access_token: "user-1-refreshed", refresh_token: "user-1-rotated", expires_in: 300 });
          }
          expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
          const subject = body.get("subject_token")!;
          exchangedSubjects.push(subject);
          expect(["user-1-token", "user-1-refreshed", "user-2-token"]).toContain(subject);
          return Response.json({ access_token: subject.startsWith("user-1") ? "enbor-user-1" : "enbor-user-2", expires_in: 300 });
        }
        expect(request.headers.get("x-enbor-project-id")).toBe("project-1");
        if (url.pathname === "/api/v1/agents")
          return Response.json({
            data: [{ metadata: { uid: "agent-1", projectId: "project-1" }, spec: { identity: { issuer: env.OIDC_ISSUER, subject: "actor-1" } } }],
            pagination: { nextCursor: null },
          });
        if (url.pathname === "/api/v1/sessions" && request.method === "POST") {
          const body = (await request.json()) as { metadata: { annotations: Record<string, string> } };
          const taskId = body.metadata.annotations["agent-kanban.dev/task-id"];
          sessionCreates.push(taskId);
          expect(request.headers.get("authorization")).toBe(`Bearer enbor-user-${taskId === parent.id ? "1" : "2"}`);
          return Response.json(
            { metadata: { uid: taskId === parent.id ? "first-session" : "second-session", projectId: "project-1" } },
            { status: 201 },
          );
        }
        if (url.pathname === "/api/v1/sessions/first-session" && request.method === "PATCH") {
          expect(request.headers.get("authorization")).toBe("Bearer enbor-user-1");
          expect(await request.json()).toEqual({ state: "closed" });
          sessionCloses.push("first-session");
          return Response.json({ metadata: { uid: "first-session", projectId: "project-1" } });
        }
        throw new Error(`Unexpected call ${request.method} ${url.pathname}`);
      }),
    );
    async function assign(id: string, user: typeof firstUser) {
      const response = await api.request(
        `/api/tasks/${id}`,
        {
          method: "PATCH",
          headers: {
            cookie: user.cookie,
            "x-csrf-token": user.csrfToken,
            "content-type": "application/merge-patch+json",
            "API-Version": "2026-08-29",
          },
          body: JSON.stringify({ assignedTo: "actor-1" }),
        },
        env,
      );
      expect(response.status, await response.clone().text()).toBe(200);
    }
    await assign(parent.id, firstUser);
    await assign(dependent.id, secondUser);
    await assign(anotherDependent.id, secondUser);
    expect(sessionCreates).toEqual([parent.id]);
    await commitTaskClaim(db, {
      ownerId,
      taskId: parent.id,
      actorType: "realmroot:agent",
      actorId: "actor-1",
      runtime: "codex",
      runtimeSessionId: "first-session",
    });
    await replaceTaskReviewSubmission(d1TaskReviewSubmissionRepository(db), {
      ownerId,
      taskId: parent.id,
      agentActorId: "actor-1",
      pullRequestUrl: "https://github.com/example/repo/pull/1",
    });
    for (const user of [firstUser, secondUser]) {
      const logout = await api.request("/api/auth/logout", { method: "POST", headers: { cookie: user.cookie, "x-csrf-token": user.csrfToken } }, env);
      expect(logout.status).toBe(204);
    }
    await expect(db.prepare("SELECT COUNT(*) AS count FROM realmroot_web_sessions").first()).resolves.toEqual({ count: 0 });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM realmroot_user_grants").first()).resolves.toEqual({ count: 2 });
    await db.prepare("UPDATE realmroot_user_grants SET access_token_expires_at = '2000-01-01T00:00:00Z' WHERE subject_id = 'user-1'").run();
    const body = JSON.stringify({ action: "closed", pull_request: { html_url: "https://github.com/example/repo/pull/1", merged } });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.GITHUB_APP_WEBHOOK_SECRET!),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const signature = `sha256=${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    const webhook = () =>
      api.request(
        "/api/webhooks/github-app",
        { method: "POST", headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": signature }, body },
        env,
      );
    const result = await webhook();
    expect(result.status, await result.clone().text()).toBe(200);
    expect(sessionCreates[0]).toBe(parent.id);
    expect(sessionCreates.slice(1).sort()).toEqual([dependent.id, anotherDependent.id].sort());
    expect(sessionCloses).toEqual(["first-session"]);
    expect(refreshes).toBe(1);
    expect(exchangedSubjects).toContain("user-1-refreshed");
    expect((await getTask(db, parent.id, ownerId))?.status).toBe(merged ? "done" : "cancelled");
    expect((await getTask(db, dependent.id, ownerId))?.metadata.annotations).toMatchObject({ "agent-kanban.dev/session-id": "second-session" });
    const repeated = await webhook();
    expect(repeated.status, await repeated.clone().text()).toBe(200);
    expect(sessionCreates).toHaveLength(3);
    expect(sessionCloses).toHaveLength(1);
  },
  30_000,
);
