export type AgentRuntime = "claude" | "codex" | "gemini" | "copilot" | "hermes" | "ama";
export type AnyAgentRuntime = AgentRuntime | "antigravity" | "opencode" | "cursor" | "qwen" | "goose" | "amp" | "kiro" | "pi";

export const AGENT_RUNTIMES: AgentRuntime[] = ["claude", "codex", "copilot", "ama"];
export const RUNTIME_LABELS: Record<AnyAgentRuntime, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  copilot: "GitHub Copilot",
  hermes: "Hermes",
  ama: "AMA",
  antigravity: "Antigravity",
  opencode: "OpenCode",
  cursor: "Cursor",
  qwen: "Qwen Code",
  goose: "Goose",
  amp: "Amp",
  kiro: "Kiro",
  pi: "Pi",
};

export interface AgentWithActivity {
  id: string;
  owner_id: string;
  name: string;
  username: string;
  bio: string | null;
  soul: string | null;
  runtime: AnyAgentRuntime;
  model: string | null;
  skills: string[] | null;
  version: string;
  identity_key: string;
  identity: { issuer?: string; subject?: string } | null;
  ama_agent_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  email: string;
  status: { ready: boolean; phase?: string };
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_micro_usd: number;
}

export interface UsageWindow {
  runtime: AgentRuntime | null;
  label: string;
  utilization: number;
  resets_at: string;
}
export interface MachineRuntime {
  name: AgentRuntime;
  status: "missing" | "unauthorized" | "unhealthy" | "limited" | "ready";
  detail?: string;
  reset_at?: string;
  checked_at: string;
}

export interface BoardLabel {
  name: string;
  color: string;
  description: string;
}
export type TaskActionType =
  | "created"
  | "claimed"
  | "moved"
  | "commented"
  | "completed"
  | "assigned"
  | "released"
  | "timed_out"
  | "cancelled"
  | "rejected"
  | "review_requested"
  | "dispatched"
  | "dispatch_failed";
export interface BoardAction {
  id: string;
  task_id: string;
  actor_type: string;
  actor_id: string;
  actor_name?: string | null;
  actor_public_key?: string | null;
  action: TaskActionType;
  detail: string | null;
  session_id: string | null;
  created_at: string;
}

export type RepoAppStatus = "covered" | "not_covered" | "suspended" | "app_not_installed";
export interface Repository {
  id: string;
  owner_id: string;
  name: string;
  url: string;
  created_at: string;
  task_count?: number;
  full_name: string;
  app_status?: RepoAppStatus;
}
export interface GithubAppConfig {
  configured: boolean;
  slug: string | null;
  install_url: string | null;
  installed: boolean;
  accounts: string[];
}
export interface InstallableRepo {
  full_name: string;
  name: string;
  clone_url: string;
  private: boolean;
  already_added: boolean;
}
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
  return [];
}
export async function fetchTemplate(_slug: string): Promise<AgentTemplate> {
  throw new Error("Remote Agent templates are not available in AK v2.");
}
export function findInvalidSkillRef(skills: string[]): string | undefined {
  return skills.find((skill) => !/^[^\s/@]+\/[^\s/@]+@[^\s/@]+$/.test(skill));
}

export const AK_ANNOTATION_KEY_SOURCE_EVENT = "agent-kanban.io/source-event";
export const AK_ANNOTATION_KEY_SOURCE_URL = "agent-kanban.io/source-url";
export const AK_LABEL_KEY_GITHUB_SUBJECT = "agent-kanban.io/github-subject";

export type ContentBlock =
  | { type: "thinking"; text: string; parent_id?: string }
  | { type: "tool_use"; id: string; name: string; input?: Record<string, unknown>; parent_id?: string }
  | { type: "tool_result"; tool_use_id: string; output?: string; error?: boolean; parent_id?: string }
  | { type: "text"; text: string; parent_id?: string };
export type AgentEvent =
  | { type: "turn.start" }
  | { type: "turn.end"; text?: string; cost?: number; usage?: Record<string, number | undefined> }
  | { type: "turn.error"; code?: string; detail: string }
  | {
      type: "turn.rate_limit";
      status: "rejected" | "allowed";
      resetAt?: string;
      rateLimitType?: string;
      isUsingOverage?: boolean;
      overage?: { status: "allowed" | "rejected"; resetAt?: string };
    }
  | { type: "block.start" | "block.done"; block: ContentBlock }
  | { type: "subtask.start"; tool_use_id: string; description?: string; kind?: string }
  | { type: "subtask.progress"; tool_use_id: string; summary?: string; last_tool?: string; tokens?: number; duration_ms?: number }
  | { type: "subtask.end"; tool_use_id: string; status: "completed" | "failed" | "stopped"; summary?: string; tokens?: number; duration_ms?: number }
  | { type: "message"; blocks: ContentBlock[] }
  | { type: "message.user"; text: string };

export type BashArgs = { command: string; description?: string; timeout?: number };
export type ReadArgs = { filePath: string; offset?: number; limit?: number };
export type EditArgs = { filePath: string; oldString: string; newString: string; replaceAll?: boolean };
export type MultiEditArgs = { filePath: string; edits: EditArgs[] };
export type WriteArgs = { filePath: string; content: string };
export type GrepArgs = { pattern: string; path?: string; glob?: string; type?: string; outputMode?: string };
export type GlobArgs = { pattern: string; path?: string };
export type TaskArgs = { description: string; prompt: string; subagentType?: string };
export type TodoArgs = { todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> };
export type WebFetchArgs = { url: string; prompt: string };
export type WebSearchArgs = { query: string };
export type WebSearchResultItem = { title?: string; url?: string; snippet?: string };
export type WebSearchResult = WebSearchResultItem[] | string;
export type AskUserQuestionArgs = {
  questions: Array<{ header?: string; question: string; multiSelect?: boolean; options?: Array<{ label?: string; description?: string }> }>;
};
export type ExitPlanModeArgs = { plan: string };
export type SlashCommandArgs = { command: string };
export type NotebookEditArgs = {
  notebookPath: string;
  cellId?: string;
  cellType?: "code" | "markdown";
  editMode?: "replace" | "insert" | "delete";
  newSource: string;
};
export const ToolName = {
  Bash: "Bash",
  Read: "Read",
  Edit: "Edit",
  MultiEdit: "MultiEdit",
  Write: "Write",
  Grep: "Grep",
  Glob: "Glob",
  Agent: "Agent",
  TodoWrite: "TodoWrite",
  WebFetch: "WebFetch",
  WebSearch: "WebSearch",
  AskUserQuestion: "AskUserQuestion",
  ExitPlanMode: "ExitPlanMode",
  SlashCommand: "SlashCommand",
  NotebookEdit: "NotebookEdit",
} as const;
export type ToolName = (typeof ToolName)[keyof typeof ToolName];
