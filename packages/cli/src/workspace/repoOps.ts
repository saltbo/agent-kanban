import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { REPOS_DIR, WORKTREES_DIR } from "../paths.js";

const logger = createLogger("repo");

/** Fork extension: local repositories are absolute paths, used in place. */
export function isLocalRepoUrl(repoUrl: string): boolean {
  return repoUrl.startsWith("/");
}

/** Derive local repo path from URL — deterministic, no link file needed. */
export function repoDir(repoUrl: string): string {
  // Local repositories are worktreed directly off the user's checkout.
  if (isLocalRepoUrl(repoUrl)) return repoUrl;
  return join(REPOS_DIR, repoUrl.replace(/^https?:\/\//, ""));
}

/** Ensure repo is cloned locally. Returns the local path, or null on failure. */
export function ensureCloned(repo: { full_name: string; url: string }): string | null {
  const dir = repoDir(repo.url);

  // Local repo: nothing to clone — verify the path is a git work tree.
  if (isLocalRepoUrl(repo.url)) {
    try {
      execSync("git rev-parse --is-inside-work-tree", { cwd: dir, stdio: "pipe" });
      return dir;
    } catch {
      logger.error(`Local repository ${dir} does not exist or is not a git work tree`);
      return null;
    }
  }

  if (existsSync(dir)) return dir;

  logger.info(`Cloning ${repo.full_name} → ${dir}`);
  try {
    execSync(`gh repo clone ${repo.full_name} ${dir}`, { stdio: "pipe" });
    return dir;
  } catch (err: any) {
    logger.error(`Clone failed for ${repo.full_name}: ${err.message}`);
    return null;
  }
}

export function prepareRepo(dir: string, opts?: { local?: boolean }): boolean {
  // Never stash or pull the user's own working tree of a local repository —
  // `git worktree add` branches from HEAD without touching it.
  if (opts?.local) return true;
  try {
    const status = execSync("git status --porcelain", { cwd: dir, stdio: "pipe" }).toString().trim();
    if (status) {
      logger.info(`Stashing dirty working tree in ${dir}`);
      execSync("git stash --include-untracked", { cwd: dir, stdio: "pipe" });
    }

    logger.info(`Pulling latest code in ${dir}`);
    execSync("git pull --ff-only", { cwd: dir, stdio: "pipe" });
    return true;
  } catch (err: any) {
    logger.error(`Failed to prepare repo ${dir}: ${err.message}`);
    return false;
  }
}

/**
 * Re-sync a remote checkout for a worktree-disabled (direct) task. The
 * dispatcher guarantees no direct task is mid-run on this checkout, but the
 * previous one may have left it dirty or on a stale branch — reset to a clean
 * default-branch tip. Never used for local repos (the user's tree is sacred).
 */
export function prepareDirectRepo(dir: string): boolean {
  try {
    const status = execSync("git status --porcelain", { cwd: dir, stdio: "pipe" }).toString().trim();
    if (status) {
      logger.info(`Stashing dirty working tree in ${dir}`);
      execSync("git stash --include-untracked", { cwd: dir, stdio: "pipe" });
    }
    const originHead = execSync("git symbolic-ref --short refs/remotes/origin/HEAD", { cwd: dir, stdio: "pipe" }).toString().trim();
    const defaultBranch = originHead.replace(/^origin\//, "") || "main";
    execSync(`git checkout ${defaultBranch}`, { cwd: dir, stdio: "pipe" });
    execSync("git pull --ff-only", { cwd: dir, stdio: "pipe" });
    return true;
  } catch (err: any) {
    logger.error(`Failed to prepare direct repo ${dir}: ${err.message}`);
    return false;
  }
}

function branchExists(dir: string, branchName: string): boolean {
  try {
    execSync(`git show-ref --verify "refs/heads/${branchName}"`, { cwd: dir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function createWorktree(dir: string, sessionId: string, name?: string): { worktreeDir: string; branchName: string } {
  const baseSlug = name ?? sessionId.slice(0, 8);
  let slug = baseSlug;
  let branchName = `ak/${slug}`;
  let worktreeDir = join(WORKTREES_DIR, slug);
  // A custom name can collide with another session's worktree/branch (same or
  // different repo) — fall back to a session-suffixed variant.
  if (existsSync(worktreeDir) || branchExists(dir, branchName)) {
    slug = `${baseSlug}-${sessionId.slice(0, 4)}`;
    branchName = `ak/${slug}`;
    worktreeDir = join(WORKTREES_DIR, slug);
    logger.warn(`Worktree name "${baseSlug}" already in use, falling back to "${slug}"`);
    if (existsSync(worktreeDir) || branchExists(dir, branchName)) {
      throw new Error(`Worktree slug "${slug}" still collides after session suffix — refusing to guess further`);
    }
  }
  mkdirSync(WORKTREES_DIR, { recursive: true });
  execSync(`git worktree add "${worktreeDir}" -b "${branchName}"`, { cwd: dir, stdio: "pipe" });
  logger.info(`Created worktree ${worktreeDir} (branch ${branchName})`);
  return { worktreeDir, branchName };
}

export function removeWorktree(dir: string, worktreeDir: string, branchName: string): void {
  try {
    execSync(`git worktree remove "${worktreeDir}" --force`, { cwd: dir, stdio: "pipe" });
    execSync(`git branch -D "${branchName}"`, { cwd: dir, stdio: "pipe" });
    logger.info(`Removed worktree ${worktreeDir}`);
  } catch (err: any) {
    logger.warn(`Failed to remove worktree ${worktreeDir}: ${err.message}`);
  }
}
