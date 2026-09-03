// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { replaceTaskCancellation, type TaskCancellationRepository } from "../../../server/usecases/tasks/replaceTaskCancellation";

describe("Task Cancellation", () => {
  it("cancels a Task without accepting an Agency runtime effect", async () => {
    const repository: TaskCancellationRepository = {
      findTarget: vi.fn(async () => ({
        status: "in_progress",
        assignedTo: "assigned-agent",
        assigneeIdentityType: "realmroot_actor",
        cancellation: null,
      })),
      create: vi.fn(async () => ({
        actionId: "cancel-a",
        actorType: "human",
        actorId: "reviewer-a",
        cancelledAt: "2026-08-31T00:00:00.000Z",
        assigneeActorId: "assigned-agent",
      })),
    };

    await expect(
      replaceTaskCancellation(repository, {
        ownerId: "tenant-a",
        taskId: "task-a",
        actor: { type: "human", id: "reviewer-a" },
      }),
    ).resolves.toMatchObject({ created: true, assigneeActorId: "assigned-agent", cancellation: { cancelledByActorId: "reviewer-a" } });
    expect(repository.create).toHaveBeenCalledOnce();
  });
});
