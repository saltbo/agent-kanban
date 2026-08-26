import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { REPOS_DIR, WORKTREES_DIR } from "../paths.js";

const logger = createLogger("repo");

/** Derive local repo path from URL — deterministic, no link file needed. */
export function repoDir(repoUrl: string): string {
  return join(REPOS_DIR, repoUrl.replace(/^https?:\/\//, ""));
}

/** Ensure repo is cloned locally. Returns the local path, or null on failure. */
export function ensureCloned(repo: { full_name: string; url: string }): string | null {
  const dir = repoDir(repo.url);
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

export function prepareRepo(dir: string): boolean {
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

export function createWorktree(dir: string, sessionId: string): { worktreeDir: string; branchName: string } {
  const branchName = `ak/${sessionId.slice(0, 8)}`;
  mkdirSync(WORKTREES_DIR, { recursive: true });
  const worktreeDir = join(WORKTREES_DIR, sessionId.slice(0, 8));
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
