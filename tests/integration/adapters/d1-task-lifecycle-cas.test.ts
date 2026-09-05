// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBoard } from "../../../server/adapters/d1/boardRepo";
import { createTask } from "../../../server/adapters/d1/taskRepo";
import { d1TaskAssignmentRepository } from "../../../server/adapters/d1/tasks/d1TaskAssignments";
import { d1TaskCancellationRepository } from "../../../server/adapters/d1/tasks/d1TaskCancellations";
import { d1TaskReviewDecisionRepository } from "../../../server/adapters/d1/tasks/d1TaskReviewDecisions";
import { d1TaskReviewSubmissionRepository } from "../../../server/adapters/d1/tasks/d1TaskReviewSubmissions";
import { seedUser, setupMiniflare } from "../../helpers/db";

const ownerId = "task-lifecycle-cas-owner";
let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let db: D1Database;

beforeEach(async () => {
  ({ mf, db } = await setupMiniflare());
  await seedUser(db, ownerId, "task-lifecycle-cas@example.test");
});

afterEach(async () => mf.dispose());

describe("D1 Task lifecycle compare-and-set", () => {
  it.each(["assignment", "review-submission", "cancellation", "review-rejection", "review-completion"] as const)(
    "does not commit a %s with a stale expected Task version",
    async (kind) => {
      const board = await createBoard(db, ownerId, `Stale ${kind}`, "ops");
      const task = await createTask(db, ownerId, { title: `Stale ${kind}`, board_id: board.id });
      let committed: unknown;

      if (kind === "assignment") {
        committed = await d1TaskAssignmentRepository(db).create({
          ownerId,
          taskId: task.id,
          assigneeActorId: "assigned-agent",
          assignedByActorId: "assigner",
          expectedTaskVersion: 0,
        });
      } else if (kind === "review-submission") {
        await setTaskState(task.id, "in_progress");
        committed = await d1TaskReviewSubmissionRepository(db).create({
          ownerId,
          taskId: task.id,
          agentActorId: "assigned-agent",
          expectedPullRequestUrl: null,
          pullRequestUrl: "https://github.com/example/repository/pull/1",
          expectedTaskVersion: 0,
        });
      } else if (kind === "cancellation") {
        committed = await d1TaskCancellationRepository(db).create({
          ownerId,
          taskId: task.id,
          actor: { type: "human", id: "reviewer" },
          assigneeActorId: null,
          expectedTaskVersion: 0,
        });
      } else {
        const reviewSubmissionVersion = "review-submission";
        await setTaskState(task.id, "in_review");
        await db
          .prepare(
            `INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at)
             VALUES (?, ?, 'realmroot:agent', 'assigned-agent', 'review_requested', ?)`,
          )
          .bind(reviewSubmissionVersion, task.id, "2026-09-05T00:00:00.000Z")
          .run();
        await db.prepare("INSERT INTO task_review_submission_order (submission_id) VALUES (?)").bind(reviewSubmissionVersion).run();
        committed = await d1TaskReviewDecisionRepository(db).reserve({
          ownerId,
          taskId: task.id,
          reviewSubmissionVersion,
          expectedAssignedTo: "assigned-agent",
          kind: kind === "review-rejection" ? "rejection" : "completion",
          reason: kind === "review-rejection" ? "needs changes" : null,
          actor: { type: "human", id: "reviewer" },
          expectedTaskVersion: 0,
        });
      }

      expect(committed).toBeNull();
      await expect(db.prepare("SELECT version, transition_token FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({
        version: 1,
        transition_token: null,
      });
      await expect(
        db.prepare("SELECT COUNT(*) AS count FROM task_actions WHERE task_id = ? AND action != 'created'").bind(task.id).first(),
      ).resolves.toEqual({ count: kind.startsWith("review-") && kind !== "review-submission" ? 1 : 0 });
      await expect(db.prepare("SELECT COUNT(*) AS count FROM task_review_decisions WHERE task_id = ?").bind(task.id).first()).resolves.toEqual({
        count: 0,
      });
    },
  );
});

async function setTaskState(taskId: string, status: "in_progress" | "in_review"): Promise<void> {
  await db
    .prepare("UPDATE tasks SET status = ?, assigned_to = 'assigned-agent', assignee_identity_type = 'realmroot_actor' WHERE id = ?")
    .bind(status, taskId)
    .run();
}
