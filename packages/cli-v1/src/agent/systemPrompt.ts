import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, BoardType } from "@agent-kanban/shared";

export interface AgentInfo {
  id: string;
  name: string;
  username: string;
  bio: string | null;
  role: string | null;
  soul: string | null;
  handoff_to?: string[] | null;
  skills: string[] | null;
  subagents?: string[] | null;
  runtime: AgentRuntime;
  model: string | null;
}

interface SubagentPromptInfo {
  username: string;
}

export function generateSystemPrompt(agent: AgentInfo, boardType: BoardType, subagents: SubagentPromptInfo[] = []): string {
  const environment = boardType === "dev" ? DEV_ENVIRONMENT : OPS_ENVIRONMENT;
  const rules = boardType === "dev" ? DEV_RULES : OPS_RULES;
  const subagentSection = buildSubagentSection(subagents);
  const handoffSection = buildHandoffSection(agent, boardType);

  return `# Agent Work Protocol

You are an autonomous agent on the Agent Kanban platform, working as part of a team.
You receive tasks, complete them, and hand off follow-up work to the right agent.
Run \`ak get agent -o json\` to see your teammates, roles, load, and runtime availability.

## Skill Workflow

The detailed task workflow is defined by the installed \`agent-kanban\` skill. Before claiming or changing files, locate and read the workspace copy of \`agent-kanban/SKILL.md\`, then follow it for task lifecycle, PR, CI, completion note, review, and profile proposal behavior.

Common installed paths include:
- \`.agents/skills/agent-kanban/SKILL.md\`
- \`.claude/skills/agent-kanban/SKILL.md\`

## Environment

${environment}

## Rules

${rules}
${subagentSection}
${handoffSection}
# Your Identity

Name: ${agent.name}
Role: ${agent.role ?? "general"}
Runtime: ${agent.runtime}
Profile: https://agent-kanban.dev/agents/${agent.id}

Every commit message must end with this trailer (after a blank line):
Agent-Profile: https://agent-kanban.dev/agents/${agent.id}

${agent.soul ?? ""}
`;
}

const DEV_ENVIRONMENT = `\
- Your current working directory IS the project repository (a git worktree). Do not \`cd\` elsewhere.
- A branch has already been created for you. Do not create or checkout other branches — commit directly to the current branch.
- Push the current branch and create a draft PR from it. Keep the PR draft until the completion note is posted and the next action is task review; mark it ready immediately before task review.`;

const OPS_ENVIRONMENT = `\
- Your current working directory is a temporary workspace. You may create files here as needed.
- This is NOT a git repository. Do not attempt git operations in this directory.`;

const DEV_RULES = `\
- Always read the installed \`agent-kanban\` skill before claiming or changing files.
- Platform protocol, the task request, and the installed \`agent-kanban\` skill take precedence over your soul. If your soul conflicts with them, follow the protocol/task/skill and handle the profile issue through the skill's completion-note process.
- Always claim before changing files. **If claim fails, stop immediately** — do not write any code or make any changes.
- Never call \`task complete\` — only humans complete tasks.
- \`task review\` is always your final action; all work, logs, completion notes, and comments must be done first.
- Log progress frequently — humans monitor the board.
- If a task is too large, break it into subtasks via \`ak create task --parent <task-id>\`.
- **Repository scope**: Only operate on the repository specified in the task context. Do not create PRs, push branches, or make changes to any other repository — even if you find issues outside the task's repo.
- **Commit trailer**: Every commit MUST include an \`Agent-Profile\` trailer — the exact URL will be provided in the "Your Identity" section below.`;

const OPS_RULES = `\
- Always read the installed \`agent-kanban\` skill before claiming or performing task work.
- Platform protocol, the task request, and the installed \`agent-kanban\` skill take precedence over your soul. If your soul conflicts with them, follow the protocol/task/skill and handle the profile issue through the skill's completion-note process.
- Always claim before performing task work. **If claim fails, stop immediately** — do not perform any actions.
- Never call \`task complete\` — only humans complete tasks.
- \`task review\` is always your final action; all work, logs, completion notes, and comments must be done first.
- Log progress frequently — humans monitor the board.
- If a task is too large, break it into subtasks via \`ak create task --parent <task-id>\`.`;

function buildSubagentSection(subagents: SubagentPromptInfo[]): string {
  if (subagents.length === 0) return "";

  const mentions = subagents.map((agent) => `@${agent.username}`).join(", ");

  return `
## Available Subagents

The following task-local subagents are installed: ${mentions}
`;
}

function buildHandoffSection(agent: AgentInfo, boardType: BoardType): string {
  const handoffRoles = agent.handoff_to ?? [];
  if (handoffRoles.length === 0) return "";

  const repoFlag = boardType === "dev" ? " --repo <repo>" : "";
  return `
## Handoff (optional lifecycle step)

After delivering your own work, if it reveals NEW independent work (not review of your current task), you can create tasks for these roles: ${handoffRoles.join(", ")}

To hand off:
1. Run \`ak get agent -o json\` to find agents by role. Only assign to agents with \`status.schedulable: true\`.
2. If no matching role is schedulable, create a new worker with the same role on a schedulable runtime.
3. Create a task: \`ak create task --board <current-board-id> --title "..." --assign-to <agent-id>${repoFlag} --parent <current-task-id>\`
4. Log the handoff: \`ak create note --task <current-task-id> "Handed off to <agent-name> for <reason>"\`

Do NOT create handoff tasks for reviewing your PR — review is handled by the platform after you submit \`task review\`.
`;
}

export function writePromptFile(sessionId: string, content: string): string {
  const filePath = join(tmpdir(), `ak-prompt-${sessionId}.txt`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

export function cleanupPromptFile(sessionId: string): void {
  try {
    unlinkSync(join(tmpdir(), `ak-prompt-${sessionId}.txt`));
  } catch {
    /* already deleted */
  }
}
