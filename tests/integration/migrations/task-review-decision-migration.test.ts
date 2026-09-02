// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedUser, setupMiniflare } from "../../helpers/db";

let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let db: D1Database;

beforeEach(async () => {
  ({ mf, db } = await setupMiniflare());
});

afterEach(async () => {
  await mf.dispose();
});

async function decisionFixture(options: { reviewActionId?: string; createdAt?: string } = {}) {
  if (!(await db.prepare("SELECT 1 FROM user WHERE id = 'decision-migration-tenant'").first())) {
    await seedUser(db, "decision-migration-tenant", "decision-migration@example.test");
  }
  const { createBoard } = await import("../../../server/adapters/d1/boardRepo");
  const { createTask } = await import("../../../server/adapters/d1/taskRepo");
  const board = await createBoard(db, "decision-migration-tenant", `Decision migration ${randomUUID()}`, "ops");
  const task = await createTask(db, "decision-migration-tenant", { title: "Decision migration Task", board_id: board.id });
  await db
    .prepare("UPDATE tasks SET status = 'in_review', assigned_to = 'assigned-agent', assignee_identity_type = 'realmroot_actor' WHERE id = ?")
    .bind(task.id)
    .run();
  const reviewActionId = options.reviewActionId ?? `review-${randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at)
       VALUES (?, ?, 'realmroot:agent', 'assigned-agent', 'review_requested', ?)`,
    )
    .bind(reviewActionId, task.id, options.createdAt ?? new Date().toISOString())
    .run();
  await db.prepare("INSERT INTO task_review_submission_order (submission_id) VALUES (?)").bind(reviewActionId).run();
  return { taskId: task.id, reviewActionId };
}

function insertPending(taskId: string, reviewActionId: string, overrides: { kind?: string; reason?: string | null; state?: string } = {}) {
  return db
    .prepare(
      `INSERT INTO task_review_decisions
        (review_submission_id, task_id, kind, reason, actor_type, actor_id, reservation_id, state, created_at)
       VALUES (?, ?, ?, ?, 'user', 'reviewer', ?, ?, ?)`,
    )
    .bind(
      reviewActionId,
      taskId,
      overrides.kind ?? "rejection",
      overrides.reason ?? null,
      `reservation-${randomUUID()}`,
      overrides.state ?? "pending",
      new Date().toISOString(),
    )
    .run();
}

describe("0044 Task Review Decision migration", () => {
  it("creates constrained decision state and query indexes", async () => {
    const { taskId, reviewActionId } = await decisionFixture();
    await expect(insertPending(taskId, reviewActionId, { kind: "rejection", reason: "revise" })).resolves.toMatchObject({ success: true });
    await expect(
      db
        .prepare("SELECT kind, reason, actor_type, state, effect_state, action_id, decided_at, effect_delivered_at FROM task_review_decisions")
        .first(),
    ).resolves.toEqual({
      kind: "rejection",
      reason: "revise",
      actor_type: "user",
      state: "pending",
      effect_state: "pending",
      action_id: null,
      decided_at: null,
      effect_delivered_at: null,
    });

    const indexes = await db.prepare("PRAGMA index_list('task_review_decisions')").all<{ name: string }>();
    expect(indexes.results.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["idx_task_review_decisions_task", "idx_task_review_decisions_state"]),
    );
  });

  it("orders same-millisecond Review Submissions by monotonic insertion ordinal", async () => {
    const timestamp = "2026-08-29T10:00:00.000Z";
    const { taskId } = await decisionFixture({ reviewActionId: "z-older-submission", createdAt: timestamp });
    await db
      .prepare(
        `INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at)
         VALUES ('a-newer-submission', ?, 'realmroot:agent', 'assigned-agent', 'review_requested', ?)`,
      )
      .bind(taskId, timestamp)
      .run();
    await db.prepare("INSERT INTO task_review_submission_order (submission_id) VALUES ('a-newer-submission')").run();
    const { d1TaskReviewDecisionRepository } = await import("../../../server/adapters/d1/tasks/d1TaskReviewDecisions");

    const current = await d1TaskReviewDecisionRepository(db).findCurrentTarget("decision-migration-tenant", taskId);
    expect(current?.activeReviewSubmissionVersion).toBe("a-newer-submission");
    const order = await db.prepare("SELECT submission_id FROM task_review_submission_order ORDER BY ordinal").all<{ submission_id: string }>();
    expect(order.results.map(({ submission_id }) => submission_id)).toEqual(["z-older-submission", "a-newer-submission"]);
  });

  it("rejects invalid kind, actor, lifecycle, and completion reason combinations", async () => {
    for (const invalidInsert of [
      async () => {
        const fixture = await decisionFixture();
        return insertPending(fixture.taskId, fixture.reviewActionId, { kind: "approval" });
      },
      async () => {
        const fixture = await decisionFixture();
        return db
          .prepare(
            `INSERT INTO task_review_decisions
              (review_submission_id, task_id, kind, actor_type, actor_id, reservation_id, state, created_at)
             VALUES (?, ?, 'rejection', 'agent:worker', 'reviewer', ?, 'pending', ?)`,
          )
          .bind(fixture.reviewActionId, fixture.taskId, `reservation-${randomUUID()}`, new Date().toISOString())
          .run();
      },
      async () => {
        const fixture = await decisionFixture();
        return insertPending(fixture.taskId, fixture.reviewActionId, { state: "accepted" });
      },
      async () => {
        const fixture = await decisionFixture();
        return insertPending(fixture.taskId, fixture.reviewActionId, { kind: "completion", reason: "not allowed" });
      },
      async () => {
        const fixture = await decisionFixture();
        return db
          .prepare(
            `INSERT INTO task_review_decisions
              (review_submission_id, task_id, kind, actor_type, actor_id, reservation_id, state, effect_state, created_at, effect_delivered_at)
             VALUES (?, ?, 'rejection', 'user', 'reviewer', ?, 'pending', 'delivered', ?, ?)`,
          )
          .bind(fixture.reviewActionId, fixture.taskId, `reservation-${randomUUID()}`, new Date().toISOString(), new Date().toISOString())
          .run();
      },
    ]) {
      await expect(invalidInsert()).rejects.toThrow();
    }
  });

  it("cascades decisions with their Review Submission and Task", async () => {
    const first = await decisionFixture();
    await insertPending(first.taskId, first.reviewActionId);
    await db.prepare("DELETE FROM task_actions WHERE id = ?").bind(first.reviewActionId).run();
    await expect(db.prepare("SELECT COUNT(*) AS count FROM task_review_decisions WHERE task_id = ?").bind(first.taskId).first()).resolves.toEqual({
      count: 0,
    });

    const second = await decisionFixture();
    await insertPending(second.taskId, second.reviewActionId);
    await db.prepare("DELETE FROM tasks WHERE id = ?").bind(second.taskId).run();
    await expect(db.prepare("SELECT COUNT(*) AS count FROM task_review_decisions WHERE task_id = ?").bind(second.taskId).first()).resolves.toEqual({
      count: 0,
    });
  });
});
