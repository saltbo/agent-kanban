// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  replaceTaskReviewCompletion,
  replaceTaskReviewRejection,
  type StoredTaskReviewDecision,
  type TaskReviewDecisionRepository,
  type TaskReviewDecisionTarget,
} from "../../../server/usecases/tasks/replaceTaskReviewDecision";

const input = {
  ownerId: "tenant-a",
  taskId: "task-a",
  reviewSubmissionVersion: "review-a",
  actor: { type: "human" as const, id: "reviewer-a" },
};

function decision(kind: "rejection" | "completion", actor = input.actor): StoredTaskReviewDecision {
  return {
    kind,
    reason: kind === "rejection" ? "needs changes" : null,
    actor,
    reservationId: "reservation-a",
    state: "accepted",
    effectState: "delivered",
    actionId: "decision-a",
    createdAt: "2026-08-31T00:00:00.000Z",
    decidedAt: "2026-08-31T00:00:01.000Z",
    effectDeliveredAt: "2026-08-31T00:00:01.000Z",
  };
}

function repository(kind: "rejection" | "completion", actor = input.actor): TaskReviewDecisionRepository {
  const target: TaskReviewDecisionTarget = {
    taskId: input.taskId,
    status: "in_review",
    assignedTo: "assigned-agent",
    assigneeIdentityType: "realmroot_actor",
    activeReviewSubmissionVersion: input.reviewSubmissionVersion,
    decision: null,
  };
  const accepted = decision(kind, actor);
  return {
    findCurrentTarget: vi.fn(async () => target),
    findTarget: vi.fn(async () => target),
    reserve: vi.fn(async () => ({ ...accepted, state: "pending", effectState: "pending", actionId: null, decidedAt: null, effectDeliveredAt: null })),
    finalize: vi.fn(async () => ({ ...accepted, effectState: "pending", effectDeliveredAt: null })),
    markEffectDelivered: vi.fn(async () => accepted),
  };
}

describe("Task Review Decisions", () => {
  it("rejects review without accepting an AMA message effect", async () => {
    const repo = repository("rejection");
    await expect(replaceTaskReviewRejection(repo, { ...input, reason: "needs changes" })).resolves.toMatchObject({
      created: true,
      assigneeActorId: "assigned-agent",
      rejection: { reason: "needs changes", rejectedByActorId: input.actor.id },
    });
    expect(repo.finalize).toHaveBeenCalledOnce();
    expect(repo.markEffectDelivered).toHaveBeenCalledOnce();
  });

  it("completes review without accepting an AMA close effect", async () => {
    const repo = repository("completion");
    await expect(replaceTaskReviewCompletion(repo, input)).resolves.toMatchObject({
      created: true,
      assigneeActorId: "assigned-agent",
      completion: { completedByActorId: input.actor.id },
    });
    expect(repo.finalize).toHaveBeenCalledOnce();
    expect(repo.markEffectDelivered).toHaveBeenCalledOnce();
  });

  it("[spec: tasks/self-review] rejects the assignee before changing Task state", async () => {
    const actor = { type: "agent" as const, id: "assigned-agent" };
    const repo = repository("completion", actor);
    await expect(replaceTaskReviewCompletion(repo, { ...input, actor })).rejects.toMatchObject({
      code: "TASK_REVIEW_DECISION_FORBIDDEN",
    });
    expect(repo.reserve).not.toHaveBeenCalled();
    expect(repo.finalize).not.toHaveBeenCalled();
  });
});
