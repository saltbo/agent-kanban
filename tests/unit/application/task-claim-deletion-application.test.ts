// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  deleteTaskClaim,
  type StoredTaskClaimDeletion,
  type TaskClaimDeletionRepository,
  type TaskClaimDeletionTarget,
} from "../../../server/usecases/tasks/deleteTaskClaim";

const input = {
  ownerId: "tenant-a",
  taskId: "task-a",
  expectedClaimVersion: "claim-a",
  deletedByActorId: "agent-a",
};

const deletion: StoredTaskClaimDeletion = {
  claimVersion: input.expectedClaimVersion,
  actionId: "release-a",
  deletedAt: "2026-08-29T12:00:00.000Z",
};

function target(overrides: Partial<TaskClaimDeletionTarget> = {}): TaskClaimDeletionTarget {
  return {
    status: "in_progress",
    assignedTo: input.deletedByActorId,
    assigneeIdentityType: "realmroot_actor",
    activeClaimVersion: input.expectedClaimVersion,
    matchingDeletion: null,
    ...overrides,
  };
}

function repository(
  options: { initial?: TaskClaimDeletionTarget | null; deleted?: StoredTaskClaimDeletion | null; afterRace?: TaskClaimDeletionTarget | null } = {},
): TaskClaimDeletionRepository {
  let reads = 0;
  const initial = options.initial === undefined ? target() : options.initial;
  return {
    findTarget: vi.fn(async () => (reads++ === 0 ? initial : options.afterRace === undefined ? initial : options.afterRace)),
    delete: vi.fn(async () => (options.deleted === undefined ? deletion : options.deleted)),
  };
}

describe("deleteTaskClaim", () => {
  it("deletes only the strongly matching active Claim", async () => {
    const repo = repository();
    await expect(deleteTaskClaim(repo, input)).resolves.toBeUndefined();
    expect(repo.delete).toHaveBeenCalledWith(input);
  });

  it("accepts an identical tombstone retry without another write", async () => {
    const repo = repository({ initial: target({ status: "todo", activeClaimVersion: null, matchingDeletion: deletion }) });
    await expect(deleteTaskClaim(repo, input)).resolves.toBeUndefined();
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it("conceals a wrong tenant or Task as not found", async () => {
    const repo = repository({ initial: null });
    await expect(deleteTaskClaim(repo, input)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it("forbids deleting a legacy-assignee Claim", async () => {
    const repo = repository({ initial: target({ assigneeIdentityType: "ak_agent" }) });
    await expect(deleteTaskClaim(repo, input)).rejects.toMatchObject({ code: "TASK_CLAIM_DELETION_FORBIDDEN" });
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it.each([
    ["a stale version", target({ activeClaimVersion: "claim-new" })],
    ["an absent active Claim", target({ activeClaimVersion: null })],
    ["a non-active state", target({ status: "in_review" })],
  ])("rejects %s with a precondition failure", async (_case, initial) => {
    const repo = repository({ initial });
    await expect(deleteTaskClaim(repo, input)).rejects.toMatchObject({ code: "TASK_CLAIM_PRECONDITION_FAILED" });
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it("returns a tombstone created by the repository race winner", async () => {
    const repo = repository({
      deleted: null,
      afterRace: target({ status: "todo", activeClaimVersion: null, matchingDeletion: deletion }),
    });
    await expect(deleteTaskClaim(repo, input)).resolves.toBeUndefined();
    expect(repo.findTarget).toHaveBeenCalledTimes(2);
  });

  it("reports a stable conflict when the conditional repository write loses without a tombstone", async () => {
    const repo = repository({ deleted: null, afterRace: target({ activeClaimVersion: input.expectedClaimVersion }) });
    await expect(deleteTaskClaim(repo, input)).rejects.toMatchObject({ code: "TASK_CLAIM_DELETION_CONFLICT" });
  });
});
