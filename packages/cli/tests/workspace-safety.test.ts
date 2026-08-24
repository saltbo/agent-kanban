// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  removeWorktree: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFileSync: mocks.execFileSync }));
vi.mock("../src/paths.js", () => ({ WORKTREES_DIR: "/tmp/ak-worktrees-that-do-not-exist" }));
vi.mock("../src/workspace/repoOps.js", () => ({
  createWorktree: vi.fn(),
  removeWorktree: mocks.removeWorktree,
}));
vi.mock("../src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { canSafelyDiscardOrphanWorkspace, cleanupWorkspace } from "../src/workspace/workspace.js";

describe("missing repo workspace safety", () => {
  it("returns false before invoking git or worktree removal", () => {
    const workspace = {
      type: "repo" as const,
      cwd: "/tmp/missing-ak-worktree",
      repoDir: "/tmp/untrusted-repo",
      branchName: "ak/missing;touch-pwned",
    };

    expect(canSafelyDiscardOrphanWorkspace(workspace)).toBe(false);
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
  });

  it("refuses destructive cleanup for a non-allowlisted runtime failure reason", () => {
    const workspace = {
      type: "repo" as const,
      cwd: "/tmp/missing-ak-worktree",
      repoDir: "/tmp/untrusted-repo",
      branchName: "ak/runtime-error",
    };

    expect(() => cleanupWorkspace(workspace, "runtime_error" as any)).toThrow("Workspace cleanup refused for non-terminal reason: runtime_error");
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
  });
});
