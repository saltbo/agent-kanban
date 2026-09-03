// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createBoard } from "../../../server/adapters/d1/boardRepo";
import { createTask } from "../../../server/adapters/d1/taskRepo";
import { d1TaskAssignmentRepository } from "../../../server/adapters/d1/tasks/d1TaskAssignments";
import { d1TaskClaimDeletionRepository } from "../../../server/adapters/d1/tasks/d1TaskClaimDeletions";
import { d1TaskClaimRepository } from "../../../server/adapters/d1/tasks/d1TaskClaims";
import { deleteTaskClaim } from "../../../server/usecases/tasks/deleteTaskClaim";
import { replaceTaskAssignment } from "../../../server/usecases/tasks/replaceTaskAssignment";
import { replaceTaskClaim } from "../../../server/usecases/tasks/replaceTaskClaim";
import { seedUser, setupMiniflare } from "../../helpers/db";

const resources: Array<Awaited<ReturnType<typeof setupMiniflare>>["mf"]> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.dispose()));
});

describe("D1 Task Assignment", () => {
  it("records a Realmroot actor assignment without dispatching runtime work", async () => {
    const { mf, db } = await setupMiniflare();
    resources.push(mf);
    const ownerId = `tenant-assignment-${randomUUID()}`;
    await seedUser(db, ownerId, `${ownerId}@test.local`);
    const board = await createBoard(db, ownerId, "Assignment", "ops");
    const task = await createTask(db, ownerId, { title: "Assigned without dispatch", board_id: board.id });

    const result = await replaceTaskAssignment(d1TaskAssignmentRepository(db), {
      ownerId,
      taskId: task.id,
      assigneeActorId: "actor-target",
      assignedByActorId: "actor-manager",
    });

    expect(result).toMatchObject({ assignment: { agentActorId: "actor-target", assignedByActorId: "actor-manager" } });
    await expect(db.prepare("SELECT status, assigned_to, assignee_identity_type FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({
      status: "todo",
      assigned_to: "actor-target",
      assignee_identity_type: "realmroot_actor",
    });
    await expect(
      db.prepare("SELECT actor_id, action, session_id FROM task_actions WHERE task_id = ? AND action = 'assigned'").bind(task.id).first(),
    ).resolves.toEqual({ actor_id: "actor-manager", action: "assigned", session_id: null });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM task_session_bindings WHERE task_id = ?").bind(task.id).first()).resolves.toEqual({
      count: 0,
    });
  });

  it("deletes the Session binding on release so the Task can be claimed with new Agency Session provenance", async () => {
    const { mf, db } = await setupMiniflare();
    resources.push(mf);
    const ownerId = `tenant-release-${randomUUID()}`;
    await seedUser(db, ownerId, `${ownerId}@test.local`);
    const board = await createBoard(db, ownerId, "Release binding", "ops");
    const task = await createTask(db, ownerId, { title: "Reclaim after release", board_id: board.id });
    await replaceTaskAssignment(d1TaskAssignmentRepository(db), {
      ownerId,
      taskId: task.id,
      assigneeActorId: "actor-target",
      assignedByActorId: "actor-manager",
    });
    const first = await replaceTaskClaim(d1TaskClaimRepository(db), {
      ownerId,
      taskId: task.id,
      agentActorId: "actor-target",
      runtime: "codex",
      runtimeSessionId: "resume-first",
    });

    await deleteTaskClaim(d1TaskClaimDeletionRepository(db), {
      ownerId,
      taskId: task.id,
      expectedClaimVersion: first.version,
      deletedByActorId: "actor-target",
    });
    await expect(db.prepare("SELECT * FROM task_session_bindings WHERE task_id = ?").bind(task.id).first()).resolves.toBeNull();

    await expect(
      replaceTaskClaim(d1TaskClaimRepository(db), {
        ownerId,
        taskId: task.id,
        agentActorId: "actor-target",
        runtime: "codex",
        runtimeSessionId: "resume-second",
      }),
    ).resolves.toMatchObject({ created: true, claim: { runtime: "codex", runtimeSessionId: "resume-second" } });
    await expect(
      db.prepare("SELECT runtime, runtime_session_id FROM task_session_bindings WHERE task_id = ?").bind(task.id).first(),
    ).resolves.toEqual({ runtime: "codex", runtime_session_id: "resume-second" });
  });
});
