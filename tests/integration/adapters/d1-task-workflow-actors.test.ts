// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBoard } from "../../../server/adapters/d1/boardRepo";
import { createTask } from "../../../server/adapters/d1/taskRepo";
import { d1TaskCancellationRepository } from "../../../server/adapters/d1/tasks/d1TaskCancellations";
import { d1TaskReviewDecisionRepository } from "../../../server/adapters/d1/tasks/d1TaskReviewDecisions";
import { taskWorkflowActor } from "../../../server/http/tasks/workflowSupport";
import { replaceTaskCancellation } from "../../../server/usecases/tasks/replaceTaskCancellation";
import { replaceTaskReviewCompletion } from "../../../server/usecases/tasks/replaceTaskReviewDecision";
import { seedUser, setupMiniflare } from "../../helpers/db";

const ownerId = "workflow-audit-owner";
let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let db: D1Database;

beforeEach(async () => {
  ({ mf, db } = await setupMiniflare());
  await seedUser(db, ownerId, "workflow-audit@example.test");
});

afterEach(async () => mf.dispose());

describe("D1 Task workflow actor audit", () => {
  it.each(["machine", "service"] as const)("preserves a %s cancellation actor in storage and returned representations", async (actorType) => {
    const board = await createBoard(db, ownerId, `${actorType} cancellation`, "ops");
    const task = await createTask(db, ownerId, { title: `${actorType} cancellation`, board_id: board.id });
    const actorId = `${actorType}-subject`;
    const actor = workflowActor(actorType, actorId);
    const repository = d1TaskCancellationRepository(db);

    const created = await replaceTaskCancellation(repository, {
      ownerId,
      taskId: task.id,
      actor,
    });

    expect(created).toMatchObject({
      created: true,
      cancellation: { cancelledByActorType: actorType, cancelledByActorId: actorId },
    });
    await expect(
      db.prepare("SELECT actor_type, actor_id FROM task_actions WHERE task_id = ? AND action = 'cancelled'").bind(task.id).first(),
    ).resolves.toEqual({ actor_type: actorType, actor_id: actorId });

    await expect(
      replaceTaskCancellation(repository, { ownerId, taskId: task.id, actor: { type: "human", id: "retry-reader" } }),
    ).resolves.toMatchObject({
      created: false,
      cancellation: { cancelledByActorType: actorType, cancelledByActorId: actorId },
    });
  });

  it.each(["machine", "service"] as const)("preserves a %s review decision actor in storage and returned representations", async (actorType) => {
    const board = await createBoard(db, ownerId, `${actorType} completion`, "ops");
    const task = await createTask(db, ownerId, { title: `${actorType} completion`, board_id: board.id });
    const reviewSubmissionVersion = `review-${randomUUID()}`;
    const actorId = `${actorType}-subject`;
    const actor = workflowActor(actorType, actorId);
    await db
      .prepare("UPDATE tasks SET status = 'in_review', assigned_to = 'assigned-agent', assignee_identity_type = 'realmroot_actor' WHERE id = ?")
      .bind(task.id)
      .run();
    await db
      .prepare(
        `INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at)
         VALUES (?, ?, 'realmroot:agent', 'assigned-agent', 'review_requested', ?)`,
      )
      .bind(reviewSubmissionVersion, task.id, "2026-09-04T00:00:00.000Z")
      .run();
    await db.prepare("INSERT INTO task_review_submission_order (submission_id) VALUES (?)").bind(reviewSubmissionVersion).run();
    const repository = d1TaskReviewDecisionRepository(db);

    const created = await replaceTaskReviewCompletion(repository, {
      ownerId,
      taskId: task.id,
      reviewSubmissionVersion,
      actor,
    });

    expect(created).toMatchObject({
      created: true,
      completion: { completedByActorType: actorType, completedByActorId: actorId },
    });
    await expect(
      db.prepare("SELECT actor_type, actor_id FROM task_review_decisions WHERE review_submission_id = ?").bind(reviewSubmissionVersion).first(),
    ).resolves.toEqual({ actor_type: actorType, actor_id: actorId });
    await expect(
      db.prepare("SELECT actor_type, actor_id FROM task_actions WHERE task_id = ? AND action = 'completed'").bind(task.id).first(),
    ).resolves.toEqual({ actor_type: actorType, actor_id: actorId });

    await expect(
      replaceTaskReviewCompletion(repository, {
        ownerId,
        taskId: task.id,
        reviewSubmissionVersion,
        actor: { type: "human", id: "retry-reader" },
      }),
    ).resolves.toMatchObject({
      created: false,
      completion: { completedByActorType: actorType, completedByActorId: actorId },
    });
  });
});

function workflowActor(type: "machine" | "service", subjectId: string): ReturnType<typeof taskWorkflowActor> {
  const values = { principal: { type, subjectId, actorId: `${type}-noncanonical-actor-id` } };
  const context = {
    get(key: keyof typeof values) {
      return values[key];
    },
  } as Parameters<typeof taskWorkflowActor>[0];
  return taskWorkflowActor(context);
}
