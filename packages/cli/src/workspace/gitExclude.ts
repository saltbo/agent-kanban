import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Ignore daemon-managed files locally without changing the task's tracked
 * `.gitignore`. Non-git temp workspaces simply do not need git exclusions.
 */
export function ensureGitExclude(workspaceDir: string, entries: string[], comment: string): void {
  let excludeOutput: string;
  try {
    excludeOutput = execFileSync("git", ["-C", workspaceDir, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" }).trim();
  } catch {
    return;
  }
  const excludePath = isAbsolute(excludeOutput) ? excludeOutput : resolve(workspaceDir, excludeOutput);
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  const existingLines = new Set(existing.split(/\r?\n/));
  const missing = entries.filter((entry) => !existingLines.has(entry));
  if (missing.length === 0) return;
  mkdirSync(dirname(excludePath), { recursive: true });
  appendFileSync(excludePath, `\n# ${comment}\n${missing.join("\n")}\n`);
}
