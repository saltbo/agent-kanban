// @vitest-environment node

import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  return {
    root: mkdtempSync(join(tmpdir(), "ak-cleanup-worktrees-")),
    sessions: [] as any[],
    cleanupWorkspace: vi.fn(),
    removeSession: vi.fn(),
  };
});

vi.mock("../src/paths.js", () => ({ WORKTREES_DIR: join(state.root, "worktrees") }));
vi.mock("../src/session/store.js", () => ({
  isPidAlive: () => false,
  listSessions: () => state.sessions,
  removeSession: state.removeSession,
}));
vi.mock("../src/workspace/workspace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/workspace/workspace.js")>()),
  cleanupWorkspace: state.cleanupWorkspace,
}));
vi.mock("../src/agent/usage.js", () => ({ collectUsage: vi.fn(async () => null) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { cleanupStaleSessions, cleanupUntrackedWorktrees } from "../src/daemon/cleanup.js";
import { canSafelyDiscardOrphanWorkspace } from "../src/workspace/workspace.js";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function addWorktree(repo: string, name: string, branch = `ak/${name}`) {
  const cwd = join(state.root, "worktrees", name);
  execFileSync("git", ["-C", repo, "worktree", "add", "-b", branch, cwd], { stdio: "pipe" });
  return cwd;
}

function createRepo(name: string) {
  const repo = join(state.root, name);
  mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "base");
  return repo;
}

describe("startup worktree cleanup", () => {
  beforeEach(() => {
    rmSync(state.root, { recursive: true, force: true });
    mkdirSync(join(state.root, "worktrees"), { recursive: true });
    state.sessions = [];
    state.cleanupWorkspace.mockReset();
    state.removeSession.mockReset();
  });

  afterAll(() => {
    rmSync(state.root, { recursive: true, force: true });
  });

  it("removes only provably empty untracked ak/* worktrees", () => {
    const repo = createRepo("repo");

    const empty = addWorktree(repo, "empty");
    const dirty = addWorktree(repo, "dirty");
    writeFileSync(join(dirty, "dirty.txt"), "dirty\n");
    const committed = addWorktree(repo, "committed");
    writeFileSync(join(committed, "commit.txt"), "commit\n");
    git(committed, "add", "commit.txt");
    git(committed, "commit", "-m", "work");
    const unexpected = addWorktree(repo, "unexpected", "feature/unexpected");
    const tracked = addWorktree(repo, "tracked");
    state.sessions = [{ type: "worker", workspace: { cwd: tracked } }];

    cleanupUntrackedWorktrees();

    expect(state.cleanupWorkspace).toHaveBeenCalledOnce();
    expect(state.cleanupWorkspace).toHaveBeenCalledWith({
      type: "repo",
      cwd: realpathSync(empty),
      repoDir: realpathSync(repo),
      branchName: `ak/${basename(empty)}`,
    });
    expect(state.cleanupWorkspace).not.toHaveBeenCalledWith(expect.objectContaining({ cwd: realpathSync(dirty) }));
    expect(state.cleanupWorkspace).not.toHaveBeenCalledWith(expect.objectContaining({ cwd: realpathSync(committed) }));
    expect(state.cleanupWorkspace).not.toHaveBeenCalledWith(expect.objectContaining({ cwd: realpathSync(unexpected) }));
    expect(state.cleanupWorkspace).not.toHaveBeenCalledWith(expect.objectContaining({ cwd: realpathSync(tracked) }));
  });

  it("cleans a stale worker workspace before removing its local session", async () => {
    const repo = createRepo("repo-stale");
    const cwd = addWorktree(repo, "stale");
    const workspace = { type: "repo" as const, cwd, repoDir: repo, branchName: "ak/stale" };
    state.sessions = [{ type: "worker", sessionId: "session-1", taskId: "task-1", status: "active", workspace }];
    const client = {
      listAgents: vi.fn(async () => [{ id: "agent-1" }]),
      listSessions: vi.fn(async () => [{ id: "session-1", status: "active", machine_id: "machine-1" }]),
      getTask: vi.fn(async () => ({ status: "in_progress" })),
      releaseTask: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => undefined),
    };

    await cleanupStaleSessions(client as any, "machine-1");

    expect(state.cleanupWorkspace).toHaveBeenCalledWith(workspace);
    expect(state.removeSession).toHaveBeenCalledWith("session-1");
    expect(state.cleanupWorkspace.mock.invocationCallOrder[0]).toBeLessThan(state.removeSession.mock.invocationCallOrder[0]);
  });

  it("preserves a missing repo workspace without entering remote or git cleanup paths", async () => {
    const workspace = {
      type: "repo" as const,
      cwd: join(state.root, "worktrees", "missing"),
      repoDir: join(state.root, "attacker-controlled-repo"),
      branchName: "ak/missing;touch-pwned",
    };
    state.sessions = [{ type: "worker", sessionId: "session-1", taskId: "task-1", status: "active", workspace }];
    const client = {
      listAgents: vi.fn(async () => [{ id: "agent-1" }]),
      listSessions: vi.fn(async () => [{ id: "session-1", status: "active", machine_id: "machine-1" }]),
      getTask: vi.fn(async () => ({ status: "in_progress" })),
      releaseTask: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => undefined),
    };

    expect(canSafelyDiscardOrphanWorkspace(workspace)).toBe(false);
    await cleanupStaleSessions(client as any, "machine-1");

    expect(client.getTask).not.toHaveBeenCalled();
    expect(client.releaseTask).not.toHaveBeenCalled();
    expect(client.closeSession).not.toHaveBeenCalled();
    expect(state.cleanupWorkspace).not.toHaveBeenCalled();
    expect(state.removeSession).not.toHaveBeenCalled();
  });

  it.each(["dirty", "committed"])("preserves a stale worker with a %s persisted worktree", async (kind) => {
    const repo = createRepo(`repo-${kind}`);
    const cwd = addWorktree(repo, `persisted-${kind}`);
    writeFileSync(join(cwd, "agent-output.txt"), "valuable output\n");
    if (kind === "committed") {
      git(cwd, "add", "agent-output.txt");
      git(cwd, "commit", "-m", "agent output");
    }
    const workspace = { type: "repo" as const, cwd, repoDir: repo, branchName: `ak/persisted-${kind}` };
    state.sessions = [{ type: "worker", sessionId: "session-1", taskId: "task-1", status: "active", workspace }];
    const client = {
      listAgents: vi.fn(async () => [{ id: "agent-1" }]),
      listSessions: vi.fn(async () => [{ id: "session-1", status: "active", machine_id: "machine-1" }]),
      getTask: vi.fn(async () => ({ status: "in_progress" })),
      releaseTask: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => undefined),
    };

    await cleanupStaleSessions(client as any, "machine-1");

    expect(client.releaseTask).not.toHaveBeenCalled();
    expect(client.closeSession).not.toHaveBeenCalled();
    expect(state.cleanupWorkspace).not.toHaveBeenCalled();
    expect(state.removeSession).not.toHaveBeenCalled();
  });

  it.each(["release", "close"])("retains local session and workspace when stale remote %s fails", async (phase) => {
    const repo = createRepo(`repo-${phase}`);
    const cwd = addWorktree(repo, `failure-${phase}`);
    const workspace = { type: "repo" as const, cwd, repoDir: repo, branchName: `ak/failure-${phase}` };
    state.sessions = [{ type: "worker", sessionId: "session-1", taskId: "task-1", status: "active", workspace }];
    const client = {
      listAgents: vi.fn(async () => [{ id: "agent-1" }]),
      listSessions: vi.fn(async () => [{ id: "session-1", status: "active", machine_id: "machine-1" }]),
      getTask: vi.fn(async () => ({ status: "in_progress" })),
      releaseTask: vi.fn(async () => {
        if (phase === "release") throw new Error("release failed");
      }),
      closeSession: vi.fn(async () => {
        if (phase === "close") throw new Error("close failed");
      }),
    };

    await cleanupStaleSessions(client as any, "machine-1");

    expect(client.releaseTask).toHaveBeenCalledWith("task-1");
    expect(client.closeSession).toHaveBeenCalledTimes(phase === "release" ? 0 : 1);
    expect(state.cleanupWorkspace).not.toHaveBeenCalled();
    expect(state.removeSession).not.toHaveBeenCalled();
  });
});
