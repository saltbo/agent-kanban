import { generateKeyPairSync } from "node:crypto";
import { createBoard } from "@server/adapters/d1/boardRepo";
import { createRepository } from "@server/adapters/d1/repositoryRepo";
import { createTask } from "@server/adapters/d1/taskRepo";
import { d1TaskAssignmentRepository } from "@server/adapters/d1/tasks/d1TaskAssignments";
import { commitTaskClaim } from "@server/adapters/d1/tasks/d1TaskClaims";
import { d1TaskReviewSubmissionRepository } from "@server/adapters/d1/tasks/d1TaskReviewSubmissions";
import { upsertInstallation } from "@server/adapters/github/githubInstallations";
import { storeWebSessionGrant } from "@server/adapters/realmroot/delegatedAgencyToken";
import type { Env } from "@server/env";
import { api } from "@server/http/app";
import { replaceTaskAssignment } from "@server/usecases/tasks/replaceTaskAssignment";
import { replaceTaskReviewSubmission } from "@server/usecases/tasks/replaceTaskReviewSubmission";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEnv, createTestWebSession, seedUser, setupMiniflare } from "../../helpers/db";

const resources: Array<Awaited<ReturnType<typeof setupMiniflare>>["mf"]> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(resources.splice(0).map((resource) => resource.dispose()));
});

describe("direct Task dispatch", () => {
  it.each([false, true])(
    "[spec: tasks/assign] [spec: tasks/repository-bootstrap] [spec: tasks/settle-launch] [spec: tasks/reject-review] directly launches once without Inbox (repository: %s)",
    async (withRepository) => {
      const { mf, db } = await setupMiniflare();
      resources.push(mf);
      const ownerId = "direct-owner";
      await seedUser(db, ownerId, "direct@example.test");
      const env = { ...createTestEnv(), DB: db } as Env;
      const browser = await createTestWebSession(db, ownerId);
      await storeWebSessionGrant(env, browser.id, { access_token: "source-ak-token", refresh_token: "source-refresh", expires_in: 300 });
      await db.prepare("INSERT INTO agency_owner_integrations (tenant_id, agency_project_id) VALUES (?, ?)").bind(ownerId, "project-1").run();
      const board = await createBoard(db, ownerId, "Direct dispatch", withRepository ? "dev" : "ops");
      let repositoryId: string | undefined;
      if (withRepository) {
        repositoryId = (await createRepository(db, ownerId, { name: "Source", url: "https://github.com/example/source" })).id;
        await upsertInstallation(db, {
          installationId: 42,
          ownerId,
          accountId: 7,
          accountLogin: "example",
          accountType: "Organization",
          repositorySelection: "selected",
        });
        env.GITHUB_APP_ID = "123";
        env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", {
          modulusLength: 2048,
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
          publicKeyEncoding: { type: "spki", format: "pem" },
        }).privateKey;
      }
      const task = await createTask(db, ownerId, { title: "Immediate Task", board_id: board.id, repository_id: repositoryId });
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      let credential: Record<string, unknown> | undefined;
      const other = await createTask(db, ownerId, { title: "Other pending Task", board_id: board.id, repository_id: repositoryId });
      await replaceTaskAssignment(d1TaskAssignmentRepository(db), {
        ownerId,
        taskId: other.id,
        assigneeActorId: "other-agent",
        assignedByActorId: "manager",
      });
      const calls: string[] = [];
      let cancelling = false;
      let reviewing = false;
      let deliveredReviewContent: string | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (target: RequestInfo | URL, init?: RequestInit) => {
          const outgoing = new Request(target, init);
          const url = new URL(outgoing.url);
          calls.push(`${outgoing.method} ${url.pathname}`);
          if (url.origin === "https://api.github.com") {
            if (url.pathname === "/app/installations/42")
              return Response.json({ id: 42, account: { id: 7, login: "example", type: "Organization" }, suspended_at: null });
            if (url.pathname === "/app/installations/42/access_tokens") {
              expect(await outgoing.json()).toEqual({ repositories: ["source"], permissions: { contents: "read" } });
              return Response.json({ token: "bootstrap-only-token", expires_at: expiresAt });
            }
            expect(url.pathname).toBe("/repos/example/source");
            expect(outgoing.headers.get("authorization")).toBe("Bearer bootstrap-only-token");
            return Response.json({ id: 99, owner: { id: 7 }, full_name: "example/source", default_branch: "main" });
          }
          if (url.pathname.endsWith("/.well-known/openid-configuration"))
            return Response.json({ issuer: env.OIDC_ISSUER, token_endpoint: `${env.OIDC_ISSUER}/token` });
          if (url.pathname.endsWith("/token")) {
            const body = new URLSearchParams(await outgoing.text());
            expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
            expect(body.get("subject_token")).toBe("source-ak-token");
            expect(body.get("scope")).toBe(
              reviewing
                ? "sessions:read sessions:write"
                : cancelling
                  ? withRepository
                    ? "sessions:write vaults:read vaults:write"
                    : "sessions:write"
                  : withRepository
                    ? "agents:read sessions:write vaults:read vaults:write"
                    : "agents:read sessions:write",
            );
            return Response.json({ access_token: "enbor-delegation", expires_in: 300 });
          }
          expect(outgoing.headers.get("authorization")).toBe("Bearer enbor-delegation");
          expect(outgoing.headers.get("x-enbor-project-id")).toBe("project-1");
          if (url.pathname === "/api/v1/vaults" || url.pathname === "/api/v1/vaults/vault-1") {
            if (outgoing.method === "POST") expect(await outgoing.json()).toMatchObject({ spec: { scope: "project" } });
            return Response.json({ metadata: { uid: "vault-1", projectId: "project-1" }, spec: { scope: "project" } });
          }
          if (url.pathname === "/api/v1/vaults/vault-1/credentials") {
            if (outgoing.method === "GET")
              return Response.json({
                data:
                  cancelling && !reviewing && credential
                    ? [credential, { ...credential, metadata: { uid: "foreign-credential", projectId: "other-project", name: "unrelated" } }]
                    : [],
                pagination: { nextCursor: null },
              });
            const input = (await outgoing.json()) as {
              name: string;
              type: string;
              metadata: Record<string, unknown>;
              secret: { stringData: unknown; metadata: unknown };
            };
            expect(input.type).toBe("enbor.dev/basic-auth");
            expect(input.secret.stringData).toEqual({ username: "x-access-token", password: "bootstrap-only-token" });
            credential = {
              metadata: { uid: "credential-1", projectId: "project-1", name: input.name },
              spec: { vaultId: "vault-1", metadata: input.metadata },
              status: { phase: "active", activeVersion: { spec: { metadata: input.secret.metadata } } },
            };
            return Response.json(credential, { status: 201 });
          }
          if (url.pathname === "/api/v1/vaults/vault-1/credentials/credential-1") {
            if (outgoing.method !== "GET") {
              expect(await outgoing.json()).toMatchObject({ state: "revoked" });
              expect(calls).toContain("PATCH /api/v1/sessions/session-1");
            }
            return Response.json(credential);
          }
          if (url.pathname === "/api/v1/sessions/session-1/messages") {
            if (outgoing.method === "GET")
              return Response.json({
                data: deliveredReviewContent
                  ? [{ id: "message-1", sessionId: "session-1", type: "prompt", content: deliveredReviewContent, state: "accepted" }]
                  : [],
                pagination: { nextCursor: null },
              });
            const body = await outgoing.json();
            expect(body).toMatchObject({
              type: "prompt",
              requestId: expect.stringMatching(/^ak-review-/),
              content: expect.stringContaining("Fix the result"),
            });
            deliveredReviewContent = (body as { content: string }).content;
            if (!withRepository) return Response.json({ error: "Response failed after acceptance" }, { status: 503 });
            return Response.json({ metadata: { uid: "message-1" }, status: { state: "accepted" } }, { status: 201 });
          }
          if (url.pathname === "/api/v1/sessions/session-1") {
            expect(await outgoing.json()).toEqual({ state: "closed" });
            return Response.json({ metadata: { uid: "session-1", projectId: "project-1" } });
          }
          if (url.pathname === "/api/v1/agents")
            return Response.json({
              data: [
                {
                  metadata: { uid: "enbor-agent", projectId: "project-1" },
                  spec: { identity: { issuer: env.OIDC_ISSUER, subject: "target-agent" } },
                },
              ],
              pagination: { nextCursor: null },
            });
          if (url.pathname === "/api/v1/sessions") {
            const request = (await outgoing.json()) as { spec: unknown; prompt: string };
            expect(request.spec).toEqual(
              withRepository
                ? {
                    agentId: "enbor-agent",
                    volumes: [
                      {
                        name: "task-repository",
                        type: "git_repository",
                        url: "https://github.com/example/source.git",
                        ref: "main",
                        secretRef: "enbor://vaults/vault-1/credentials/credential-1",
                      },
                    ],
                    volumeMounts: [{ name: "task-repository", mountPath: "/workspace/repos/github.com/example/source" }],
                  }
                : { agentId: "enbor-agent" },
            );
            expect(JSON.stringify(request)).not.toContain("bootstrap-only-token");
            expect(request.prompt).toContain(task.id);
            expect(request.prompt).not.toContain(other.id);
            expect(outgoing.headers.get("idempotency-key")).toBeTruthy();
            return Response.json({ metadata: { uid: "session-1", projectId: "project-1" } }, { status: 201 });
          }
          throw new Error(`Unexpected upstream request: ${outgoing.method} ${url.pathname}`);
        }),
      );
      const assign = () =>
        api.fetch(
          new Request(`${env.AK_PUBLIC_ORIGIN}/api/tasks/${task.id}`, {
            method: "PATCH",
            headers: {
              cookie: browser.cookie,
              "x-csrf-token": browser.csrfToken,
              "API-Version": "2026-08-29",
              "content-type": "application/merge-patch+json",
            },
            body: JSON.stringify({ assignedTo: "target-agent" }),
          }),
          env,
        );
      const first = await assign();
      expect(first.status, await first.clone().text()).toBe(200);
      await expect(first.json()).resolves.toMatchObject({
        status: "todo",
        metadata: { annotations: { "agent-kanban.dev/session-id": "session-1" } },
      });
      const stored = await db.prepare("SELECT metadata FROM tasks WHERE id = ?").bind(task.id).first<{ metadata: string }>();
      expect(stored?.metadata).not.toContain("bootstrap-only-token");
      const repeated = await assign();
      expect(repeated.status, await repeated.clone().text()).toBe(200);
      expect(calls.filter((call) => call === "POST /api/v1/sessions")).toHaveLength(1);
      expect(calls.some((call) => call.includes("messages"))).toBe(false);
      await expect(
        db
          .prepare(`SELECT json_extract(metadata, '$.annotations."agent-kanban.dev/session-id"') AS session_id FROM tasks WHERE id = ?`)
          .bind(other.id)
          .first(),
      ).resolves.toEqual({ session_id: null });
      await expect(db.prepare("SELECT COUNT(*) AS count FROM task_session_bindings WHERE task_id = ?").bind(task.id).first()).resolves.toEqual({
        count: 0,
      });
      cancelling = true;
      await commitTaskClaim(db, {
        ownerId,
        taskId: task.id,
        actorType: "realmroot:agent",
        actorId: "target-agent",
        runtime: "codex",
        runtimeSessionId: "session-1",
      });
      await replaceTaskReviewSubmission(d1TaskReviewSubmissionRepository(db), {
        ownerId,
        taskId: task.id,
        agentActorId: "target-agent",
        pullRequestUrl: null,
      });
      reviewing = true;
      const reject = () =>
        api.fetch(
          new Request(`${env.AK_PUBLIC_ORIGIN}/api/tasks/${task.id}`, {
            method: "PATCH",
            headers: {
              cookie: browser.cookie,
              "x-csrf-token": browser.csrfToken,
              "API-Version": "2026-08-29",
              "content-type": "application/merge-patch+json",
            },
            body: JSON.stringify({ status: "in-progress", statusReason: "Fix the result" }),
          }),
          env,
        );
      const rejected = await reject();
      expect(rejected.status, await rejected.clone().text()).toBe(withRepository ? 200 : 503);
      expect((await reject()).status).toBe(200);
      expect(calls.filter((call) => call === "POST /api/v1/sessions/session-1/messages")).toHaveLength(1);

      reviewing = false;
      if (withRepository) {
        // Reproduce a credential created remotely without a recorded secretRef.
        await db
          .prepare(
            `UPDATE tasks SET metadata = json_set(metadata, '$."agent-kanban.dev/launch".secret_ref', NULL, '$."agent-kanban.dev/launch".bootstrap_json', NULL) WHERE id = ?`,
          )
          .bind(task.id)
          .run();
      }
      const cancel = () =>
        api.fetch(
          new Request(`${env.AK_PUBLIC_ORIGIN}/api/tasks/${task.id}`, {
            method: "PATCH",
            headers: {
              cookie: browser.cookie,
              "x-csrf-token": browser.csrfToken,
              "API-Version": "2026-08-29",
              "content-type": "application/merge-patch+json",
            },
            body: JSON.stringify({ status: "cancelled" }),
          }),
          env,
        );
      const cancelled = await cancel();
      expect(cancelled.status, await cancelled.clone().text()).toBe(200);
      await expect(cancelled.json()).resolves.toMatchObject({ status: "cancelled", metadata: { "agent-kanban.dev/launch": { state: "settled" } } });
      expect(calls.filter((call) => call === "PATCH /api/v1/sessions/session-1")).toHaveLength(1);
      expect(calls.filter((call) => call === "PATCH /api/v1/vaults/vault-1/credentials/credential-1")).toHaveLength(withRepository ? 1 : 0);
      expect((await cancel()).status).toBe(200);
      expect(calls.filter((call) => call === "PATCH /api/v1/sessions/session-1")).toHaveLength(1);
    },
  );
});

it.each([false, true])(
  "[spec: tasks/reassign-launch] [spec: tasks/launch-eligibility] retires the previous Session before replacement and fences its late Claim (cleanup failure: %s)",
  async (failCleanup) => {
    const { mf, db } = await setupMiniflare();
    resources.push(mf);
    const ownerId = "replacement-owner";
    await seedUser(db, ownerId, "replacement@example.test");
    const env = { ...createTestEnv(), DB: db } as Env;
    const browser = await createTestWebSession(db, ownerId);
    await storeWebSessionGrant(env, browser.id, { access_token: "source", refresh_token: "refresh", expires_in: 300 });
    await db.prepare("INSERT INTO agency_owner_integrations (tenant_id, agency_project_id) VALUES (?, ?)").bind(ownerId, "project-1").run();
    const board = await createBoard(db, ownerId, "Replacement", "ops");
    const prerequisite = await createTask(db, ownerId, { title: "Prerequisite", board_id: board.id });
    const task = await createTask(db, ownerId, { title: "Reassign before Claim", board_id: board.id, depends_on: [prerequisite.id] });
    const events: string[] = [];
    const scopes: string[] = [];
    const keys: string[] = [];
    let failed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (target: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(target, init);
        const url = new URL(request.url);
        if (url.pathname.endsWith("/.well-known/openid-configuration"))
          return Response.json({ issuer: env.OIDC_ISSUER, token_endpoint: `${env.OIDC_ISSUER}/token` });
        if (url.pathname.endsWith("/token")) {
          const body = new URLSearchParams(await request.text());
          scopes.push(body.get("scope")!);
          expect(body.get("subject_token")).toBe("source");
          return Response.json({ access_token: "delegated", expires_in: 300 });
        }
        expect(request.headers.get("authorization")).toBe("Bearer delegated");
        expect(request.headers.get("x-enbor-project-id")).toBe("project-1");
        if (url.pathname === "/api/v1/agents")
          return Response.json({
            data: ["old", "new"].map((id) => ({
              metadata: { uid: `enbor-${id}`, projectId: "project-1" },
              spec: { identity: { issuer: env.OIDC_ISSUER, subject: id } },
            })),
            pagination: { nextCursor: null },
          });
        if (url.pathname === "/api/v1/sessions") {
          const body = (await request.json()) as { spec: { agentId: string } };
          keys.push(request.headers.get("idempotency-key")!);
          events.push(`create:${body.spec.agentId}`);
          return Response.json({ metadata: { uid: `session-${body.spec.agentId}`, projectId: "project-1" } }, { status: 201 });
        }
        expect(url.pathname).toBe("/api/v1/sessions/session-enbor-old");
        expect(request.method).toBe("PATCH");
        expect(await request.json()).toEqual({ state: "closed" });
        events.push("close:old");
        await expect(
          commitTaskClaim(db, {
            ownerId,
            taskId: task.id,
            actorType: "realmroot:agent",
            actorId: "old",
            runtime: "codex",
            runtimeSessionId: "session-enbor-old",
          }),
        ).resolves.toBeNull();
        if (failCleanup && !failed) {
          failed = true;
          return Response.json({ error: "temporarily unavailable" }, { status: 503 });
        }
        return Response.json({ metadata: { uid: "session-enbor-old", projectId: "project-1" } });
      }),
    );
    const assign = (assignedTo: string) =>
      api.fetch(
        new Request(`${env.AK_PUBLIC_ORIGIN}/api/tasks/${task.id}`, {
          method: "PATCH",
          headers: {
            cookie: browser.cookie,
            "x-csrf-token": browser.csrfToken,
            "API-Version": "2026-08-29",
            "content-type": "application/merge-patch+json",
          },
          body: JSON.stringify({ assignedTo }),
        }),
        env,
      );
    expect((await assign("old")).status).toBe(200);
    expect(events).toEqual([]);
    expect(scopes).toEqual([]);
    const unblocked = await api.fetch(
      new Request(`${env.AK_PUBLIC_ORIGIN}/api/tasks/${prerequisite.id}`, {
        method: "PATCH",
        headers: {
          cookie: browser.cookie,
          "x-csrf-token": browser.csrfToken,
          "API-Version": "2026-08-29",
          "content-type": "application/merge-patch+json",
        },
        body: JSON.stringify({ status: "cancelled" }),
      }),
      env,
    );
    expect(unblocked.status, await unblocked.clone().text()).toBe(200);
    expect(events).toEqual(["create:enbor-old"]);
    if (failCleanup) {
      expect((await assign("new")).status).toBe(503);
      expect((await assign("third")).status).toBe(409);
      expect(events).toEqual(["create:enbor-old", "close:old"]);
      await db
        .prepare(`UPDATE tasks SET metadata = json_set(metadata, '$."agent-kanban.dev/launch".lease_expires_at', '') WHERE id = ?`)
        .bind(task.id)
        .run();
    }
    const replacement = await assign("new");
    expect(replacement.status, await replacement.clone().text()).toBe(200);
    await expect(replacement.json()).resolves.toMatchObject({
      assignedTo: "new",
      status: "todo",
      metadata: { annotations: { "agent-kanban.dev/session-id": "session-enbor-new" } },
    });
    expect(events).toEqual(["create:enbor-old", "close:old", ...(failCleanup ? ["close:old"] : []), "create:enbor-new"]);
    expect(scopes).toEqual([
      "agents:read sessions:write",
      "sessions:write",
      ...(failCleanup ? ["sessions:write"] : []),
      "agents:read sessions:write",
    ]);
    expect(new Set(keys).size).toBe(2);
    expect((await assign("new")).status).toBe(200);
    expect(events).toHaveLength(failCleanup ? 4 : 3);
  },
);
