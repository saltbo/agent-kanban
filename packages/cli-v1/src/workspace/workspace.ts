import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import type { WorkspaceInfo } from "../types.js";
import { createWorktree, removeWorktree } from "./repoOps.js";

const logger = createLogger("workspace");

export type { WorkspaceInfo };

// ---- Runtime object ----

export interface Workspace {
  readonly cwd: string;
  readonly info: WorkspaceInfo;
  cleanup(): void;
}

// ---- Create ----

export function createRepoWorkspace(repoDir: string, sessionId: string): Workspace {
  const { worktreeDir, branchName } = createWorktree(repoDir, sessionId);
  const info: WorkspaceInfo = { type: "repo", cwd: worktreeDir, repoDir, branchName };
  return { cwd: worktreeDir, info, cleanup: () => cleanupWorkspace(info) };
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
  } else {
    rmSync(info.cwd, { recursive: true, force: true });
    logger.info(`Removed temp workspace ${info.cwd}`);
  }
}
