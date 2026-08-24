// ─── Board ───

export type BoardType = "dev" | "ops";

export const BOARD_TYPES: readonly BoardType[] = ["dev", "ops"] as const;

export function isBoardType(value: string): value is BoardType {
  return BOARD_TYPES.includes(value as BoardType);
}

export interface Board {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  type: BoardType;
  labels: BoardLabel[];
  visibility: "private" | "public";
  share_slug: string | null;
  created_at: string;
  updated_at: string;
}

export interface BoardWithTasks extends Board {
  tasks: Task[];
}

// ─── Task ───

export type TaskStatus = "todo" | "in_progress" | "in_review" | "done" | "cancelled";

export interface Task {
  id: string;
  board_id: string;
  seq: number;
  status: TaskStatus;
  title: string;
  description: string | null;
  repository_id: string | null;
  labels: string[] | null;
  created_by: string | null;
  assigned_to: string | null;
  pr_url: string | null;
  input: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  created_from: string | null;
  scheduled_at: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  blocked?: boolean;
  repository_name?: string;
  agent_name?: string;
  agent_public_key?: string | null;
  board_type?: BoardType;
}

export interface TaskWithMeta extends Task {
  duration_minutes: number | null;
  subtask_count: number;
  depends_on: string[];
}

export interface TaskWithNotes extends TaskWithMeta {
  notes: TaskAction[];
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

export type ActorType = "user" | "machine" | "agent:worker" | "agent:leader" | "system";

export interface TaskAction {
  id: string;
  task_id: string;
  actor_type: ActorType;
  actor_id: string;
  actor_name?: string | null;
  actor_public_key?: string | null;
  action: TaskActionType;
  detail: string | null;
  session_id: string | null;
  created_at: string;
}

export interface BoardAction extends TaskAction {
  agent_kind?: AgentKind | null;
}

export interface BoardLabel {
  name: string;
  color: string;
  description: string;
}

// ─── Machine ───

export type MachineStatus = "online" | "offline";

export interface UsageWindow {
  runtime: AgentRuntime | null;
  label: string;
  /** Utilized quota percentage, 0-100. */
  utilization: number;
  resets_at: string;
}

export interface UsageInfo {
  windows: UsageWindow[];
  updated_at: string;
}

export type MachineRuntimeStatus = "missing" | "unauthorized" | "unhealthy" | "limited" | "ready";

export interface RuntimeModel {
  id: string;
  name?: string;
  description?: string;
  context_window?: number;
  input_token_limit?: number;
  output_token_limit?: number;
  supports?: Record<string, boolean>;
  supported_reasoning_efforts?: string[];
  default_reasoning_effort?: string;
}

export interface MachineRuntime {
  name: AgentRuntime;
  status: MachineRuntimeStatus;
  detail?: string;
  reset_at?: string;
  models?: RuntimeModel[];
  checked_at: string;
}

export type MachineHosting = "local" | "cloud";

export interface Machine {
  id: string;
  owner_id: string;
  name: string;
  status: MachineStatus;
  hosting: MachineHosting;
  os: string;
  version: string;
  runtimes: MachineRuntime[];
  usage_info: UsageInfo | null;
  last_heartbeat_at: string | null;
  created_at: string;
}

export interface MachineWithAgents extends Machine {
  session_count: number;
  active_session_count: number;
}

// ─── Agent ───

export type AgentKind = "worker" | "leader";
export type AgentRuntime = "claude" | "codex" | "gemini" | "copilot" | "hermes" | "ama";
export type LeaderAgentRuntime =
  | "claude"
  | "codex"
  | "gemini"
  | "copilot"
  | "hermes"
  | "antigravity"
  | "opencode"
  | "cursor"
  | "qwen"
  | "goose"
  | "amp"
  | "kiro"
  | "pi";
export type AnyAgentRuntime = AgentRuntime | LeaderAgentRuntime;
export type AgentTaintEffect = "NoSchedule";

export interface AgentStatus {
  schedulable: boolean;
  tasks: {
    todo: number;
    in_progress: number;
    in_review: number;
    done: number;
    cancelled: number;
  };
}

export interface AgentTaint {
  key: string;
  value?: string | null;
  effect: AgentTaintEffect;
}

export const MAINTAINER_TAINT_KEY = "agent-kanban.dev/maintainer";
export const AMA_BACKFILL_FAILED_TAINT_KEY = "agent-kanban.dev/ama-backfill-failed";

export function hasNoScheduleTaint(taints: AgentTaint[] | null | undefined): boolean {
  return taints?.some((taint) => taint.effect === "NoSchedule") ?? false;
}

const USERNAME_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$|^[a-z0-9]$/;
const AGENT_ROLE_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function isValidUsername(value: string): boolean {
  return USERNAME_RE.test(value);
}

export function isValidAgentRole(value: string): boolean {
  return value.length <= 63 && AGENT_ROLE_RE.test(value);
}

export function deriveUsername(name: string): string {
  const derived = name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return derived || "agent";
}

const SKILL_REF_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[A-Za-z0-9][A-Za-z0-9._/-]{0,127})?@[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;
export function isValidSkillRef(value: string): boolean {
  return SKILL_REF_RE.test(value);
}

export function findInvalidSkillRef(skills: string[] | null | undefined): string | null {
  return skills?.find((skill) => !isValidSkillRef(skill)) ?? null;
}

export const AGENT_RUNTIMES: readonly AgentRuntime[] = ["claude", "codex", "gemini", "copilot", "hermes", "ama"] as const;

export const LEADER_AGENT_RUNTIMES: readonly LeaderAgentRuntime[] = [
  "claude",
  "codex",
  "gemini",
  "copilot",
  "hermes",
  "antigravity",
  "opencode",
  "cursor",
  "qwen",
  "goose",
  "amp",
  "kiro",
  "pi",
] as const;

export const RUNTIME_LABELS: Record<AnyAgentRuntime, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  copilot: "GitHub Copilot",
  hermes: "Hermes",
  ama: "AMA Cloud",
  antigravity: "Antigravity CLI",
  opencode: "OpenCode",
  cursor: "Cursor CLI",
  qwen: "Qwen Code",
  goose: "Goose",
  amp: "Amp",
  kiro: "Kiro CLI",
  pi: "Pi Agent",
};

// Runtimes executed on AMA cloud sandboxes instead of machine-hosted runners.
export const CLOUD_AGENT_RUNTIMES: ReadonlySet<AgentRuntime> = new Set(["ama"]);

export function isCloudAgentRuntime(runtime: AgentRuntime): boolean {
  return CLOUD_AGENT_RUNTIMES.has(runtime);
}

const RUNTIME_ALIASES: Record<string, AgentRuntime> = {
  "claude-code": "claude",
  "codex-cli": "codex",
  "github-copilot": "copilot",
  "copilot-cli": "copilot",
  "hermes-agent": "hermes",
};

export function normalizeRuntime(runtime: string): AgentRuntime {
  return RUNTIME_ALIASES[runtime] ?? (runtime as AgentRuntime);
}

export interface Agent {
  id: string;
  owner_id: string;
  name: string;
  username: string;
  gpg_subkey_id: string | null;
  bio: string | null;
  soul: string | null;
  role: string | null;
  kind: AgentKind;
  handoff_to: string[] | null;
  runtime: AnyAgentRuntime;
  model: string | null;
  reasoning_effort: string | null;
  /** Relay endpoint (relay_endpoints.id) the agent runs through; null = default provider. */
  relay_id: string | null;
  skills: string[] | null;
  subagents: string[] | null;
  taints?: AgentTaint[] | null;
  version: string;
  public_key: string;
  fingerprint: string;
  builtin: number;
  ama_agent_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AgentWithActivity extends Agent {
  email: string;
  status: AgentStatus;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_micro_usd: number;
}

export interface Subagent {
  id: string;
  owner_id: string;
  name: string;
  username: string;
  bio: string | null;
  soul: string | null;
  role: string | null;
  models: Partial<Record<AgentRuntime, string>> | null;
  skills: string[] | null;
  created_at: string;
  updated_at: string;
}

// ─── Agent Session ───

export type AgentSessionStatus = "active" | "closed";

export interface AgentSession {
  id: string;
  agent_id: string;
  machine_id: string;
  status: AgentSessionStatus;
  public_key: string;
  delegation_proof: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_micro_usd: number;
  created_at: string;
  closed_at: string | null;
}

export interface AgentSessionWithMachine extends AgentSession {
  machine_name: string;
  runtime_source?: "machine" | "ama";
}

// ─── Repository ───

// Whether the platform GitHub App can push/PR to a repo, computed on read from
// the installation tables. `app_not_installed` = no installation on the repo's
// account; `not_covered` = installed but the repo isn't in a 'selected' install.
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
  /** `remote` = cloneable URL; `local` = absolute path on the daemon host (fork extension). */
  source_type?: "remote" | "local";
}

export interface GithubAppConfig {
  configured: boolean;
  slug: string | null;
  install_url: string | null;
  // Whether the current owner has at least one active (non-suspended) installation.
  installed: boolean;
  // GitHub account logins the App is installed on for this owner (e.g. ["saltbo"]).
  accounts: string[];
}

// A repo the owner's GitHub App installation can access, offered for import.
export interface InstallableRepo {
  full_name: string;
  name: string;
  clone_url: string;
  private: boolean;
  already_added: boolean;
}

// ─── Agent Events (wire format for relay) ───

// `parent_id` attributes a block to a parent tool_use (e.g. subagent spawned via Task).
// When set, the block belongs to that subtask's internal stream, not the main agent's turn.
export type ContentBlock =
  | { type: "thinking"; text: string; parent_id?: string }
  | { type: "tool_use"; id: string; name: string; input?: Record<string, unknown>; parent_id?: string }
  | { type: "tool_result"; tool_use_id: string; output?: string; error?: boolean; parent_id?: string }
  | { type: "text"; text: string; parent_id?: string };

export type SubtaskStatus = "completed" | "failed" | "stopped";

export type AgentEvent =
  // ── Turn lifecycle ──
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
  // ── Block lifecycle (streaming) ──
  | { type: "block.start"; block: ContentBlock }
  | { type: "block.done"; block: ContentBlock }
  // ── Subtask lifecycle (subagent spawned via Task tool) ──
  // `tool_use_id` links back to the parent Task tool_use on the main agent's turn.
  | { type: "subtask.start"; tool_use_id: string; description?: string; kind?: string }
  | {
      type: "subtask.progress";
      tool_use_id: string;
      summary?: string;
      last_tool?: string;
      tokens?: number;
      duration_ms?: number;
    }
  | {
      type: "subtask.end";
      tool_use_id: string;
      status: SubtaskStatus;
      summary?: string;
      tokens?: number;
      duration_ms?: number;
    }
  // ── Legacy / history ──
  | { type: "message"; blocks: ContentBlock[] }
  | { type: "message.user"; text: string };

// ─── Message ───

export type SenderType = "user" | "agent";

export interface Message {
  id: string;
  task_id: string;
  sender_type: SenderType;
  sender_id: string;
  content: string;
  created_at: string;
}

// ─── API ───

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  repository_id?: string;
  labels?: string[];
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  board_id?: string;
  agent_id?: string;
  depends_on?: string[];
  created_from?: string;
  scheduled_at?: string;
}

export interface AssignTaskInput {
  agent_id: string;
}

export interface CreateAgentInput {
  name?: string;
  username: string;
  bio?: string;
  soul?: string;
  role?: string;
  kind?: AgentKind;
  handoff_to?: string[];
  runtime: AnyAgentRuntime;
  model?: string;
  reasoning_effort?: string | null;
  /** Relay endpoint id; null clears the agent's relay. */
  relay_id?: string | null;
  skills?: string[];
  subagents?: string[];
  taints?: AgentTaint[];
}

export interface CreateSubagentInput {
  name?: string;
  username: string;
  bio?: string;
  soul?: string;
  role?: string;
  models?: Partial<Record<AgentRuntime, string>>;
  skills?: string[];
}

export interface CreateSessionInput {
  session_id: string;
  session_public_key: string;
}

export interface SessionUsageInput {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_micro_usd: number;
}

export interface CreateBoardInput {
  name: string;
  description?: string;
  type: BoardType;
}

export interface CreateRepositoryInput {
  name: string;
  url: string;
}
