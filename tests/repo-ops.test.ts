// @vitest-environment node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Redirect REPOS_DIR/WORKTREES_DIR into a per-process temp dir so tests never
// touch the real CLI data dir.
const dirs = vi.hoisted(() => {
  // vi.hoisted runs before imports — string-join instead of node:path.
  const root = `${process.env.TMPDIR ?? "/tmp"}/ak-test-repoops-${process.pid}`;
  return { root, repos: `${root}/repos`, worktrees: `${root}/worktrees` };
});

vi.mock("../packages/cli/src/paths.js", () => ({
  REPOS_DIR: dirs.repos,
  WORKTREES_DIR: dirs.worktrees,
}));

// Git hook env pollution guard: when vitest runs inside `git commit` (lefthook
// pre-commit), git exports GIT_DIR/GIT_INDEX_FILE/... pointing at the real
// repo. createWorktree's execSync inherits process.env, so the fixture repos'
// git subprocesses would operate on the host repo's index and fail. Scrub
// these vars from process.env for the duration of each test, restore after.
const GIT_HOOK_ENV_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
] as const;

let savedGitHookEnv: Record<string, string | undefined> = {};

const GIT_ENV = (() => {
  // Snapshot process.env minus the hook vars — this object is built at module
  // load, before beforeEach scrubs process.env.
  const env = { ...process.env };
  for (const key of GIT_HOOK_ENV_VARS) delete env[key];
  return {
    ...env,
    GIT_AUTHOR_NAME: "AK Test",
    GIT_AUTHOR_EMAIL: "ak-test@example.com",
    GIT_COMMITTER_NAME: "AK Test",
    GIT_COMMITTER_EMAIL: "ak-test@example.com",
  };
})();

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "pipe" }).toString().trim();
}

/** Create a real git repo with one commit inside the temp root. */
function initRepo(): string {
  const dir = mkdtempSync(join(dirs.root, "repo-"));
  git(["init"], dir);
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

async function importRepoOps() {
  return import("../packages/cli/src/workspace/repoOps.js");
}

beforeEach(() => {
  mkdirSync(dirs.root, { recursive: true });
  vi.resetModules();
  savedGitHookEnv = {};
  for (const key of GIT_HOOK_ENV_VARS) {
    savedGitHookEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  rmSync(dirs.root, { recursive: true, force: true });
  for (const key of GIT_HOOK_ENV_VARS) {
    const value = savedGitHookEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("isLocalRepoUrl", () => {
  it("is true for absolute paths", async () => {
    const { isLocalRepoUrl } = await importRepoOps();
    expect(isLocalRepoUrl("/home/user/project")).toBe(true);
    expect(isLocalRepoUrl("/")).toBe(true);
  });

  it("is false for remote URLs and relative paths", async () => {
    const { isLocalRepoUrl } = await importRepoOps();
    expect(isLocalRepoUrl("https://github.com/org/repo")).toBe(false);
    expect(isLocalRepoUrl("git@github.com:org/repo.git")).toBe(false);
    expect(isLocalRepoUrl("relative/path")).toBe(false);
  });
});

describe("repoDir", () => {
  it("passes local URLs through as-is (no DATA_DIR mapping)", async () => {
    const { repoDir } = await importRepoOps();
    expect(repoDir("/home/user/project")).toBe("/home/user/project");
  });

  it("maps remote URLs under REPOS_DIR", async () => {
    const { repoDir } = await importRepoOps();
    expect(repoDir("https://github.com/org/repo")).toBe(join(dirs.repos, "github.com/org/repo"));
  });
});

describe("ensureCloned (local)", () => {
  it("returns the path itself for a real git work tree", async () => {
    const { ensureCloned } = await importRepoOps();
    const dir = initRepo();
    expect(ensureCloned({ full_name: dir, url: dir })).toBe(dir);
  });

  it("returns null for a path that does not exist (never clones)", async () => {
    const { ensureCloned } = await importRepoOps();
    const missing = join(dirs.root, "no-such-repo");
    expect(ensureCloned({ full_name: missing, url: missing })).toBeNull();
    expect(existsSync(missing)).toBe(false);
  });

  it("returns null for a directory that is not a git work tree", async () => {
    const { ensureCloned } = await importRepoOps();
    const dir = mkdtempSync(join(dirs.root, "plain-"));
    expect(ensureCloned({ full_name: dir, url: dir })).toBeNull();
  });
});

describe("prepareRepo", () => {
  it("returns true immediately for local repos, even if the path is unusable", async () => {
    const { prepareRepo } = await importRepoOps();
    // A nonexistent dir would fail git status/pull — proving no git runs for local.
    expect(prepareRepo(join(dirs.root, "no-such-repo"), { local: true })).toBe(true);
  });

  it("returns false for a non-local repo with no upstream to pull", async () => {
    const { prepareRepo } = await importRepoOps();
    const dir = initRepo();
    // Clean tree, but `git pull --ff-only` has no remote → prepare fails.
    expect(prepareRepo(dir)).toBe(false);
  });
});

describe("createWorktree", () => {
  it("creates branch ak/<name> and a worktree dir for a custom name", async () => {
    const { createWorktree } = await importRepoOps();
    const dir = initRepo();
    const { worktreeDir, branchName } = createWorktree(dir, "session-aaa", "my-feature");

    expect(branchName).toBe("ak/my-feature");
    expect(worktreeDir).toBe(join(dirs.worktrees, "my-feature"));
    expect(existsSync(worktreeDir)).toBe(true);
    // Branch really exists in the source repo.
    expect(git(["show-ref", "--verify", "refs/heads/ak/my-feature"], dir)).toContain("refs/heads/ak/my-feature");
    // The worktree has the branch checked out.
    expect(git(["branch", "--show-current"], worktreeDir)).toBe("ak/my-feature");
  });

  it("falls back to ak/<name>-<sessionId[0:4]> when the branch already exists", async () => {
    const { createWorktree } = await importRepoOps();
    const dir = initRepo();
    git(["branch", "ak/taken"], dir);

    const { worktreeDir, branchName } = createWorktree(dir, "session-b1", "taken");
    expect(branchName).toBe("ak/taken-sess");
    expect(worktreeDir).toBe(join(dirs.worktrees, "taken-sess"));
    expect(existsSync(worktreeDir)).toBe(true);
  });

  it("falls back to ak/<name>-<sessionId[0:4]> when the worktree dir already exists", async () => {
    const { createWorktree } = await importRepoOps();
    const dir = initRepo();
    createWorktree(dir, "session-c1", "feat");
    const second = createWorktree(dir, "session-c2", "feat");

    expect(second.branchName).toBe("ak/feat-sess");
    expect(second.worktreeDir).toBe(join(dirs.worktrees, "feat-sess"));
    expect(git(["branch", "--show-current"], second.worktreeDir)).toBe("ak/feat-sess");
  });

  it("uses ak/<sessionId[0:8]> when no name is given", async () => {
    const { createWorktree } = await importRepoOps();
    const dir = initRepo();
    const { worktreeDir, branchName } = createWorktree(dir, "abcdef1234567890");

    expect(branchName).toBe("ak/abcdef12");
    expect(worktreeDir).toBe(join(dirs.worktrees, "abcdef12"));
    expect(existsSync(worktreeDir)).toBe(true);
  });

  it("passes a shell-metacharacter worktree name literally without executing it", async () => {
    const { createWorktree } = await importRepoOps();
    const dir = initRepo();
    const marker = join(dirs.root, "shell-owned");
    const maliciousName = `feature;touch\${IFS}${marker};#`;

    const created = createWorktree(dir, "session-shell", maliciousName);

    expect(created).toEqual({
      worktreeDir: join(dirs.worktrees, maliciousName),
      branchName: `ak/${maliciousName}`,
    });
    expect(existsSync(created.worktreeDir)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});
