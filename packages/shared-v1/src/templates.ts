import { parse } from "yaml";
import type { AgentRuntime } from "./types.js";
import { normalizeRuntime } from "./types.js";

const TEMPLATES_BASE = "https://raw.githubusercontent.com/saltbo/agent-kanban/main/agents";

export interface AgentTemplate {
  name: string;
  username?: string;
  bio?: string;
  soul?: string;
  role?: string;
  handoff_to?: string[];
  runtime?: AgentRuntime;
  model?: string;
  skills?: string[];
}

export interface TemplateIndex {
  slug: string;
  name: string;
}

export async function fetchTemplateIndex(): Promise<TemplateIndex[]> {
  const res = await fetch(`${TEMPLATES_BASE}/index.json`);
  if (!res.ok) return [];
  return res.json();
}

export const BUILTIN_TEMPLATES: AgentTemplate[] = [
  {
    name: "Quality Goalkeeper",
    username: "quality-goalkeeper",
    bio: "Establishes quality standards, configures quality gates, reviews quality reports",
    soul: [
      "I am the quality goalkeeper. I own the engineering quality bar for the project.",
      "",
      "My responsibilities:",
      "1. I analyze the project's tech stack and determine what quality checks it needs",
      "   (linting, formatting, type checking, testing, etc.)",
      "2. Before configuring any tool, I sample existing code to detect the current style:",
      "   quote style, indent style, line width, trailing commas, semicolons, etc.",
      "   I configure tools to match the existing style, never impose a different one.",
      "3. I install and configure missing quality tools",
      "4. I set up lefthook with pre-commit hooks that enforce standards on staged files",
      "5. I run full-codebase scans and create follow-up tasks for existing violations",
      "6. I review quality reports and verify that standards are met before release",
      "",
      "I do not write features. I ensure that every feature meets the quality bar.",
      "When I find violations, I create specific tasks with clear reproduction steps.",
    ].join("\n"),
    role: "quality-goalkeeper",
    handoff_to: ["enduser"],
    runtime: "claude",
    model: "claude-opus-4-6",
    skills: ["trailofbits/skills@differential-review", "obra/superpowers@verification-before-completion"],
  },
];

export const RESERVED_ROLES = new Set(BUILTIN_TEMPLATES.map((t) => t.role!));

export async function fetchTemplate(slug: string): Promise<AgentTemplate> {
  const url = `${TEMPLATES_BASE}/${slug}.yaml`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Template "${slug}" not found (${res.status})`);
  }
  const template = parse(await res.text()) as AgentTemplate;
  if (template.runtime) {
    template.runtime = normalizeRuntime(template.runtime);
  }
  return template;
}
