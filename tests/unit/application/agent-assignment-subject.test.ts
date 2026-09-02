import { describe, expect, it, vi } from "vitest";
import { replaceTaskAssignment, type TaskAssignmentRepository } from "../../../server/usecases/tasks/replaceTaskAssignment";

describe("Agent projection Assignment boundary", () => {
  it("[spec: agents/assignment-subject] stores the projected subject as agentActorId without an AMA dependency", async () => {
    const repository: TaskAssignmentRepository = {
      findTarget: vi.fn().mockResolvedValue({ status: "todo", assignedTo: null, assigneeIdentityType: null, activeAssignment: null }),
      create: vi.fn().mockResolvedValue({
        actionId: "assignment-version",
        assignedAt: "2026-09-01T12:00:00.000Z",
        assignedByActorId: "human-actor",
      }),
    };

    const result = await replaceTaskAssignment(repository, {
      ownerId: "tenant-1",
      taskId: "task-1",
      assigneeActorId: "realmroot-agent-subject",
      assignedByActorId: "human-actor",
    });

    expect(repository.create).toHaveBeenCalledWith({
      ownerId: "tenant-1",
      taskId: "task-1",
      assigneeActorId: "realmroot-agent-subject",
      assignedByActorId: "human-actor",
    });
    expect(result.assignment.agentActorId).toBe("realmroot-agent-subject");
  });
});
