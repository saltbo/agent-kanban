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
  version: number;
  board_id: string;
  seq: number;
  status: TaskStatus;
  title: string;
  description: string | null;
  repository_id: string | null;
  labels: string[] | null;
  created_by: string | null;
  assigned_to: string | null;
  assignee_identity_type: "ak_agent" | "realmroot_actor" | null;
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
  assignee_name?: string | null;
  board_type?: BoardType;
  session_binding?: TaskSessionBinding | null;
}

export interface TaskSessionBinding {
  agent_actor_id: string;
  runtime: string;
  runtime_session_id: string;
  bound_at: string;
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

export type ActorType = "user" | "machine" | "service" | "realmroot:agent" | "agent:worker" | "agent:leader" | "system";
export type TaskActionWriteActorType = "user" | "machine" | "service" | "realmroot:agent" | "system";

export interface TaskAction {
  id: string;
  task_id: string;
  actor_type: ActorType;
  actor_id: string;
  actor_name?: string | null;
  action: TaskActionType;
  detail: string | null;
  session_id: string | null;
  created_at: string;
}

export interface BoardAction extends TaskAction {}

export interface BoardLabel {
  name: string;
  color: string;
  description: string;
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
}

export interface MachineSetup {
  command: string;
  project_id: string;
  environment_id: string;
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
  depends_on?: string[];
  created_from?: string;
  scheduled_at?: string;
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
