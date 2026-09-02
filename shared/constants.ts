export const TASK_STATUSES = ["todo", "in_progress", "in_review", "done", "cancelled"] as const;
export const AGENCY_RUNTIMES = ["ama", "claude-code", "codex", "copilot"] as const;
export const V2_API_VERSION = "2026-08-29";

export const TASK_STATUS_LABELS: Record<string, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  cancelled: "Cancelled",
};
