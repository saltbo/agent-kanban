import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentRuntime } from "@agent-kanban/shared";
import { stringify } from "yaml";
import { createLogger } from "../logger.js";

const logger = createLogger("agents");

const AGENT_GITIGNORE_ENTRIES = [".claude/agents/", ".codex/agents/", ".gemini/agents/"];

export interface SubagentDefinition {
  id: string;
  name: string;
  username: string;
  bio: string | null;
  soul: string | null;
  role: string | null;
  models: Partial<Record<AgentRuntime, string>> | null;
}

function agentName(agent: SubagentDefinition): string {
  return agent.username || agent.id;
}

function descriptionFor(agent: SubagentDefinition): string {
  return agent.bio ?? `${agent.name} specialist`;
}

function promptFor(agent: SubagentDefinition): string {
  const sections = [`You are ${agent.name}.`, agent.bio, agent.role ? `Role: ${agent.role}` : null, agent.soul];
  return sections.filter(Boolean).join("\n\n");
}

function modelForRuntime(runtime: AgentRuntime, agent: SubagentDefinition): string | null {
  return agent.models?.[runtime] ?? null;
}

function markdownModel(runtime: AgentRuntime, agent: SubagentDefinition): string | null {
  return runtime === "claude" ? modelForRuntime(runtime, agent) : null;
}

function renderMarkdownAgent(runtime: AgentRuntime, agent: SubagentDefinition): string {
  const frontmatter: Record<string, string> = {
    name: agentName(agent),
    description: descriptionFor(agent),
  };
  const model = markdownModel(runtime, agent);
  if (model) frontmatter.model = model;
  return `---\n${stringify(frontmatter).trim()}\n---\n${promptFor(agent)}\n`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlBlock(value: string): string {
  return `"""\n${value.replace(/"""/g, '\\"\\"\\"')}\n"""`;
}

function renderCodexAgent(agent: SubagentDefinition): string {
  const lines = [
    `name = ${tomlString(agentName(agent))}`,
    `description = ${tomlString(descriptionFor(agent))}`,
    `developer_instructions = ${tomlBlock(promptFor(agent))}`,
  ];
  const model = modelForRuntime("codex", agent);
  if (model) lines.splice(2, 0, `model = ${tomlString(model)}`);
  return `${lines.join("\n")}\n`;
}

function renderAgent(runtime: AgentRuntime, agent: SubagentDefinition): { path: string; content: string } {
  const name = agentName(agent);
  if (runtime === "claude" || runtime === "copilot") return { path: `.claude/agents/${name}.md`, content: renderMarkdownAgent(runtime, agent) };
  if (runtime === "gemini") return { path: `.gemini/agents/${name}.md`, content: renderMarkdownAgent(runtime, agent) };
  if (runtime === "codex") return { path: `.codex/agents/${name}.toml`, content: renderCodexAgent(agent) };
  throw new Error(`Runtime "${runtime}" does not support task-local subagent installation yet`);
}

function writeAgentFile(repoDir: string, relativePath: string, content: string): boolean {
  const filePath = join(repoDir, relativePath);
  if (existsSync(filePath) && readFileSync(filePath, "utf-8") === content) return false;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf-8");
  return true;
}

function ensureGitignore(repoDir: string): void {
  const gitignorePath = join(repoDir, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
  const missing = AGENT_GITIGNORE_ENTRIES.filter((entry) => !existing.includes(entry));
  if (missing.length > 0) {
    appendFileSync(gitignorePath, `\n# agent definitions (managed by daemon)\n${missing.join("\n")}\n`);
  }
}

export async function ensureSubagents(worktreeDir: string, runtime: AgentRuntime, subagents: SubagentDefinition[]): Promise<boolean> {
  if (subagents.length === 0) return true;

  try {
    let changed = false;
    for (const subagent of subagents) {
      const rendered = renderAgent(runtime, subagent);
      if (writeAgentFile(worktreeDir, rendered.path, rendered.content)) changed = true;
    }
    ensureGitignore(worktreeDir);
    if (changed) logger.info(`Installed ${subagents.length} subagent definition(s) for ${runtime} in ${worktreeDir}`);
    return true;
  } catch (err) {
    logger.error(`Failed to ensure subagents: ${(err as Error).message}`);
    return false;
  }
}

export const testExports = {
  renderMarkdownAgent,
  renderCodexAgent,
};
