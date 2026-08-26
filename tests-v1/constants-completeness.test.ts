import { AGENT_STATUSES, TASK_ACTIONS } from "@agent-kanban/shared";
import { describe, expect, it } from "vitest";

describe("enum completeness", () => {
  it("TASK_ACTIONS matches the migration CHECK constraint", () => {
    const migrationActions = [
      "created",
      "claimed",
      "moved",
      "commented",
      "completed",
      "assigned",
      "released",
      "timed_out",
      "cancelled",
      "rejected",
      "review_requested",
      "dispatched",
      "dispatch_failed",
    ];
    expect([...TASK_ACTIONS]).toEqual(migrationActions);
  });

  it("AGENT_STATUSES covers all valid states", () => {
    expect([...AGENT_STATUSES]).toEqual(["online", "offline"]);
  });

  it("TaskAction type union matches TASK_ACTIONS constant", () => {
    const actions: string[] = [...TASK_ACTIONS];
    expect(actions).toHaveLength(13);
    expect(actions).toContain("assigned");
    expect(actions).toContain("released");
    expect(actions).toContain("timed_out");
    expect(actions).toContain("cancelled");
    expect(actions).toContain("rejected");
    expect(actions).toContain("review_requested");
    expect(actions).toContain("dispatched");
    expect(actions).toContain("dispatch_failed");
  });
});
