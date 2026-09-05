import { createBoard, deleteBoard } from "@server/adapters/d1/boardRepo";
import { createTask, deleteTask } from "@server/adapters/d1/taskRepo";
import { d1TaskAssignmentRepository } from "@server/adapters/d1/tasks/d1TaskAssignments";
import { d1TaskClaimRepository } from "@server/adapters/d1/tasks/d1TaskClaims";
import { d1TaskLaunchRepository, listReadyDependentLaunches } from "@server/adapters/d1/tasks/d1TaskLaunches";
import { dispatchTaskLaunches } from "@server/usecases/tasks/dispatchTaskLaunches";
import { recoverTaskClaimSession } from "@server/usecases/tasks/recoverTaskClaimSession";
import { replaceTaskAssignment } from "@server/usecases/tasks/replaceTaskAssignment";
import { replaceTaskClaim } from "@server/usecases/tasks/replaceTaskClaim";
import { settleTaskLaunches } from "@server/usecases/tasks/settleTaskLaunches";
import { refreshTaskLaunchBootstrap } from "@server/usecases/tasks/taskLaunchBootstrap";
import { afterEach, describe, expect, it } from "vitest";
import { seedUser, setupMiniflare } from "../../helpers/db";

const resources: Array<Awaited<ReturnType<typeof setupMiniflare>>["mf"]> = [];
afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.dispose()));
});

async function fixture() {
  const { mf, db } = await setupMiniflare();
  resources.push(mf);
  const ownerId = crypto.randomUUID();
  await seedUser(db, ownerId, `${ownerId}@test.local`);
  const board = await createBoard(db, ownerId, "Launch eligibility", "ops");
  const task = await createTask(db, ownerId, { title: "Launch", board_id: board.id });
  const assignment = await replaceTaskAssignment(d1TaskAssignmentRepository(db), {
    ownerId,
    taskId: task.id,
    assigneeActorId: "target-agent",
    assignedByActorId: "manager-agent",
  });
  return { db, ownerId, board, task, assignment, repository: d1TaskLaunchRepository(db) };
}

describe("Task launch eligibility", () => {
  it.each(["creator-first", "claim-first", "cancelled-during-replay"])(
    "[spec: tasks/early-claim] reconciles the exact creation while its original lease is active: %s",
    async (order) => {
      const { repository, ownerId, task, assignment, db } = await fixture();
      const now = new Date();
      const [lease] = await repository.acquireRunnable(now);
      const prepared = { projectId: "project-1", request: { spec: { agentId: "enbor-agent" }, prompt: "Claim Task" } };
      await repository.saveRequest(lease, prepared, now);
      const entered = Promise.withResolvers<void>();
      const response = Promise.withResolvers<{ uid: string }>();
      const recovery = recoverTaskClaimSession(
        repository,
        async (owner, input, key) => {
          expect(owner).toBe(ownerId);
          expect(input).toMatchObject(prepared);
          expect(key).toBe(assignment.version);
          entered.resolve();
          return response.promise;
        },
        { ownerId, taskId: task.id, agentActorId: "target-agent" },
      );
      await entered.promise;
      if (order === "creator-first") expect(await repository.recordSession(lease, "exact-session", now)).toBe(true);
      if (order === "cancelled-during-replay") await db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").bind(task.id).run();
      response.resolve({ uid: "exact-session" });
      await recovery;
      if (order === "claim-first") expect(await repository.recordSession(lease, "exact-session", now)).toBe(false);
      expect((await repository.findRequested(ownerId, assignment.version))?.sessionId).toBe("exact-session");
      const claim = { ownerId, taskId: task.id, agentActorId: "target-agent", runtime: "codex", runtimeSessionId: "exact-session" };
      if (order === "cancelled-during-replay") {
        await expect(replaceTaskClaim(d1TaskClaimRepository(db), claim)).rejects.toMatchObject({ code: "TASK_CLAIM_CONFLICT" });
      } else {
        await expect(replaceTaskClaim(d1TaskClaimRepository(db), { ...claim, runtimeSessionId: "forged-session" })).rejects.toMatchObject({
          code: "TASK_CLAIM_CONFLICT",
        });
        await expect(replaceTaskClaim(d1TaskClaimRepository(db), claim)).resolves.toMatchObject({ created: true });
      }
    },
  );

  it("[spec: tasks/early-claim] does not replay for another tenant or an unassigned Agent", async () => {
    const { repository, ownerId, task } = await fixture();
    const now = new Date();
    const [lease] = await repository.acquireRunnable(now);
    await repository.saveRequest(lease, { projectId: "project-1", request: { spec: { agentId: "enbor-agent" } } }, now);
    let calls = 0;
    const create = async () => {
      calls++;
      return { uid: "unexpected" };
    };
    await recoverTaskClaimSession(repository, create, { ownerId: "other-tenant", taskId: task.id, agentActorId: "target-agent" });
    await recoverTaskClaimSession(repository, create, { ownerId, taskId: task.id, agentActorId: "other-agent" });
    expect(calls).toBe(0);
  });

  it("[spec: tasks/launch-claim] claims only the exact current Session while the Task remains eligible", async () => {
    const { repository, db, task, ownerId, board } = await fixture();
    const claims = d1TaskClaimRepository(db);
    const input = { ownerId, taskId: task.id, agentActorId: "target-agent", runtime: "codex", runtimeSessionId: "exact-session" };
    const conflict = () => expect(replaceTaskClaim(claims, input)).rejects.toMatchObject({ code: "TASK_CLAIM_CONFLICT" });
    await conflict();
    const now = new Date();
    const [launch] = await repository.acquireRunnable(now);
    await repository.saveRequest(launch, { projectId: "project-1", request: { spec: { agentId: "enbor-agent" } } }, now);
    await conflict();
    await repository.recordSession(launch, "exact-session", now);
    await expect(replaceTaskClaim(claims, { ...input, runtimeSessionId: "other-session" })).rejects.toMatchObject({ code: "TASK_CLAIM_CONFLICT" });
    await db
      .prepare("UPDATE tasks SET scheduled_at = ? WHERE id = ?")
      .bind(new Date(now.getTime() + 3_600_000).toISOString(), task.id)
      .run();
    await conflict();
    await db.prepare("UPDATE tasks SET scheduled_at = NULL WHERE id = ?").bind(task.id).run();
    const dependency = await createTask(db, ownerId, { title: "New dependency after dispatch", board_id: board.id });
    await db.prepare("INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)").bind(task.id, dependency.id).run();
    await conflict();
    await db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").bind(dependency.id).run();
    const results = await Promise.all([replaceTaskClaim(claims, input), replaceTaskClaim(claims, input)]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results[0].version).toBe(results[1].version);
    await expect(db.prepare("SELECT COUNT(*) AS count FROM task_session_bindings WHERE task_id = ?").bind(task.id).first()).resolves.toEqual({
      count: 1,
    });
  });

  it("[spec: tasks/bootstrap-refresh] records a refreshed expiry only after the Vault confirms rotation", async () => {
    const { repository, ownerId, assignment } = await fixture();
    const now = new Date();
    const [lease] = await repository.acquireRunnable(now);
    const bootstrap = {
      projectId: "project-a",
      url: "https://github.com/example/source.git",
      ref: "fixed-ref",
      mountPath: "/workspace/repo",
      secretRef: "enbor://vaults/vault-a/credentials/credential-a",
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      installationId: 1,
      githubRepositoryId: 2,
    };
    await repository.saveBootstrap(lease, bootstrap, now);
    const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();
    let failed = true;
    let rotations = 0;
    const execution = {
      async mint(snapshot: typeof bootstrap) {
        expect(snapshot).toEqual(bootstrap);
        return { token: "temporary-token", expiresAt };
      },
      async refreshBootstrap(owner: string, project: string, ref: string, token: string, expiry: string) {
        expect([owner, project, ref, token, expiry]).toEqual([ownerId, "project-a", bootstrap.secretRef, "temporary-token", expiresAt]);
        rotations++;
        if (failed) throw new Error("Vault unavailable");
      },
    };
    await expect(refreshTaskLaunchBootstrap(repository, lease, execution, () => now)).rejects.toThrow("Vault unavailable");
    expect((await repository.findBootstrap(ownerId, assignment.version))?.expiresAt).toBe(bootstrap.expiresAt);
    failed = false;
    await expect(refreshTaskLaunchBootstrap(repository, lease, execution, () => now)).resolves.toBe(true);
    await expect(refreshTaskLaunchBootstrap(repository, lease, execution, () => now)).resolves.toBe(false);
    expect(rotations).toBe(2);
  });

  it("[spec: tasks/bootstrap-refresh] preserves the Session request and rejects stale or mismatched refresh acknowledgements", async () => {
    const { repository, ownerId, assignment } = await fixture();
    const now = new Date();
    const [lease] = await repository.acquireRunnable(now);
    const bootstrap = {
      projectId: "project-a",
      url: "https://github.com/example/source.git",
      ref: "pinned-branch",
      mountPath: "/workspace/repo",
      secretRef: "enbor://vaults/vault-a/credentials/credential-a",
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      installationId: 1,
      githubRepositoryId: 2,
    };
    await repository.saveBootstrap(lease, bootstrap, now);
    const request = { spec: { agentId: "agent-1" }, prompt: "Claim Task" };
    await repository.saveRequest(lease, { projectId: "project-a", request }, now);
    const refreshedUntil = new Date(now.getTime() + 3_600_000);
    await expect(repository.recordBootstrapRefresh(lease, "another-secret", refreshedUntil, now)).resolves.toBe(false);
    await expect(repository.recordBootstrapRefresh(lease, bootstrap.secretRef, refreshedUntil, now)).resolves.toBe(true);
    await expect(repository.recordBootstrapRefresh(lease, bootstrap.secretRef, new Date(now.getTime() + 120_000), now)).resolves.toBe(false);
    await expect(repository.findBootstrap(ownerId, assignment.version)).resolves.toEqual({ ...bootstrap, expiresAt: refreshedUntil.toISOString() });
    await expect(repository.findRequested(ownerId, assignment.version)).resolves.toEqual({ projectId: "project-a", request, sessionId: null });
    const later = new Date(now.getTime() + 60_000);
    await repository.acquireRequested(later);
    await expect(repository.recordBootstrapRefresh(lease, bootstrap.secretRef, new Date(now.getTime() + 7_200_000), later)).resolves.toBe(false);
  });

  it("[spec: tasks/bootstrap-binding] persists a tenant-scoped bootstrap reference and prevents Project switching", async () => {
    const { repository, ownerId, assignment } = await fixture();
    const now = new Date();
    const [lease] = await repository.acquireRunnable(now);
    const bootstrap = {
      projectId: "project-a",
      url: "https://github.com/example/source.git",
      ref: "main",
      mountPath: "/workspace/repo",
      secretRef: "enbor://vaults/vault-a/credentials/credential-a",
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      installationId: 1,
      githubRepositoryId: 2,
    };
    await expect(repository.saveBootstrap(lease, bootstrap, now)).resolves.toBe(true);
    await expect(repository.findBootstrap(ownerId, assignment.version)).resolves.toEqual(bootstrap);
    await expect(repository.findBootstrap("another-owner", assignment.version)).resolves.toBeNull();
    await expect(repository.saveBootstrap(lease, { ...bootstrap, ref: "changed" }, now)).resolves.toBe(false);
    const request = { spec: { agentId: "agent-1" }, prompt: "Claim Task" };
    await expect(repository.saveRequest(lease, { projectId: "project-b", request }, now)).resolves.toBe(false);
    await expect(repository.saveRequest(lease, { projectId: "project-a", request }, now)).resolves.toBe(true);
  });

  it("[spec: tasks/bootstrap-binding] retains a credential response after cancellation so settlement can revoke it", async () => {
    const { repository, db, task } = await fixture();
    const now = new Date();
    const [lease] = await repository.acquireRunnable(now);
    await db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").bind(task.id).run();
    const bootstrap = {
      projectId: "project-a",
      url: "https://github.com/example/source.git",
      ref: "main",
      mountPath: "/workspace/repo",
      secretRef: "enbor://vaults/vault-a/credentials/credential-a",
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      installationId: 1,
      githubRepositoryId: 2,
    };
    await expect(repository.saveBootstrap(lease, bootstrap, now)).resolves.toBe(true);
    const [cleanup] = await repository.acquireSettlement(new Date(now.getTime() + 60_000));
    expect(cleanup).toMatchObject({ project_id: "project-a", secret_ref: bootstrap.secretRef });
    await expect(repository.saveBootstrap(lease, bootstrap, new Date(now.getTime() + 60_000))).resolves.toBe(false);
  });

  it("[spec: tasks/settle-launch] closes the exact cancelled Session before revoking its bootstrap credential and retries interrupted cleanup", async () => {
    const { db, task, repository, assignment, ownerId } = await fixture();
    let clock = new Date();
    const [lease] = await repository.acquireRunnable(clock);
    await repository.saveRequest(lease, { projectId: "project-a", request: { spec: { agentId: "enbor-agent" }, prompt: "Claim Task" } }, clock);
    await repository.recordSession(lease, "session-a", clock);
    await db
      .prepare(`UPDATE tasks SET metadata = json_set(metadata, '$."agent-kanban.dev/launch".secret_ref', 'secret-a')
      WHERE json_extract(metadata, '$."agent-kanban.dev/launch".id') = ?`)
      .bind(assignment.version)
      .run();
    await db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").bind(task.id).run();
    const calls: string[] = [];
    let failRevoke = true;
    const remote = {
      async closeSession(owner: string, project: string, session: string) {
        expect([owner, project, session]).toEqual([ownerId, "project-a", "session-a"]);
        calls.push("close");
      },
      async revokeBootstrap(owner: string, project: string, ref: string) {
        expect([owner, project, ref]).toEqual([ownerId, "project-a", "secret-a"]);
        calls.push("revoke");
        if (failRevoke) throw new Error("Vault unavailable");
      },
    };
    await expect(settleTaskLaunches(repository, remote, () => clock)).rejects.toThrow("Task launch settlement failed");
    await expect(
      db
        .prepare(
          `SELECT json_extract(metadata, '$."agent-kanban.dev/launch".state') AS state FROM tasks WHERE json_extract(metadata, '$."agent-kanban.dev/launch".id') = ?`,
        )
        .bind(assignment.version)
        .first(),
    ).resolves.toEqual({ state: "settling" });
    failRevoke = false;
    clock = new Date(clock.getTime() + 60_000);
    await settleTaskLaunches(repository, remote, () => clock);
    expect(calls).toEqual(["close", "revoke", "close", "revoke"]);
    await expect(
      db
        .prepare(
          `SELECT json_extract(metadata, '$."agent-kanban.dev/launch".state') AS state, json_extract(metadata, '$.annotations."agent-kanban.dev/session-id"') AS session_id FROM tasks WHERE json_extract(metadata, '$."agent-kanban.dev/launch".id') = ?`,
        )
        .bind(assignment.version)
        .first(),
    ).resolves.toEqual({
      state: "settled",
      session_id: "session-a",
    });
  });

  it("[spec: tasks/settle-launch] preserves active and review Sessions and requires cleanup before Task deletion", async () => {
    const { db, task, repository, assignment, ownerId, board } = await fixture();
    const [launch] = await repository.acquireRunnable(new Date());
    for (const status of ["todo", "in_progress", "in_review"]) {
      await db.prepare("UPDATE tasks SET status = ? WHERE id = ?").bind(status, task.id).run();
      await expect(repository.acquireSettlement(new Date())).resolves.toEqual([]);
    }
    await db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").bind(task.id).run();
    await expect(deleteTask(db, task.id, ownerId)).rejects.toThrow("Task Session cleanup must complete");
    await expect(deleteBoard(db, board.id, ownerId)).rejects.toThrow("Task Session cleanup must complete");
    const leases = await repository.acquireSettlement(new Date(Date.parse(launch.lease_expires_at)));
    expect(leases).toHaveLength(1);
    expect(leases[0].id).toBe(assignment.version);
    await repository.completeSettlement(leases[0], new Date(Date.parse(launch.lease_expires_at)));
    await expect(deleteTask(db, task.id, ownerId)).resolves.toBe(true);
    await expect(deleteBoard(db, board.id, ownerId)).resolves.toBe(true);
  });

  it("[spec: tasks/reassign-launch] replaces the current launch when a pending Task is reassigned and replaces the Task launch metadata", async () => {
    const { db, ownerId, task, assignment, repository } = await fixture();
    const replacement = await replaceTaskAssignment(d1TaskAssignmentRepository(db), {
      ownerId,
      taskId: task.id,
      assigneeActorId: "replacement-agent",
      assignedByActorId: "manager-agent",
    });
    expect(replacement.version).not.toBe(assignment.version);
    await expect(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({ count: 1 });
    const runnable = await repository.acquireRunnable(new Date());
    expect(runnable).toHaveLength(1);
    expect(runnable[0]).toMatchObject({ id: replacement.version, assignee_actor_id: "replacement-agent" });
  });

  it("[spec: tasks/launch-request-binding] replays the saved request after a lost create response without preparing again", async () => {
    const { repository, ownerId, assignment } = await fixture();
    let clock = new Date();
    let preparations = 0;
    let requests = 0;
    const sessions = new Map<string, { uid: string }>();
    const original = { projectId: "project-a", request: { spec: { agentId: "enbor-agent" }, prompt: "Original request" } };
    const execution = {
      async prepare() {
        preparations++;
        return original;
      },
      async create(tenant: string, saved: typeof original, key: string) {
        expect(tenant).toBe(ownerId);
        expect(saved.projectId).toBe(original.projectId);
        expect(saved.request).toEqual(original.request);
        requests++;
        const session = sessions.get(key) ?? { uid: "remote-session" };
        sessions.set(key, session);
        if (requests === 1) throw new Error("Response lost after remote commit");
        return session;
      },
    };
    await expect(dispatchTaskLaunches(repository, execution, () => clock)).rejects.toThrow("Task launch dispatch failed");
    expect(sessions.size).toBe(1);
    expect((await repository.findRequested(ownerId, assignment.version))?.sessionId).toBeNull();
    clock = new Date(clock.getTime() + 60_000);
    await dispatchTaskLaunches(repository, execution, () => clock);
    expect(preparations).toBe(1);
    expect(requests).toBe(2);
    expect(sessions.size).toBe(1);
    expect((await repository.findRequested(ownerId, assignment.version))?.sessionId).toBe("remote-session");
  });

  it("[spec: tasks/launch-request-binding] recovers an ambiguous request after cancellation and rejects the old response writer", async () => {
    const { repository, db, task, ownerId, assignment } = await fixture();
    const now = new Date();
    const [lease] = await repository.acquireRunnable(now);
    const input = { projectId: "project-a", request: { spec: { agentId: "enbor-agent" }, prompt: "Claim task" } };
    await repository.saveRequest(lease, input, now);
    await db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").bind(task.id).run();
    const later = new Date(now.getTime() + 60_000);
    const recovered = (await Promise.all([repository.acquireRequested(later), repository.acquireRequested(later)])).flat();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].id).toBe(assignment.version);
    await expect(repository.recordSession(lease, "stale-writer-session", later)).resolves.toBe(false);
    await expect(repository.findRequested(ownerId, recovered[0].id)).resolves.toEqual({ ...input, sessionId: null });
    await expect(repository.recordSession(recovered[0], "exact-recovered-session", later)).resolves.toBe(true);
  });

  it("[spec: tasks/launch-request-binding] saves one immutable request before recording the exact Session", async () => {
    const { repository, ownerId, assignment } = await fixture();
    const now = new Date();
    const [lease] = await repository.acquireRunnable(now);
    const request = { spec: { agentId: "enbor-agent" }, prompt: "Claim task before work" };
    await expect(repository.saveRequest(lease, { projectId: "project-a", request }, now)).resolves.toBe(true);
    await expect(repository.saveRequest(lease, { projectId: "project-b", request: { ...request, prompt: "Changed" } }, now)).resolves.toBe(false);
    await expect(repository.findRequested("another-tenant", assignment.version)).resolves.toBeNull();
    await expect(repository.findRequested(ownerId, assignment.version)).resolves.toEqual({ projectId: "project-a", request, sessionId: null });
    await expect(repository.recordSession(lease, "exact-session", now)).resolves.toBe(true);
    await expect(repository.recordSession(lease, "other-session", now)).resolves.toBe(false);
    await expect(repository.findRequested(ownerId, assignment.version)).resolves.toEqual({
      projectId: "project-a",
      request,
      sessionId: "exact-session",
    });
  });

  it("[spec: tasks/launch-request-binding] fences expired preparation and rechecks cancellation before saving a request", async () => {
    const { repository, db, task } = await fixture();
    const now = new Date();
    const [lease] = await repository.acquireRunnable(now);
    const input = { projectId: "project-a", request: { spec: { agentId: "enbor-agent" }, prompt: "Claim task" } };
    const later = new Date(now.getTime() + 60_000);
    const [replacement] = await repository.acquireRunnable(later);
    await expect(repository.saveRequest(lease, input, later)).resolves.toBe(false);
    await db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").bind(task.id).run();
    await expect(repository.saveRequest(replacement, input, later)).resolves.toBe(false);
  });

  it("[spec: tasks/launch-request-binding] retains a late Session response after cancellation for cleanup without creating a Claim", async () => {
    const { repository, db, task, ownerId, assignment } = await fixture();
    const now = new Date();
    const [lease] = await repository.acquireRunnable(now);
    await repository.saveRequest(lease, { projectId: "project-a", request: { spec: { agentId: "enbor-agent" }, prompt: "Claim task" } }, now);
    await db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").bind(task.id).run();
    await expect(repository.recordSession(lease, "session-to-close", now)).resolves.toBe(true);
    expect((await repository.findRequested(ownerId, assignment.version))?.sessionId).toBe("session-to-close");
    await expect(db.prepare("SELECT status, active_claim_id FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({
      status: "cancelled",
      active_claim_id: null,
    });
  });

  it("[spec: tasks/launch-eligibility] grants one concurrent lease and recovers it after expiry", async () => {
    const { repository, assignment } = await fixture();
    const now = new Date("2030-01-01T00:00:00.000Z");
    const leases = (await Promise.all(Array.from({ length: 4 }, () => repository.acquireRunnable(now)))).flat();
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ id: assignment.version, attempts: 1 });
    await expect(repository.acquireRunnable(new Date(now.getTime() + 59_999))).resolves.toEqual([]);
    const recovered = await repository.acquireRunnable(new Date(now.getTime() + 60_000));
    expect(recovered).toHaveLength(1);
    expect(recovered[0].lease_token).not.toBe(leases[0].lease_token);
    expect(recovered[0].attempts).toBe(2);
  });

  it("[spec: tasks/launch-eligibility] does not launch legacy schedules even after their time passes", async () => {
    const { db, ownerId, board, task, repository } = await fixture();
    const dependency = await createTask(db, ownerId, { title: "Dependency", board_id: board.id });
    await db.prepare("INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)").bind(task.id, dependency.id).run();
    await db.prepare("UPDATE tasks SET scheduled_at = ? WHERE id = ?").bind("2030-01-01T02:00:00+02:00", task.id).run();
    const due = new Date("2030-01-01T00:00:00.000Z");
    await expect(repository.acquireRunnable(due)).resolves.toEqual([]);
    await db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").bind(dependency.id).run();
    await expect(repository.acquireRunnable(new Date(due.getTime() - 1))).resolves.toEqual([]);
    await expect(repository.acquireRunnable(due)).resolves.toEqual([]);
    await db.prepare("UPDATE tasks SET scheduled_at = NULL WHERE id = ?").bind(task.id).run();
    expect(await repository.acquireRunnable(due)).toHaveLength(1);
  });

  it.each([
    "status = 'cancelled'",
    "assigned_to = 'another-agent'",
    `metadata = json_set(metadata, '$."agent-kanban.dev/launch".assignee_actor_id', 'replacement-agent')`,
  ])("[spec: tasks/launch-eligibility] excludes obsolete intent after %s", async (change) => {
    const { db, task, repository } = await fixture();
    await db.prepare(`UPDATE tasks SET ${change} WHERE id = ?`).bind(task.id).run();
    await expect(repository.acquireRunnable(new Date())).resolves.toEqual([]);
  });
});

it("[spec: tasks/launch-eligibility] pages only ready dependents after all prerequisites are terminal", async () => {
  const { db, ownerId, task, board } = await fixture();
  const ready: string[] = [];
  for (let index = 0; index < 6; index++) {
    const dependent = await createTask(db, ownerId, { title: `Dependent ${index}`, board_id: board.id, depends_on: [task.id] });
    await replaceTaskAssignment(d1TaskAssignmentRepository(db), {
      ownerId,
      taskId: dependent.id,
      assigneeActorId: "agent",
      assignedByActorId: "manager",
    });
    ready.push(dependent.id);
  }
  expect(await listReadyDependentLaunches(db, ownerId, task.id, "")).toEqual([]);
  await db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").bind(task.id).run();
  await db.prepare("UPDATE tasks SET scheduled_at = '2030-01-01T00:00:00Z' WHERE id = ?").bind(ready[0]).run();
  const blocker = await createTask(db, ownerId, { title: "Still blocking", board_id: board.id });
  await db.prepare("INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)").bind(ready[1], blocker.id).run();
  expect(await listReadyDependentLaunches(db, "another-owner", task.id, "")).toEqual([]);
  const first = await listReadyDependentLaunches(db, ownerId, task.id, "");
  expect(first).toEqual(ready.slice(2).sort());
  await db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").bind(blocker.id).run();
  const page = await listReadyDependentLaunches(db, ownerId, task.id, "");
  const tail = await listReadyDependentLaunches(db, ownerId, task.id, page.at(-1)!);
  expect([...page, ...tail]).toEqual(ready.slice(1).sort());
});
