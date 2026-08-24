import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createLogger } from "../logger.js";
import { WORKTREES_DIR } from "../paths.js";
import type { WorkspaceInfo } from "../types.js";
import { createWorktree, removeWorktree } from "./repoOps.js";

const logger = createLogger("workspace");

export type { WorkspaceInfo };

// ---- Direct-mode serialization ----

/**
 * Repo checkouts currently hosting a worktree-disabled task. Direct-mode
 * tasks share the repo's git dir, so only one may run per checkout at a time.
 * The slot is held for the whole session lifecycle (including rate-limit /
 * quota suspension — a suspended direct task's uncommitted work still sits in
 * the checkout) and released in cleanupWorkspace, the choke point every
 * termination path (finish, reap, cancel, resume-then-finish) flows through.
 */
const directRepoDirsInUse = new Set<string>();

export function isDirectRepoDirInUse(repoDir: string): boolean {
  return directRepoDirsInUse.has(repoDir);
}

export function acquireDirectRepoDir(repoDir: string): void {
  directRepoDirsInUse.add(repoDir);
}

// ---- Runtime object ----

export interface Workspace {
  readonly cwd: string;
  readonly info: WorkspaceInfo;
  cleanup(): void;
}

// ---- Create ----

export function createRepoWorkspace(repoDir: string, sessionId: string, worktreeName?: string): Workspace {
  const { worktreeDir, branchName } = createWorktree(repoDir, sessionId, worktreeName);
  const info: WorkspaceInfo = { type: "repo", cwd: worktreeDir, repoDir, branchName };
  return { cwd: worktreeDir, info, cleanup: () => cleanupWorkspace(info) };
}

/** Worktree disabled: run directly in the repo checkout (caller serializes access). */
export function createDirectRepoWorkspace(repoDir: string): Workspace {
  logger.warn(`Worktree disabled — working directly in ${repoDir}`);
  const info: WorkspaceInfo = { type: "direct", cwd: repoDir, repoDir };
  return { cwd: repoDir, info, cleanup: () => cleanupWorkspace(info) };
}

export function createTempWorkspace(sessionId: string): Workspace {
  const cwd = mkdtempSync(join(tmpdir(), `ak-${sessionId.slice(0, 8)}-`));
  logger.info(`Created temp workspace ${cwd}`);
  const info: WorkspaceInfo = { type: "temp", cwd };
  return { cwd, info, cleanup: () => cleanupWorkspace(info) };
}

// ---- Restore from persisted info (crash recovery / resume) ----

export function restoreWorkspace(info: WorkspaceInfo): Workspace {
  return { cwd: info.cwd, info, cleanup: () => cleanupWorkspace(info) };
}

// ---- Cleanup ----

export function cleanupWorkspace(info: WorkspaceInfo): void {
  if (info.type === "repo") {
    removeWorktree(info.repoDir, info.cwd, info.branchName);
    if (existsSync(info.cwd)) throw new Error(`Worktree still exists after cleanup: ${info.cwd}`);
  } else if (info.type === "direct") {
    // Release the per-checkout dispatch slot. The repo checkout itself belongs
    // to the user — nothing to delete.
    directRepoDirsInUse.delete(info.repoDir);
  } else {
    rmSync(info.cwd, { recursive: true, force: true });
    if (existsSync(info.cwd)) throw new Error(`Temp workspace still exists after cleanup: ${info.cwd}`);
    logger.info(`Removed temp workspace ${info.cwd}`);
  }
}

/**
 * A crashed worker workspace is disposable only when doing so cannot discard
 * agent output. Direct mode never deletes the user's checkout. Repository
 * worktrees must be clean and still point at the checkout's current HEAD;
 * temp workspaces are preserved because their files may be the only output.
 */
export function canSafelyDiscardOrphanWorkspace(info: WorkspaceInfo): boolean {
  if (info.type === "direct") return true;
  if (info.type === "temp") return !existsSync(info.cwd);
  // Missing repo cwd cannot prove the stored repo/branch provenance. Preserve
  // the local record rather than passing attacker/corruption-controlled fields
  // to git cleanup.
  if (!existsSync(info.cwd)) return false;
  try {
    const cwd = realpathSync(info.cwd);
    const worktreesRoot = realpathSync(WORKTREES_DIR);
    const topLevel = realpathSync(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
    const branchName = execFileSync("git", ["-C", cwd, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const gitCommonDir = realpathSync(
      execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim(),
    );
    if (
      dirname(cwd) !== worktreesRoot ||
      topLevel !== cwd ||
      realpathSync(dirname(gitCommonDir)) !== realpathSync(info.repoDir) ||
      branchName !== info.branchName ||
      branchName !== `ak/${basename(cwd)}`
    ) {
      return false;
    }
    const status = execFileSync("git", ["-C", info.cwd, "status", "--porcelain"], { encoding: "utf8" }).trim();
    const worktreeHead = execFileSync("git", ["-C", info.cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const repoHead = execFileSync("git", ["-C", info.repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    return status.length === 0 && worktreeHead === repoHead;
  } catch {
    return false;
  }
}
