import { describe, expect, it } from "vitest";
import { groupByDependencyLayer } from "../apps/web/src/components/KanbanColumn";
import { todoPendingReason, worktreeLabel } from "../apps/web/src/components/TaskDetail";

const task = (id: string, depends_on: string[] = [], extra: Record<string, unknown> = {}) => ({ id, depends_on, ...extra });

describe("groupByDependencyLayer", () => {
  it("returns no groups for an empty column", () => {
    expect(groupByDependencyLayer([])).toEqual([]);
  });

  it("puts tasks without in-column dependencies in a single group", () => {
    const tasks = [task("a"), task("b"), task("c")];
    const groups = groupByDependencyLayer(tasks);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("layers a dependency chain into separate groups", () => {
    const tasks = [task("c", ["b"]), task("a"), task("b", ["a"])];
    const groups = groupByDependencyLayer(tasks);
    expect(groups.map((g) => g.map((t) => t.id))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("keeps parallelizable tasks in the same layer", () => {
    const tasks = [task("b", ["a"]), task("a"), task("c", ["a"]), task("d")];
    const groups = groupByDependencyLayer(tasks);
    expect(groups.map((g) => g.map((t) => t.id).sort())).toEqual([["a", "d"], ["b", "c"]]);
  });

  it("ignores dependencies that live outside the column", () => {
    const tasks = [task("a", ["elsewhere"]), task("b")];
    const groups = groupByDependencyLayer(tasks);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("does not hang on dependency cycles", () => {
    const tasks = [task("a", ["b"]), task("b", ["a"])];
    const groups = groupByDependencyLayer(tasks);
    expect(groups.flat().map((t) => t.id).sort()).toEqual(["a", "b"]);
  });
});

describe("todoPendingReason", () => {
  it("lists unfinished dependencies by title", () => {
    const reason = todoPendingReason(task("t", ["d1", "d2"]), {
      d1: { title: "Build API", status: "in_progress" },
      d2: { title: "Write docs", status: "done" },
    });
    expect(reason).toContain("1 unfinished dependency");
    expect(reason).toContain("Build API");
    expect(reason).not.toContain("Write docs");
  });

  it("treats cancelled dependencies as satisfied", () => {
    const reason = todoPendingReason(task("t", ["d1"], { assigned_to: "agent-1" }), {
      d1: { title: "Old work", status: "cancelled" },
    });
    expect(reason).toContain("agent-1");
  });

  it("falls back to blocked when dependency data is unavailable", () => {
    expect(todoPendingReason({ id: "t", depends_on: [], blocked: true }, {})).toBe("Blocked by unfinished dependencies.");
  });

  it("reports a future schedule", () => {
    const reason = todoPendingReason({ id: "t", depends_on: [], scheduled_at: new Date(Date.now() + 3600_000).toISOString() }, {});
    expect(reason).toContain("Scheduled to start at");
  });

  it("reports missing assignment", () => {
    expect(todoPendingReason({ id: "t", depends_on: [] }, {})).toContain("No agent assigned");
  });

  it("reports waiting for claim when assigned", () => {
    const reason = todoPendingReason({ id: "t", depends_on: [], assigned_to: "a1", agent_name: "Worker" }, {});
    expect(reason).toContain("Worker");
    expect(reason).toContain("claim");
  });

  it("indicates dependency status is still loading", () => {
    expect(todoPendingReason({ id: "t", depends_on: ["d1"] }, {})).toContain("Loading dependency status");
  });
});

describe("worktreeLabel", () => {
  it("shows the custom worktree branch", () => {
    expect(worktreeLabel({ id: "abc123", metadata: { worktree: { enabled: true, name: "my-branch" } } })).toBe("ak/my-branch");
  });

  it("shows the auto-generated branch when no custom name is set", () => {
    expect(worktreeLabel({ id: "abc123", metadata: {} })).toBe("ak/abc123 (auto)");
  });

  it("reports disabled worktrees", () => {
    expect(worktreeLabel({ id: "abc123", metadata: { worktree: { enabled: false } } })).toContain("Disabled");
  });
});
