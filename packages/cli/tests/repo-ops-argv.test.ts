// @vitest-environment node

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  root: `/tmp/ak-repo-argv-${process.pid}`,
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: state.execFileSync,
  execSync: state.execSync,
}));
vi.mock("../src/paths.js", () => ({
  REPOS_DIR: join(state.root, "repos"),
  WORKTREES_DIR: join(state.root, "worktrees"),
}));
vi.mock("../src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createWorktree, removeWorktree } from "../src/workspace/repoOps.js";

describe("repo worktree argv safety", () => {
  beforeEach(() => {
    rmSync(state.root, { recursive: true, force: true });
    mkdirSync(state.root, { recursive: true });
    state.execFileSync.mockReset();
    state.execSync.mockReset();
    state.execFileSync.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "show-ref") throw new Error("missing branch");
      return Buffer.from("");
    });
  });

  afterEach(() => {
    rmSync(state.root, { recursive: true, force: true });
  });

  it("passes create and remove values as literal execFileSync argv", () => {
    const marker = join(state.root, "owned");
    const name = `feature;touch\${IFS}${marker};#`;
    const branchName = `ak/${name}`;
    const worktreeDir = join(state.root, "worktrees", name);

    expect(createWorktree("/repo", "session-shell", name)).toEqual({ worktreeDir, branchName });
    expect(state.execFileSync).toHaveBeenNthCalledWith(1, "git", ["show-ref", "--verify", `refs/heads/${branchName}`], {
      cwd: "/repo",
      stdio: "pipe",
    });
    expect(state.execFileSync).toHaveBeenNthCalledWith(2, "git", ["worktree", "add", worktreeDir, "-b", branchName], {
      cwd: "/repo",
      stdio: "pipe",
    });

    removeWorktree("/repo", worktreeDir, branchName);
    expect(state.execFileSync).toHaveBeenNthCalledWith(3, "git", ["worktree", "remove", worktreeDir, "--force"], {
      cwd: "/repo",
      stdio: "pipe",
    });
    expect(state.execFileSync).toHaveBeenNthCalledWith(4, "git", ["branch", "-D", branchName], {
      cwd: "/repo",
      stdio: "pipe",
    });
    expect(state.execSync).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
  });
});
