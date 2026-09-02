// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  replaceTaskReviewSubmission,
  type TaskReviewSubmissionCommit,
  TaskReviewSubmissionFailure,
  type TaskReviewSubmissionRepository,
  type TaskReviewSubmissionTarget,
} from "../../../server/usecases/tasks/replaceTaskReviewSubmission";

const input = {
  ownerId: "tenant-a",
  taskId: "task-1",
  agentActorId: "actor-1",
  pullRequestUrl: "https://github.com/example/repo/pull/1",
};
const commit: TaskReviewSubmissionCommit = {
  actionId: "review-action-1",
  submittedAt: "2026-08-29T12:00:00.000Z",
  pullRequestUrl: input.pullRequestUrl,
};

describe("replaceTaskReviewSubmission", () => {
  it("creates a stable representation and passes the pre-read PR URL to the atomic commit", async () => {
    const repository = fakeRepository(target({ pullRequestUrl: "https://github.com/example/repo/pull/existing" }), commit);

    await expect(replaceTaskReviewSubmission(repository, input)).resolves.toEqual({
      submission: {
        id: input.taskId,
        taskId: input.taskId,
        agentActorId: input.agentActorId,
        reviewSubmissionVersion: commit.actionId,
        pullRequestUrl: input.pullRequestUrl,
        submittedAt: commit.submittedAt,
      },
      version: commit.actionId,
      created: true,
    });
    expect(repository.create).toHaveBeenCalledWith({
      ...input,
      expectedPullRequestUrl: "https://github.com/example/repo/pull/existing",
    });
  });

  it("inherits the Task PR URL when the replacement omits one", async () => {
    const inheritedUrl = "https://github.com/example/repo/pull/inherited";
    const inheritedCommit = { ...commit, pullRequestUrl: inheritedUrl };
    const repository = fakeRepository(target({ pullRequestUrl: inheritedUrl }), inheritedCommit);

    await expect(replaceTaskReviewSubmission(repository, { ...input, pullRequestUrl: null })).resolves.toMatchObject({
      submission: { pullRequestUrl: inheritedUrl },
      created: true,
    });
    expect(repository.create).toHaveBeenCalledWith({
      ...input,
      pullRequestUrl: inheritedUrl,
      expectedPullRequestUrl: inheritedUrl,
    });
  });

  it.each([
    ["missing Task", null, "TASK_NOT_FOUND"],
    ["wrong actor", target({ assignedTo: "actor-2" }), "TASK_REVIEW_FORBIDDEN"],
    ["legacy assignee", target({ assigneeIdentityType: "ak_agent" }), "TASK_REVIEW_FORBIDDEN"],
    ["unassigned Task", target({ assignedTo: null, assigneeIdentityType: null }), "TASK_REVIEW_FORBIDDEN"],
    ["todo Task", target({ status: "todo" }), "TASK_REVIEW_CONFLICT"],
    ["completed Task", target({ status: "done" }), "TASK_REVIEW_CONFLICT"],
    ["in-review Task without submission", target({ status: "in_review" }), "TASK_REVIEW_CONFLICT"],
  ] as const)("rejects %s before commit", async (_label, found, code) => {
    const repository = fakeRepository(found, commit);
    await expect(replaceTaskReviewSubmission(repository, input)).rejects.toMatchObject({ code });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it.each([
    ["the same explicit URL", input.pullRequestUrl],
    ["an omitted URL", null],
  ] as const)("returns the active submission for an idempotent retry with %s", async (_label, pullRequestUrl) => {
    const activeSubmission = commit;
    const repository = fakeRepository(target({ status: "in_review", activeSubmission }), null);

    await expect(replaceTaskReviewSubmission(repository, { ...input, pullRequestUrl })).resolves.toEqual({
      submission: {
        id: input.taskId,
        taskId: input.taskId,
        agentActorId: input.agentActorId,
        reviewSubmissionVersion: commit.actionId,
        pullRequestUrl: commit.pullRequestUrl,
        submittedAt: commit.submittedAt,
      },
      version: commit.actionId,
      created: false,
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("rejects a retry that supplies a different active PR URL", async () => {
    const repository = fakeRepository(target({ status: "in_review", activeSubmission: commit }), null);
    await expect(
      replaceTaskReviewSubmission(repository, { ...input, pullRequestUrl: "https://github.com/example/repo/pull/other" }),
    ).rejects.toMatchObject({ code: "TASK_REVIEW_CONFLICT" });
  });

  it.each([
    ["same winner", target({ status: "in_review", activeSubmission: commit }), input.pullRequestUrl, false],
    ["same winner with omitted URL", target({ status: "in_review", activeSubmission: commit }), null, false],
    [
      "different winner URL",
      target({ status: "in_review", activeSubmission: { ...commit, pullRequestUrl: "https://github.com/example/repo/pull/other" } }),
      input.pullRequestUrl,
      true,
    ],
    ["changed actor", target({ status: "in_review", assignedTo: "actor-2", activeSubmission: commit }), input.pullRequestUrl, true],
    [
      "changed identity type",
      target({ status: "in_review", assigneeIdentityType: "ak_agent", activeSubmission: commit }),
      input.pullRequestUrl,
      true,
    ],
    ["changed state", target({ status: "todo" }), input.pullRequestUrl, true],
    ["missing winner", null, input.pullRequestUrl, true],
  ] as const)("resolves a commit race with %s", async (_label, winner, pullRequestUrl, rejects) => {
    const repository = fakeRepositorySequence([target(), winner], null);
    const operation = replaceTaskReviewSubmission(repository, { ...input, pullRequestUrl });
    if (rejects) {
      await expect(operation).rejects.toMatchObject({
        name: TaskReviewSubmissionFailure.name,
        code: "TASK_REVIEW_CONFLICT",
      });
    } else {
      await expect(operation).resolves.toMatchObject({ version: commit.actionId, created: false });
    }
    expect(repository.findTarget).toHaveBeenCalledTimes(2);
  });
});

function target(overrides: Partial<TaskReviewSubmissionTarget> = {}): TaskReviewSubmissionTarget {
  return {
    status: "in_progress",
    assignedTo: input.agentActorId,
    assigneeIdentityType: "realmroot_actor",
    pullRequestUrl: null,
    activeSubmission: null,
    ...overrides,
  };
}

function fakeRepository(found: TaskReviewSubmissionTarget | null, created: TaskReviewSubmissionCommit | null): TaskReviewSubmissionRepository {
  return {
    findTarget: vi.fn(async () => found),
    create: vi.fn(async () => created),
  };
}

function fakeRepositorySequence(
  found: Array<TaskReviewSubmissionTarget | null>,
  created: TaskReviewSubmissionCommit | null,
): TaskReviewSubmissionRepository {
  return {
    findTarget: vi.fn(async () => found.shift() ?? null),
    create: vi.fn(async () => created),
  };
}
