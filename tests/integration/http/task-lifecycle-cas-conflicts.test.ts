// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoard } from "../../../server/adapters/d1/boardRepo";
import { createTask } from "../../../server/adapters/d1/taskRepo";
import { api } from "../../../server/http/app";
import { createTestEnv, createTestWebSession, seedUser, setupMiniflare } from "../../helpers/db";

const controlledFailure = vi.hoisted(() => ({ kind: "", bumpVersion: async () => undefined }));

vi.mock("@server/usecases/tasks/replaceTaskAssignment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../server/usecases/tasks/replaceTaskAssignment")>();
  return {
    ...actual,
    replaceTaskAssignment: async (...args: Parameters<typeof actual.replaceTaskAssignment>) => {
      if (controlledFailure.kind !== "assignment") return actual.replaceTaskAssignment(...args);
      await controlledFailure.bumpVersion();
      throw new actual.TaskAssignmentFailure("TASK_ASSIGNMENT_CONFLICT", "controlled stale assignment");
    },
  };
});

vi.mock("@server/usecases/tasks/replaceTaskReviewSubmission", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../server/usecases/tasks/replaceTaskReviewSubmission")>();
  return {
    ...actual,
    replaceTaskReviewSubmission: async (...args: Parameters<typeof actual.replaceTaskReviewSubmission>) => {
      if (controlledFailure.kind !== "review-submission") return actual.replaceTaskReviewSubmission(...args);
      await controlledFailure.bumpVersion();
      throw new actual.TaskReviewSubmissionFailure("TASK_REVIEW_CONFLICT", "controlled stale review submission");
    },
  };
});

vi.mock("@server/usecases/tasks/replaceTaskCancellation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../server/usecases/tasks/replaceTaskCancellation")>();
  return {
    ...actual,
    replaceTaskCancellation: async (...args: Parameters<typeof actual.replaceTaskCancellation>) => {
      if (controlledFailure.kind !== "cancellation") return actual.replaceTaskCancellation(...args);
      await controlledFailure.bumpVersion();
      throw new actual.TaskCancellationFailure("TASK_CANCELLATION_CONFLICT", "controlled stale cancellation");
    },
  };
});

vi.mock("@server/usecases/tasks/replaceTaskReviewDecision", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../server/usecases/tasks/replaceTaskReviewDecision")>();
  const fail = async () => {
    await controlledFailure.bumpVersion();
    throw new actual.TaskReviewDecisionFailure("TASK_REVIEW_PRECONDITION_FAILED", "controlled stale review decision");
  };
  return {
    ...actual,
    replaceTaskReviewRejection: async (...args: Parameters<typeof actual.replaceTaskReviewRejection>) =>
      controlledFailure.kind === "review-rejection" ? fail() : actual.replaceTaskReviewRejection(...args),
    replaceTaskReviewCompletion: async (...args: Parameters<typeof actual.replaceTaskReviewCompletion>) =>
      controlledFailure.kind === "review-completion" ? fail() : actual.replaceTaskReviewCompletion(...args),
  };
});

const ownerId = "task-lifecycle-conflict-owner";
const resource = "https://agent-kanban.test/api";
let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let db: D1Database;

beforeEach(async () => {
  ({ mf, db } = await setupMiniflare());
  await seedUser(db, ownerId, "task-lifecycle-conflict@example.test");
});

afterEach(async () => {
  controlledFailure.kind = "";
  controlledFailure.bumpVersion = async () => undefined;
  await mf.dispose();
});

describe("Task lifecycle HTTP compare-and-set conflicts", () => {
  it.each(["assignment", "review-submission", "cancellation", "review-rejection", "review-completion"] as const)(
    "maps a concurrent %s version change to task-update-conflict",
    async (kind) => {
      const board = await createBoard(db, ownerId, `HTTP ${kind} conflict`, "ops");
      const task = await createTask(db, ownerId, { title: `HTTP ${kind} conflict`, board_id: board.id });
      const reviewer = kind === "review-submission" ? "assigned-agent" : "reviewer";
      const session = await createTestWebSession(db, ownerId, { subjectId: reviewer });

      if (kind === "review-submission") await setTaskState(task.id, "in_progress");
      if (kind === "review-rejection" || kind === "review-completion") {
        await setTaskState(task.id, "in_review");
        await db
          .prepare(
            `INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at)
             VALUES ('active-submission', ?, 'realmroot:agent', 'assigned-agent', 'review_requested', ?)`,
          )
          .bind(task.id, "2026-09-05T00:00:00.000Z")
          .run();
        await db.prepare("INSERT INTO task_review_submission_order (submission_id) VALUES ('active-submission')").run();
      }

      controlledFailure.kind = kind;
      controlledFailure.bumpVersion = async () => {
        await db.prepare("UPDATE tasks SET version = version + 1 WHERE id = ?").bind(task.id).run();
      };
      const body =
        kind === "assignment"
          ? { assignedTo: "assigned-agent" }
          : kind === "review-submission"
            ? { status: "in-review" }
            : kind === "cancellation"
              ? { status: "cancelled" }
              : kind === "review-rejection"
                ? { status: "in-progress", statusReason: "needs changes" }
                : { status: "done" };

      const response = await api.fetch(
        new Request(`${resource}/tasks/${task.id}`, {
          method: "PATCH",
          headers: {
            cookie: session.cookie,
            "x-csrf-token": session.csrfToken,
            "API-Version": "2026-08-29",
            "Content-Type": "application/merge-patch+json",
          },
          body: JSON.stringify(body),
        }),
        { ...createTestEnv(), DB: db, AK_PUBLIC_ORIGIN: new URL(resource).origin },
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        type: `${resource}/problems/task-update-conflict`,
        detail: expect.stringMatching(/reread/i),
      });
      await expect(db.prepare("SELECT version FROM tasks WHERE id = ?").bind(task.id).first()).resolves.toEqual({ version: 2 });
    },
  );
});

async function setTaskState(taskId: string, status: "in_progress" | "in_review"): Promise<void> {
  await db
    .prepare("UPDATE tasks SET status = ?, assigned_to = 'assigned-agent', assignee_identity_type = 'realmroot_actor' WHERE id = ?")
    .bind(status, taskId)
    .run();
}
