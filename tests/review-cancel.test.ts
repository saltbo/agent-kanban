import { TASK_ACTIONS, TASK_STATUSES } from "@agent-kanban/shared";
import { describe, expect, it } from "vitest";

describe("task statuses", () => {
  it("TASK_STATUSES includes 'in_review' at position 2", () => {
    expect(TASK_STATUSES[2]).toBe("in_review");
  });

  it("TASK_STATUSES includes the error queue before terminal statuses", () => {
    expect(TASK_STATUSES[3]).toBe("error");
    expect(TASK_STATUSES[5]).toBe("cancelled");
  });

  it("TASK_STATUSES has the full ordered list", () => {
    expect([...TASK_STATUSES]).toEqual(["todo", "in_progress", "in_review", "error", "done", "cancelled"]);
  });

  it("'in_review' comes after 'in_progress' and before 'error'", () => {
    const inProgress = TASK_STATUSES.indexOf("in_progress");
    const inReview = TASK_STATUSES.indexOf("in_review");
    const error = TASK_STATUSES.indexOf("error");
    expect(inReview).toBe(inProgress + 1);
    expect(inReview).toBe(error - 1);
  });

  it("'cancelled' is the last status", () => {
    expect(TASK_STATUSES[TASK_STATUSES.length - 1]).toBe("cancelled");
  });
});

describe("review and cancel task actions", () => {
  it("TASK_ACTIONS includes 'cancelled'", () => {
    expect(TASK_ACTIONS).toContain("cancelled");
  });

  it("TASK_ACTIONS includes 'review_requested'", () => {
    expect(TASK_ACTIONS).toContain("review_requested");
  });

  it("appends failure and retry actions after dispatch actions", () => {
    const len = TASK_ACTIONS.length;
    expect(TASK_ACTIONS.slice(len - 4)).toEqual(["dispatched", "dispatch_failed", "failed", "retried"]);
  });

  it("TASK_ACTIONS has exactly 15 entries with error queue actions", () => {
    expect(TASK_ACTIONS).toHaveLength(15);
  });

  it("new actions coexist with all original actions", () => {
    const originals = ["created", "claimed", "moved", "commented", "completed", "assigned", "released", "timed_out"] as const;
    for (const action of originals) {
      expect(TASK_ACTIONS).toContain(action);
    }
  });
});
