import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessRepo } from "../../../apps/web/server/accessRepo";
import { dispatchOutbox } from "../../../apps/web/server/outbox";
import { createTestApplication, jsonRequest, responseJson, type TestApplication } from "../helpers/app";
import { startAmaServer } from "../helpers/protocol-servers";

type Resource = { id: string; status?: string; agentId?: string; amaSessionUri?: string | null };

describe("AK → AMA assignment and complete Task lifecycle", () => {
  let app!: TestApplication;
  let ama!: Awaited<ReturnType<typeof startAmaServer>>;

  beforeEach(async () => {
    ama = await startAmaServer();
    app = await createTestApplication({
      AMA_ORIGIN: ama.origin,
      AMA_RESOURCE: `${ama.origin}/api`,
      REALMROOT_ISSUER: ama.identity.issuer,
    });
    await app.db.batch([
      app.db.prepare("INSERT INTO tenants (id) VALUES (?)").bind("tenant-a"),
      app.db
        .prepare(
          `INSERT INTO ama_grants
             (tenant_id, subject_id, refresh_token_ciphertext, refresh_token_nonce,
              access_token_ciphertext, access_token_nonce, access_token_expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind("tenant-a", "local-controller", "unused", "unused", "unused", "unused", "2099-01-01T00:00:00.000Z"),
    ]);
  });

  afterEach(async () => {
    await app?.close();
    await ama?.close();
  });

  it("persists the AMA Agent ID, dispatches one native Session, rejects/resumes, and accepts", async () => {
    const connection = await create("/api/ama-connections", { resourceUrl: `${ama.origin}/api`, projectUri: ama.projectUri }, "connection");
    const board = await create("/api/boards", { name: "Release" }, "board");
    const repository = await create(
      "/api/repositories",
      { name: "agent-kanban", url: "https://example.com/agent-kanban.git", defaultBranch: "main" },
      "repository",
    );
    const binding = await app.request(`/api/boards/${board.id}/execution-binding`, jsonRequest("PUT", { amaConnectionId: connection.id }));
    expect(binding.status).toBe(201);
    const replaceRequest = jsonRequest("PUT", { amaConnectionId: connection.id });
    const replacedBinding = await app.request(`/api/boards/${board.id}/execution-binding`, {
      ...replaceRequest,
      headers: { ...replaceRequest.headers, "If-Match": binding.headers.get("etag") ?? "" },
    });
    expect(replacedBinding.status).toBe(200);

    const legacyMembership = await app.request(
      `/api/boards/${board.id}/memberships`,
      jsonRequest("POST", { agent: `${ama.origin}/api/v1/agents/agent-a`, capabilities: ["work"] }, "legacy-membership"),
    );
    expect(legacyMembership.status).toBe(422);
    const membership = await create(`/api/boards/${board.id}/memberships`, { agentId: "agent-a", capabilities: ["work", "review"] }, "membership");
    expect(membership).toMatchObject({ agentId: "agent-a" });
    expect(membership).not.toHaveProperty("issuer");
    expect(membership).not.toHaveProperty("subject");

    const task = await create(
      `/api/boards/${board.id}/tasks`,
      { title: "Ship v2", description: "Implement and verify", repositoryId: repository.id, priority: 20 },
      "task",
    );
    const legacyAssignment = await app.request(
      `/api/tasks/${task.id}/assignments`,
      jsonRequest("POST", { agent: `${ama.origin}/api/v1/agents/agent-a` }, "legacy-assignment"),
    );
    expect(legacyAssignment.status).toBe(422);
    const assignment = await create(`/api/tasks/${task.id}/assignments`, { agentId: "agent-a" }, "assignment");
    expect(assignment).toMatchObject({ agentId: "agent-a" });
    const listedTask = (await getCollection(`/api/boards/${board.id}/tasks`)).find((candidate) => candidate.id === task.id);
    expect(listedTask).toMatchObject({ assignment: { id: assignment.id, agentId: "agent-a", status: "active" } });
    expect(await getStatus(`/api/tasks/${task.id}`)).toBe("queued");

    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const runResponse = await app.request(`/api/tasks/${task.id}/runs`, {
      ...jsonRequest("POST", {}, "run"),
      headers: { ...jsonRequest("POST", {}, "run").headers, traceparent, tracestate: "vendor=value" },
    });
    expect(runResponse.status).toBe(201);
    const run = await responseJson<Resource>(runResponse);
    expect(run.status).toBe("pending");
    expect(await getStatus(`/api/tasks/${task.id}`)).toBe("queued");
    const outboxBefore = await app.db.prepare("SELECT payload_json FROM dispatch_outbox WHERE kind = 'session'").first<{ payload_json: string }>();
    const sessionPayload = JSON.parse(outboxBefore?.payload_json ?? "null");
    expect(sessionPayload).toMatchObject({
      idempotencyKey: `ak:task-run:${run.id}`,
      request: {
        spec: {
          agentId: "agent-a",
          volumes: [{ name: "repository", type: "git_repository", url: "https://example.com/agent-kanban.git", ref: "main" }],
          volumeMounts: [{ name: "repository", mountPath: "/workspace/repository" }],
        },
      },
    });
    const payloadKeys = new Set<string>();
    JSON.stringify(sessionPayload, (key, value) => {
      if (key) payloadKeys.add(key);
      return value;
    });
    expect(payloadKeys).not.toContain("runtime");
    expect(payloadKeys).not.toContain("identity");
    expect(payloadKeys).not.toContain("vault");
    expect(payloadKeys).not.toContain("credential");
    await dispatchOutbox(app.env);
    const dispatched = await get(`/api/task-runs/${run.id}`);
    expect(dispatched).toMatchObject({ status: "running", amaSessionUri: `${ama.origin}/api/v1/sessions/session-a` });
    expect(await getStatus(`/api/tasks/${task.id}`)).toBe("in_progress");
    const sessionCreates = ama.requests.filter((request) => request.method === "POST" && request.path === "/api/v1/sessions");
    expect(sessionCreates).toHaveLength(1);
    expect(
      ama.requests.some(
        (request) =>
          request.method === "GET" &&
          new URL(request.path, ama.origin).searchParams.get("labelSelector") === `agent-kanban-run=ak:task-run:${run.id}`,
      ),
    ).toBe(true);
    expect(sessionCreates[0]).toMatchObject({
      headers: expect.objectContaining({
        "idempotency-key": `ak:task-run:${run.id}`,
        "x-ama-project-id": "project-a",
        traceparent,
        tracestate: "vendor=value",
      }),
      body: {
        metadata: {
          labels: { source: "agent-kanban", "agent-kanban-run": `ak:task-run:${run.id}` },
          annotations: { "agent-kanban.dev/task": expect.stringContaining(`/api/tasks/${task.id}`) },
        },
        spec: {
          agentId: "agent-a",
          volumes: [{ name: "repository", type: "git_repository", url: "https://example.com/agent-kanban.git", ref: "main" }],
          volumeMounts: [{ name: "repository", mountPath: "/workspace/repository" }],
        },
        prompt: expect.stringContaining("Implement and verify"),
      },
    });

    const outsider = await app.request(
      `/api/task-runs/${run.id}/progress-entries`,
      jsonRequest("POST", { kind: "checkpoint", body: "not mine" }, "outsider"),
      { issuer: ama.identity.issuer, subject: "other-agent" },
    );
    expect(outsider.status, JSON.stringify(ama.requests)).toBe(403);
    const progress = await app.request(
      `/api/task-runs/${run.id}/progress-entries`,
      jsonRequest("POST", { kind: "checkpoint", body: "tests passing" }, "progress"),
      amaActor(),
    );
    expect(progress.status).toBe(201);
    expect(await getStatus(`/api/tasks/${task.id}`)).toBe("in_progress");
    expect(await getStatus(`/api/task-runs/${run.id}`)).toBe("running");

    const firstSubmission = await createAsAgent(
      `/api/tasks/${task.id}/submissions`,
      { runId: run.id, summary: "initial result", artifactUrls: ["https://example.com/pr/1"] },
      "submission-1",
    );
    expect(await getStatus(`/api/tasks/${task.id}`)).toBe("in_review");
    const rejectionBody = { decision: "rejected", body: "add the missing failure proof" };
    const rejected = await create(`/api/task-submissions/${firstSubmission.id}/reviews`, rejectionBody, "review-reject");
    expect(rejected).toMatchObject({ decision: "rejected" });
    const rejectedReplay = await app.request(
      `/api/task-submissions/${firstSubmission.id}/reviews`,
      jsonRequest("POST", rejectionBody, "review-reject"),
    );
    expect(rejectedReplay.status).toBe(201);
    expect(await responseJson<Resource>(rejectedReplay)).toMatchObject({ id: rejected.id });
    expect(await getStatus(`/api/tasks/${task.id}`)).toBe("in_progress");

    await dispatchOutbox(app.env);
    const runs = await getCollection(`/api/tasks/${task.id}/runs`);
    expect(runs).toHaveLength(1);
    expect(ama.requests.filter((request) => request.method === "POST" && request.path === "/api/v1/sessions")).toHaveLength(1);
    expect(ama.requests.filter((request) => request.method === "POST" && request.path === "/api/v1/sessions/session-a/messages")).toHaveLength(1);

    await app.request(
      `/api/task-runs/${run.id}/progress-entries`,
      jsonRequest("POST", { kind: "checkpoint", body: "failure proof added" }, "progress-2"),
      amaActor(),
    );
    const secondSubmission = await createAsAgent(
      `/api/tasks/${task.id}/submissions`,
      { runId: run.id, summary: "corrected result", artifactUrls: [] },
      "submission-2",
    );
    await create(`/api/task-submissions/${secondSubmission.id}/reviews`, { decision: "accepted", body: "verified" }, "review-accept");
    expect(await getStatus(`/api/tasks/${task.id}`)).toBe("done");
    expect(await getStatus(`/api/task-runs/${run.id}`)).toBe("succeeded");
    expect(await getStatus(`/api/task-assignments/${assignment.id}`)).toBe("completed");
    const firstReviewPage = await responseJson<{ items: Resource[]; pagination: { nextPageToken: string | null; pageSize: number } }>(
      await app.request(`/api/task-submissions/${firstSubmission.id}/reviews?pageSize=1`),
    );
    expect(firstReviewPage.items).toHaveLength(1);
    expect(firstReviewPage.pagination).toEqual({ pageSize: 1 });
  });

  it("creates one replacement TaskRun only when AMA reports the previous Session unrecoverable", async () => {
    const { task } = await seedAssignableTask();
    const run = await create(`/api/tasks/${task.id}/runs`, {}, "closed-run");
    await dispatchOutbox(app.env);
    await app.request(
      `/api/task-runs/${run.id}/progress-entries`,
      jsonRequest("POST", { kind: "checkpoint", body: "initial attempt" }, "closed-progress"),
      amaActor(),
    );
    const submission = await createAsAgent(
      `/api/tasks/${task.id}/submissions`,
      { runId: run.id, summary: "needs retry", artifactUrls: [] },
      "closed-submission",
    );
    ama.setSessionStatus("session-a", "closed");
    const body = { decision: "rejected", body: "resume in a fresh session" };
    const review = await create(`/api/task-submissions/${submission.id}/reviews`, body, "closed-review");
    const replay = await app.request(`/api/task-submissions/${submission.id}/reviews`, jsonRequest("POST", body, "closed-review"));
    expect(replay.status).toBe(201);
    expect(await responseJson<Resource>(replay)).toMatchObject({ id: review.id });
    const beforeDispatch = await getCollection(`/api/tasks/${task.id}/runs`);
    expect(beforeDispatch).toHaveLength(2);
    await dispatchOutbox(app.env);
    expect(ama.requests.filter((request) => request.method === "POST" && request.path === "/api/v1/sessions")).toHaveLength(2);
    expect((await getCollection(`/api/tasks/${task.id}/runs`)).filter((candidate) => candidate.amaSessionUri)).toHaveLength(2);
  });

  it("falls back once when a reused Session closes after review but before feedback delivery", async () => {
    const { task } = await seedAssignableTask();
    const run = await create(`/api/tasks/${task.id}/runs`, {}, "late-terminal-run");
    await dispatchOutbox(app.env);
    await app.request(
      `/api/task-runs/${run.id}/progress-entries`,
      jsonRequest("POST", { kind: "checkpoint", body: "ready" }, "late-terminal-progress"),
      amaActor(),
    );
    const submission = await createAsAgent(
      `/api/tasks/${task.id}/submissions`,
      { runId: run.id, summary: "review me", artifactUrls: [] },
      "late-terminal-submission",
    );
    await create(`/api/task-submissions/${submission.id}/reviews`, { decision: "rejected", body: "retry" }, "late-terminal-review");
    expect(await getCollection(`/api/tasks/${task.id}/runs`)).toHaveLength(1);
    ama.setSessionStatus("session-a", "closed");
    await dispatchOutbox(app.env);
    expect(await getCollection(`/api/tasks/${task.id}/runs`)).toHaveLength(2);
    await dispatchOutbox(app.env);
    expect(await getCollection(`/api/tasks/${task.id}/runs`)).toHaveLength(2);
  });

  it("retries a transient outbox failure without duplicating the durable TaskRun", async () => {
    const { task } = await seedAssignableTask();
    const run = await create(`/api/tasks/${task.id}/runs`, {}, "retry-run");
    ama.failOneSessionDispatch();
    await dispatchOutbox(app.env);
    expect((await get(`/api/task-runs/${run.id}`)).amaSessionUri).toBeNull();
    expect(await getStatus(`/api/tasks/${task.id}`)).toBe("queued");
    const failed = await app.db
      .prepare("SELECT status, attempts, last_error_code FROM dispatch_outbox WHERE aggregate_id = ?")
      .bind(run.id)
      .first<any>();
    expect(failed).toMatchObject({ status: "failed", attempts: 1, last_error_code: "ama_unavailable" });
    await app.db.prepare("UPDATE dispatch_outbox SET available_at = datetime('now') WHERE aggregate_id = ?").bind(run.id).run();
    await dispatchOutbox(app.env);
    expect((await get(`/api/task-runs/${run.id}`)).amaSessionUri).toBe(`${ama.origin}/api/v1/sessions/session-a`);
    expect((await app.db.prepare("SELECT count(*) AS count FROM task_runs WHERE id = ?").bind(run.id).first<{ count: number }>())?.count).toBe(1);
  });

  it("does not regress a successful submission when delayed AMA reconciliation returns running", async () => {
    const { task } = await seedAssignableTask();
    const run = await create(`/api/tasks/${task.id}/runs`, {}, "delayed-reconcile-run");
    await dispatchOutbox(app.env);
    await app.request(
      `/api/task-runs/${run.id}/progress-entries`,
      jsonRequest("POST", { kind: "checkpoint", body: "ready to submit" }, "delayed-reconcile-progress"),
      amaActor(),
    );

    const delayed = ama.delayNextSessionRead();
    const reconciliation = dispatchOutbox(app.env);
    await delayed.requested;
    const submission = await createAsAgent(
      `/api/tasks/${task.id}/submissions`,
      { runId: run.id, summary: "committed while AMA was delayed", artifactUrls: [] },
      "delayed-reconcile-submission",
    );
    expect(submission.id).toBeTruthy();
    delayed.release();
    await reconciliation;

    expect(await getStatus(`/api/task-runs/${run.id}`)).toBe("succeeded");
    expect(await getStatus(`/api/tasks/${task.id}`)).toBe("in_review");
  });

  it("retains a delayed Session create result after submission and reuses it for rejection feedback", async () => {
    const { task } = await seedAssignableTask();
    const run = await create(`/api/tasks/${task.id}/runs`, {}, "delayed-create-run");
    const delayed = ama.delayNextSessionCreate();
    const dispatch = dispatchOutbox(app.env);
    await delayed.requested;
    expect(
      (
        await app.request(
          `/api/task-runs/${run.id}/progress-entries`,
          jsonRequest("POST", { kind: "checkpoint", body: "finished before session response" }, "delayed-create-progress"),
          amaActor(),
        )
      ).status,
    ).toBe(201);
    const submission = await createAsAgent(
      `/api/tasks/${task.id}/submissions`,
      { runId: run.id, summary: "completed during delayed create", artifactUrls: [] },
      "delayed-create-submission",
    );
    delayed.release();
    await dispatch;

    expect(await get(`/api/task-runs/${run.id}`)).toMatchObject({
      status: "succeeded",
      amaSessionUri: `${ama.origin}/api/v1/sessions/session-a`,
    });
    expect(await getStatus(`/api/tasks/${task.id}`)).toBe("in_review");
    await create(`/api/task-submissions/${submission.id}/reviews`, { decision: "rejected", body: "reuse this Session" }, "delayed-create-review");
    await dispatchOutbox(app.env);
    expect(await getCollection(`/api/tasks/${task.id}/runs`)).toHaveLength(1);
    expect(ama.requests.filter((request) => request.method === "POST" && request.path === "/api/v1/sessions")).toHaveLength(1);
    expect(ama.requests.filter((request) => request.method === "POST" && request.path === "/api/v1/sessions/session-a/messages")).toHaveLength(1);
  });

  it("atomically permits only one initial TaskRun and one AMA Session across different idempotency keys", async () => {
    const { task } = await seedAssignableTask();
    const responses = await Promise.all([
      app.request(`/api/tasks/${task.id}/runs`, jsonRequest("POST", {}, "initial-a")),
      app.request(`/api/tasks/${task.id}/runs`, jsonRequest("POST", {}, "initial-b")),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await getStatus(`/api/tasks/${task.id}`)).toBe("queued");
    const runs = await getCollection(`/api/tasks/${task.id}/runs`);
    expect(runs).toHaveLength(1);
    expect((await app.db.prepare("SELECT count(*) AS count FROM dispatch_outbox WHERE kind = 'session'").first<{ count: number }>())?.count).toBe(1);
    await dispatchOutbox(app.env);
    expect(ama.requests.filter((request) => request.method === "POST" && request.path === "/api/v1/sessions")).toHaveLength(1);
    expect(await getStatus(`/api/tasks/${task.id}`)).toBe("in_progress");
  });

  it("atomically permits one pending Submission across different idempotency keys", async () => {
    const { task } = await seedAssignableTask();
    const run = await create(`/api/tasks/${task.id}/runs`, {}, "concurrent-submission-run");
    await dispatchOutbox(app.env);
    const responses = await Promise.all([
      app.request(
        `/api/tasks/${task.id}/submissions`,
        jsonRequest("POST", { runId: run.id, summary: "submission a", artifactUrls: [] }, "concurrent-submission-a"),
        amaActor(),
      ),
      app.request(
        `/api/tasks/${task.id}/submissions`,
        jsonRequest("POST", { runId: run.id, summary: "submission b", artifactUrls: [] }, "concurrent-submission-b"),
        amaActor(),
      ),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await getCollection(`/api/tasks/${task.id}/submissions`)).toHaveLength(1);
    expect(await getStatus(`/api/task-runs/${run.id}`)).toBe("succeeded");
    expect(await getStatus(`/api/tasks/${task.id}`)).toBe("in_review");
  });

  it("atomically permits one Review and one rejection continuation across different idempotency keys", async () => {
    const { task } = await seedAssignableTask();
    const run = await create(`/api/tasks/${task.id}/runs`, {}, "concurrent-review-run");
    await dispatchOutbox(app.env);
    const submission = await createAsAgent(
      `/api/tasks/${task.id}/submissions`,
      { runId: run.id, summary: "review once", artifactUrls: [] },
      "concurrent-review-submission",
    );
    const reviewBody = { decision: "rejected", body: "one continuation only" };
    const responses = await Promise.all([
      app.request(`/api/task-submissions/${submission.id}/reviews`, jsonRequest("POST", reviewBody, "concurrent-review-a")),
      app.request(`/api/task-submissions/${submission.id}/reviews`, jsonRequest("POST", reviewBody, "concurrent-review-b")),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await getCollection(`/api/task-submissions/${submission.id}/reviews`)).toHaveLength(1);
    expect(
      (await app.db.prepare("SELECT count(*) AS count FROM dispatch_outbox WHERE kind = 'review_feedback'").first<{ count: number }>())?.count,
    ).toBe(1);
    expect(await getCollection(`/api/tasks/${task.id}/runs`)).toHaveLength(1);
    await dispatchOutbox(app.env);
    expect(ama.requests.filter((request) => request.method === "POST" && request.path === "/api/v1/sessions/session-a/messages")).toHaveLength(1);
  });

  it("supersedes terminal rejection feedback after a newer Submission is already pending", async () => {
    const { task } = await seedAssignableTask();
    const run = await create(`/api/tasks/${task.id}/runs`, {}, "superseded-feedback-run");
    await dispatchOutbox(app.env);
    const first = await createAsAgent(
      `/api/tasks/${task.id}/submissions`,
      { runId: run.id, summary: "first attempt", artifactUrls: [] },
      "superseded-feedback-first",
    );
    await create(`/api/task-submissions/${first.id}/reviews`, { decision: "rejected", body: "retry" }, "superseded-feedback-reject");
    const second = await createAsAgent(
      `/api/tasks/${task.id}/submissions`,
      { runId: run.id, summary: "newer attempt", artifactUrls: [] },
      "superseded-feedback-second",
    );
    ama.setSessionStatus("session-a", "closed");
    await dispatchOutbox(app.env);

    expect(await getCollection(`/api/tasks/${task.id}/runs`)).toHaveLength(1);
    expect(await getStatus(`/api/task-runs/${run.id}`)).toBe("succeeded");
    expect(await getStatus(`/api/tasks/${task.id}`)).toBe("in_review");
    expect(
      (
        await app.db
          .prepare("SELECT status, last_error_code FROM dispatch_outbox WHERE kind = 'review_feedback'")
          .first<{ status: string; last_error_code: string }>()
      )?.last_error_code,
    ).toBe("ama_session_terminal_superseded");

    await create(
      `/api/task-submissions/${second.id}/reviews`,
      { decision: "accepted", body: "newer attempt accepted" },
      "superseded-feedback-accept",
    );
    expect(await getStatus(`/api/tasks/${task.id}`)).toBe("done");
    expect(
      (
        await app.db
          .prepare("SELECT count(*) AS count FROM task_runs WHERE task_id = ? AND status IN ('pending','running')")
          .bind(task.id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
  });

  it("atomically refuses an initial Run while any dependency is unfinished", async () => {
    const connection = await create("/api/ama-connections", { resourceUrl: `${ama.origin}/api`, projectUri: ama.projectUri }, "blocked-connection");
    const board = await create("/api/boards", { name: "Dependency guard" }, "blocked-board");
    expect((await app.request(`/api/boards/${board.id}/execution-binding`, jsonRequest("PUT", { amaConnectionId: connection.id }))).status).toBe(201);
    await create(`/api/boards/${board.id}/memberships`, { agentId: "agent-a", capabilities: ["work"] }, "blocked-membership");
    const prerequisite = await create(`/api/boards/${board.id}/tasks`, { title: "Prerequisite" }, "blocked-prerequisite");
    const task = await create(`/api/boards/${board.id}/tasks`, { title: "Blocked task" }, "blocked-task");
    expect((await app.request(`/api/tasks/${task.id}/dependencies/${prerequisite.id}`, jsonRequest("PUT", {}))).status).toBe(201);
    await create(`/api/tasks/${task.id}/assignments`, { agentId: "agent-a" }, "blocked-assignment");

    const blocked = await app.request(`/api/tasks/${task.id}/runs`, jsonRequest("POST", {}, "blocked-run"));
    expect(blocked.status).toBe(409);
    expect(await responseJson(blocked)).toMatchObject({ type: "https://agent-kanban.dev/problems/task-blocked" });
    expect(await getCollection(`/api/tasks/${task.id}/runs`)).toHaveLength(0);
    expect(
      (await app.db.prepare("SELECT count(*) AS count FROM dispatch_outbox WHERE aggregate_type = 'task_run'").first<{ count: number }>())?.count,
    ).toBe(0);

    await app.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").bind(prerequisite.id).run();
    expect((await app.request(`/api/tasks/${task.id}/runs`, jsonRequest("POST", {}, "unblocked-run"))).status).toBe(201);
  });

  it("refuses initial Runs when the assigned Agent membership is downgraded or deleted", async () => {
    const connection = await create(
      "/api/ama-connections",
      { resourceUrl: `${ama.origin}/api`, projectUri: ama.projectUri },
      "membership-race-connection",
    );
    for (const mutation of ["downgrade", "delete"] as const) {
      const { task, membership } = await seedAssignableTask(connection);
      const current = await app.request(`/api/board-memberships/${membership.id}`);
      expect(current.status).toBe(200);
      const headers = { ...jsonRequest(mutation === "delete" ? "DELETE" : "PATCH", {}).headers, "If-Match": current.headers.get("etag") ?? "" };
      const changed = await app.request(
        `/api/board-memberships/${membership.id}`,
        mutation === "delete" ? { method: "DELETE", headers } : { method: "PATCH", headers, body: JSON.stringify({ capabilities: ["review"] }) },
      );
      expect(changed.status).toBe(mutation === "delete" ? 204 : 200);

      const run = await app.request(`/api/tasks/${task.id}/runs`, jsonRequest("POST", {}, `membership-${mutation}-run`));
      expect(run.status).toBe(409);
      expect(await responseJson(run)).toMatchObject({ type: "https://agent-kanban.dev/problems/task-run-conflict" });
      expect(await getCollection(`/api/tasks/${task.id}/runs`)).toHaveLength(0);
    }
  });

  it("atomically rejects Assignment creation when work membership changes after eligibility preflight", async () => {
    const connection = await create(
      "/api/ama-connections",
      { resourceUrl: `${ama.origin}/api`, projectUri: ama.projectUri },
      "assignment-race-connection",
    );
    for (const mutation of ["downgrade", "delete"] as const) {
      const board = await create("/api/boards", { name: `Assignment ${mutation}` }, `assignment-${mutation}-board`);
      expect((await app.request(`/api/boards/${board.id}/execution-binding`, jsonRequest("PUT", { amaConnectionId: connection.id }))).status).toBe(
        201,
      );
      const membership = await create(
        `/api/boards/${board.id}/memberships`,
        { agentId: "agent-a", capabilities: ["work"] },
        `assignment-${mutation}-membership`,
      );
      const task = await create(`/api/boards/${board.id}/tasks`, { title: `Race ${mutation}` }, `assignment-${mutation}-task`);

      let signalPreflight!: () => void;
      let resumePreflight!: () => void;
      const preflightReached = new Promise<void>((resolve) => {
        signalPreflight = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        resumePreflight = resolve;
      });
      const original = AccessRepo.prototype.hasWorkMembership;
      const preflight = vi.spyOn(AccessRepo.prototype, "hasWorkMembership").mockImplementation(async function (...args) {
        const eligible = await original.apply(this, args);
        signalPreflight();
        await resume;
        return eligible;
      });
      try {
        const assignmentPromise = app.request(
          `/api/tasks/${task.id}/assignments`,
          jsonRequest("POST", { agentId: "agent-a" }, `assignment-${mutation}-race`),
        );
        await preflightReached;
        const current = await app.request(`/api/board-memberships/${membership.id}`);
        const headers = { ...jsonRequest(mutation === "delete" ? "DELETE" : "PATCH", {}).headers, "If-Match": current.headers.get("etag") ?? "" };
        const changed = await app.request(
          `/api/board-memberships/${membership.id}`,
          mutation === "delete" ? { method: "DELETE", headers } : { method: "PATCH", headers, body: JSON.stringify({ capabilities: ["review"] }) },
        );
        expect(changed.status).toBe(mutation === "delete" ? 204 : 200);
        resumePreflight();
        const assignment = await assignmentPromise;
        expect(assignment.status).toBe(409);
        expect(await responseJson(assignment)).toMatchObject({ type: "https://agent-kanban.dev/problems/assignment-conflict" });
        expect(await getStatus(`/api/tasks/${task.id}`)).toBe("todo");
        expect(await getCollection(`/api/tasks/${task.id}/assignments`)).toHaveLength(0);
      } finally {
        resumePreflight();
        preflight.mockRestore();
      }
    }
  });

  it("releases an Assignment and returns its Task to todo as one atomic D1 change", async () => {
    const { task } = await seedAssignableTask();
    const [assignment] = await getCollection(`/api/tasks/${task.id}/assignments`);
    const current = await app.request(`/api/task-assignments/${assignment.id}`);
    const headers = { ...jsonRequest("DELETE", {}).headers, "If-Match": current.headers.get("etag") ?? "" };
    await app.db
      .prepare(`CREATE TRIGGER test_interrupt_assignment_release BEFORE UPDATE OF status ON tasks
        WHEN NEW.status = 'todo' BEGIN SELECT RAISE(ABORT, 'test interruption'); END`)
      .run();

    const interrupted = await app.request(`/api/task-assignments/${assignment.id}`, { method: "DELETE", headers });
    expect(interrupted.status).toBe(500);
    expect(await getStatus(`/api/task-assignments/${assignment.id}`)).toBe("active");
    expect(await getStatus(`/api/tasks/${task.id}`)).toBe("queued");

    await app.db.prepare("DROP TRIGGER test_interrupt_assignment_release").run();
    expect((await app.request(`/api/task-assignments/${assignment.id}`, { method: "DELETE", headers })).status).toBe(204);
    expect(await getStatus(`/api/task-assignments/${assignment.id}`)).toBe("released");
    expect(await getStatus(`/api/tasks/${task.id}`)).toBe("todo");
  });

  it("terminalizes an exhausted initial Session dispatch and permits one fresh Run", async () => {
    const { task } = await seedAssignableTask();
    const first = await create(`/api/tasks/${task.id}/runs`, {}, "exhausted-initial");
    await app.db
      .prepare("UPDATE dispatch_outbox SET status = 'failed', attempts = 10, available_at = datetime('now') WHERE aggregate_id = ?")
      .bind(first.id)
      .run();
    await dispatchOutbox(app.env);
    expect(await getStatus(`/api/task-runs/${first.id}`)).toBe("failed");
    const fresh = await create(`/api/tasks/${task.id}/runs`, {}, "fresh-after-exhaustion");
    expect(fresh.status).toBe("pending");
    expect(await getStatus(`/api/tasks/${task.id}`)).toBe("queued");
  });

  it("rejects an AMA Agent whose top-level identity issuer is outside the configured Realmroot", async () => {
    const trustedIssuer = ama.identity.issuer;
    ama.identity.issuer = "https://malicious-issuer.example/api/auth";
    const connection = await create("/api/ama-connections", { resourceUrl: `${ama.origin}/api`, projectUri: ama.projectUri }, "evil-connection");
    const board = await create("/api/boards", { name: "Issuer boundary" }, "evil-board");
    expect((await app.request(`/api/boards/${board.id}/execution-binding`, jsonRequest("PUT", { amaConnectionId: connection.id }))).status).toBe(201);
    const response = await app.request(
      `/api/boards/${board.id}/memberships`,
      jsonRequest("POST", { agentId: "agent-a", capabilities: ["work"] }, "evil-membership"),
    );
    expect(response.status).toBe(502);
    expect(await responseJson(response)).toMatchObject({ type: "https://agent-kanban.dev/problems/ama-contract-invalid" });
    ama.identity.issuer = trustedIssuer;
  });

  async function seedAssignableTask(existingConnection?: Resource) {
    const connection =
      existingConnection ??
      (await create("/api/ama-connections", { resourceUrl: `${ama.origin}/api`, projectUri: ama.projectUri }, crypto.randomUUID()));
    const board = await create("/api/boards", { name: crypto.randomUUID() }, crypto.randomUUID());
    expect((await app.request(`/api/boards/${board.id}/execution-binding`, jsonRequest("PUT", { amaConnectionId: connection.id }))).status).toBe(201);
    const membership = await create(`/api/boards/${board.id}/memberships`, { agentId: "agent-a", capabilities: ["work"] }, crypto.randomUUID());
    const task = await create(`/api/boards/${board.id}/tasks`, { title: "Retry" }, crypto.randomUUID());
    await create(`/api/tasks/${task.id}/assignments`, { agentId: "agent-a" }, crypto.randomUUID());
    return { board, task, membership };
  }

  async function create(path: string, body: unknown, key: string): Promise<Resource> {
    const response = await app.request(path, jsonRequest("POST", body, key));
    expect(response.status, `${path}: ${await response.clone().text()}`).toBe(201);
    return responseJson<Resource>(response);
  }

  async function createAsAgent(path: string, body: unknown, key: string): Promise<Resource> {
    const response = await app.request(path, jsonRequest("POST", body, key), amaActor());
    expect(response.status, `${path}: ${await response.clone().text()}\nAMA requests: ${JSON.stringify(ama.requests)}`).toBe(201);
    return responseJson<Resource>(response);
  }

  async function get(path: string): Promise<Resource> {
    return responseJson<Resource>(await app.request(path));
  }

  async function getStatus(path: string): Promise<string | undefined> {
    return (await get(path)).status;
  }

  async function getCollection(path: string): Promise<Resource[]> {
    return (await responseJson<{ items: Resource[] }>(await app.request(path))).items;
  }

  function amaActor() {
    return { issuer: ama.identity.issuer, subject: ama.identity.subject };
  }
});
