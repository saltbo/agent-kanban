export const TASK_STATUSES = ["todo", "in_progress", "in_review", "done", "cancelled"] as const;

export const TASK_STATUS_LABELS: Record<string, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  cancelled: "Cancelled",
};

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export const TASK_ACTIONS = [
  "created",
  "claimed",
  "moved",
  "commented",
  "completed",
  "assigned",
  "released",
  "timed_out",
  "cancelled",
  "rejected",
  "review_requested",
  "dispatched",
  "dispatch_failed",
] as const;

export const AGENT_STATUSES = ["online", "offline"] as const;

export const MACHINE_STATUSES = ["online", "offline"] as const;

export const STALE_TIMEOUT_MS = 86400000; // 24 hours (task stale)

export const MACHINE_HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds

export const MACHINE_STALE_TIMEOUT_MS = 60000; // 60 seconds (miss 2 heartbeats)

export const MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS = 86400; // 24 hours

export const MAINTAINER_HEARTBEAT_MIN_INTERVAL_SECONDS = 3600; // 1 hour
export const MAINTAINER_SESSION_IDLE_TIMEOUT_SECONDS = 900; // 15 minutes

export const AK_ANNOTATION_KEY_SOURCE_EVENT = "agent-kanban.dev/source-event";
export const AK_ANNOTATION_KEY_SOURCE_URL = "agent-kanban.dev/source-url";
export const AK_LABEL_KEY_GITHUB_SUBJECT = "agent-kanban.dev/session-key";
export const AMA_ANNOTATION_KEY_IDLE_TIMEOUT_SECONDS = "ama.dev/idle-timeout-seconds";

export const SENDER_TYPES = ["user", "agent"] as const;
