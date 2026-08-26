import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";

const logger = createLogger("skills");

const SKILL_SOURCE = process.env.AK_AGENT_KANBAN_SKILL_SOURCE || "saltbo/agent-kanban";
const SKILL_NAME = "agent-kanban";
const SKILL_GITIGNORE_ENTRIES = [".claude/skills/", ".agents/", "skills-lock.json"];

function installSkill(repoDir: string, source: string, skill: string): boolean {
  const skillFile = join(repoDir, `.claude/skills/${skill}/SKILL.md`);
  if (existsSync(skillFile)) return false;

  logger.info(`Installing skill "${skill}" from ${source} in ${repoDir}`);
  try {
    execSync(`npx skills add ${source} --skill ${skill} --agent claude-code --agent universal -y`, {
      cwd: repoDir,
      stdio: "pipe",
    });
  } catch (err: any) {
    const stderr = err.stderr?.toString() || err.message;
    logger.warn(`Failed to install skill "${skill}" from ${source}: ${stderr}`);
    return false;
  }
  return true;
}

export function ensureSkills(worktreeDir: string, agentSkills: string[]): boolean {
  try {
    let changed = installSkill(worktreeDir, SKILL_SOURCE, SKILL_NAME);

    for (const entry of agentSkills) {
      const atIdx = entry.indexOf("@");
      if (atIdx === -1) {
        logger.warn(`Skipping invalid skill entry (missing @): ${entry}`);
        continue;
      }
      const installed = installSkill(worktreeDir, entry.slice(0, atIdx), entry.slice(atIdx + 1));
      if (installed) changed = true;
    }

    if (!changed) {
      const result = execSync("npx skills update", { cwd: worktreeDir, stdio: "pipe" }).toString();
      if (!result.includes("up to date")) logger.info(`Skills updated in ${worktreeDir}`);
    }

    const gitignorePath = join(worktreeDir, ".gitignore");
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
    const missing = SKILL_GITIGNORE_ENTRIES.filter((e) => !existing.includes(e));
    if (missing.length > 0) {
      appendFileSync(gitignorePath, `\n# agent skills (managed by daemon)\n${missing.join("\n")}\n`);
    }

    return true;
  } catch (err: any) {
    logger.error(`Failed to ensure skills: ${err.message}`);
    return false;
  }
}
