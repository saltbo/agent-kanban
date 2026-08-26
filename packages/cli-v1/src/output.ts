import { Option } from "commander";
import { stringify } from "yaml";

const OUTPUT_FORMATS = ["text", "json", "yaml", "wide"] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export function outputOption(): Option {
  return new Option("-o, --output <format>", `Output format (${OUTPUT_FORMATS.join(", ")})`).choices([...OUTPUT_FORMATS]);
}

export function getOutputFormat(explicit?: string): OutputFormat {
  if (explicit === undefined) return "text";
  if (OUTPUT_FORMATS.includes(explicit as OutputFormat)) return explicit as OutputFormat;
  throw new Error(`Invalid output format: ${explicit}`);
}

function toYamlOutput(data: unknown, kind?: string): string {
  if (!kind) return stringify(data);
  if (Array.isArray(data)) {
    return data.map((item) => `---\n${stringify({ kind, spec: item })}`).join("");
  }
  return stringify({ kind, spec: data });
}

export function output(
  data: unknown,
  format: OutputFormat,
  textFormatter?: (data: any) => string,
  options?: { wideFormatter?: (data: any) => string; kind?: string },
): void {
  switch (format) {
    case "json":
      console.log(JSON.stringify(data, null, 2));
      break;
    case "yaml":
      console.log(toYamlOutput(data, options?.kind));
      break;
    case "wide": {
      const fn = options?.wideFormatter ?? textFormatter;
      console.log(fn ? fn(data) : JSON.stringify(data, null, 2));
      break;
    }
    default:
      console.log(textFormatter ? textFormatter(data) : JSON.stringify(data, null, 2));
  }
}

export function formatTaskList(tasks: any[]): string {
  if (tasks.length === 0) return "No tasks found.";

  const lines = tasks.map((t) => {
    const status = `[${t.status}]`.padEnd(14);
    const blocked = t.blocked ? " BLOCKED" : "";
    const labels = t.labels?.length ? `[${t.labels.join(",")}]` : "";
    const repo = t.repository_name ? `(${t.repository_name})` : "";
    const agent = t.assigned_to ? `→ ${t.assigned_to.slice(0, 8)}` : "";
    const pr = t.pr_url ? `PR: ${t.pr_url}` : "";
    return `  ${t.id}  ${status} ${labels} ${t.title} ${blocked} ${repo} ${agent} ${pr}`.trimEnd();
  });

  return lines.join("\n");
}

export function formatTaskListWide(tasks: any[]): string {
  if (tasks.length === 0) return "No tasks found.";

  const lines = tasks.map((t) => {
    const status = `[${t.status}]`.padEnd(14);
    const blocked = t.blocked ? " BLOCKED" : "";
    const labels = t.labels?.length ? `[${t.labels.join(",")}]` : "";
    const repo = t.repository_name ? t.repository_name.padEnd(20) : "".padEnd(20);
    const agent = t.assigned_to ? t.assigned_to.slice(0, 12).padEnd(14) : "".padEnd(14);
    const created = t.created_at ? new Date(t.created_at).toISOString().slice(0, 10) : "";
    const pr = t.pr_url ? `PR: ${t.pr_url}` : "";
    return `  ${t.id}  ${status} ${labels} ${t.title} ${blocked} ${repo} ${agent} ${created} ${pr}`.trimEnd();
  });

  return lines.join("\n");
}

export function formatAgentList(agents: any[]): string {
  if (agents.length === 0) return "No agents found.";

  const lines = agents.map((a) => {
    const status =
      typeof a.status === "object" && a.status
        ? `[${a.status.schedulable ? "schedulable" : "unschedulable"}]`.padEnd(16)
        : `[${a.status}]`.padEnd(16);
    const role = a.role ? `(${a.role})` : "";
    const runtime = a.runtime ?? "";
    const tasks = typeof a.status === "object" && a.status ? a.status.tasks : null;
    const load = tasks
      ? ` todo=${tasks.todo} progress=${tasks.in_progress} review=${tasks.in_review} done=${tasks.done} cancelled=${tasks.cancelled}`
      : "";
    const bio = a.bio ? ` — ${a.bio}` : "";
    return `  ${a.id}  ${status} ${a.name} ${role} ${runtime}${load}${bio}`.trimEnd();
  });

  return lines.join("\n");
}

function formatSubagentModels(models: Record<string, string> | null | undefined): string {
  if (!models || Object.keys(models).length === 0) return "";
  return Object.entries(models)
    .map(([runtime, model]) => `${runtime}=${model}`)
    .join(", ");
}

export function formatSubagentList(subagents: any[]): string {
  if (subagents.length === 0) return "No subagents found.";

  const lines = subagents.map((agent) => {
    const role = agent.role ? `(${agent.role})` : "";
    const models = formatSubagentModels(agent.models);
    const modelText = models ? ` models=${models}` : "";
    const bio = agent.bio ? ` — ${agent.bio}` : "";
    return `  ${agent.id}  ${agent.name} ${role}${modelText}${bio}`.trimEnd();
  });

  return lines.join("\n");
}

export function formatModelList(models: any[]): string {
  if (models.length === 0) return "No models found.";

  return models
    .map((model) => {
      const name = model.name && model.name !== model.id ? `  ${model.name}` : "";
      const efforts = model.supported_reasoning_efforts?.length ? ` efforts=${model.supported_reasoning_efforts.join(",")}` : "";
      const context = model.context_window ? ` context=${model.context_window}` : "";
      return `  ${model.id}${name}${context}${efforts}`;
    })
    .join("\n");
}

export function formatBoardList(boards: any[]): string {
  if (boards.length === 0) return "No boards found.";

  const lines = boards.map((b) => {
    const desc = b.description ? ` — ${b.description}` : "";
    return `  ${b.id}  ${b.name}${desc}`;
  });

  return lines.join("\n");
}

export function formatLabelList(labels: any[]): string {
  if (labels.length === 0) return "No labels found.";

  return labels
    .map((label) => {
      const description = label.description ? ` — ${label.description}` : "";
      return `  ${label.name}  ${label.color}${description}`;
    })
    .join("\n");
}

export function formatMaintainer(maintainer: any): string {
  const lines: string[] = [];
  lines.push(`Maintainer ${maintainer.id}`);
  lines.push(`  ID:           ${maintainer.id}`);
  lines.push(`  Board:        ${maintainer.board_id}`);
  lines.push(`  Agent:        ${maintainer.agent_id ?? "unbound"}`);
  lines.push(`  Status:       ${maintainer.status}`);
  lines.push(`  Heartbeat:    ${maintainer.heartbeat_enabled === false ? "disabled" : "enabled"}`);
  lines.push(`  Interval:     ${maintainer.interval_seconds}s`);
  if (maintainer.last_run_at) lines.push(`  Last run:     ${maintainer.last_run_at}`);
  if (maintainer.latest_run?.status) lines.push(`  Last status:  ${maintainer.latest_run.status}`);
  if (maintainer.latest_run?.session_id) lines.push(`  Last session: ${maintainer.latest_run.session_id}`);
  if (maintainer.last_error_message) lines.push(`  Last error:   ${maintainer.last_error_message}`);
  return lines.join("\n");
}

export function formatMaintainerList(maintainers: any[]): string {
  if (maintainers.length === 0) return "No maintainers found.";
  return maintainers
    .map((maintainer) => {
      const lastRun = maintainer.last_run_at ? ` last=${maintainer.last_run_at}` : "";
      const heartbeat = maintainer.heartbeat_enabled === false ? "disabled" : "enabled";
      return `  ${maintainer.id}  [${maintainer.status}] agent=${maintainer.agent_id ?? "unbound"} heartbeat=${heartbeat} interval=${maintainer.interval_seconds}s${lastRun}`;
    })
    .join("\n");
}

export function formatRepository(repo: any): string {
  const lines: string[] = [];
  lines.push(`${repo.name}`);
  lines.push(`  ID:   ${repo.id}`);
  lines.push(`  URL:  ${repo.url}`);
  if (repo.created_at) lines.push(`  Created: ${repo.created_at}`);
  return lines.join("\n");
}

export function formatRepositoryList(repos: any[]): string {
  if (repos.length === 0) return "No repositories found.";

  const lines = repos.map((r) => {
    return `  ${r.id}  ${r.name}  ${r.url}`;
  });

  return lines.join("\n");
}

export function formatTask(task: any): string {
  const lines: string[] = [];
  lines.push(`${task.title}`);
  lines.push(`  ID:          ${task.id}`);
  lines.push(`  Status:      ${task.status}${task.blocked ? " (BLOCKED)" : ""}`);
  if (task.labels?.length) lines.push(`  Labels:      ${task.labels.join(", ")}`);
  if (task.assigned_to) lines.push(`  Assigned to: ${task.assigned_to}`);
  if (task.repository_name) lines.push(`  Repository:  ${task.repository_name}`);
  if (task.depends_on?.length) lines.push(`  Depends on:  ${task.depends_on.join(", ")}`);
  if (task.pr_url) lines.push(`  PR:          ${task.pr_url}`);
  if (task.description) lines.push(`\n  ${task.description}`);
  if (task.input) lines.push(`\n  Input: ${JSON.stringify(task.input)}`);
  return lines.join("\n");
}

export function formatTaskRuntime(runtime: any): string {
  const session = runtime.session ?? {};
  const events = Array.isArray(runtime.events) ? runtime.events : [];
  const lines: string[] = [];
  lines.push(`Task runtime`);
  lines.push(`  Task:        ${runtime.task_id}`);
  lines.push(`  Session:     ${runtime.session_id ?? runtime.taskSessionId}`);
  lines.push(`  Status:      ${session.status ?? "unknown"}${session.statusReason ? ` (${session.statusReason})` : ""}`);
  if (session.runtimeEndpointPath) lines.push(`  Endpoint:    ${session.runtimeEndpointPath}`);
  if (session.startedAt) lines.push(`  Started:     ${session.startedAt}`);
  if (session.stoppedAt) lines.push(`  Stopped:     ${session.stoppedAt}`);
  if (events.length === 0) {
    lines.push(`  Events:      none`);
    return lines.join("\n");
  }
  lines.push(`  Events:`);
  for (const event of events.slice(-10)) {
    const sequence = event.sequence != null ? `#${event.sequence}`.padEnd(6) : "".padEnd(6);
    const type = sessionEventType(event).padEnd(18);
    const roleValue = sessionEventMessage(event).role;
    const role = roleValue ? ` ${roleValue}` : "";
    lines.push(`    ${sequence}${type}${role}`);
  }
  const hasMore = runtime.pagination?.hasMore ? " (more available)" : "";
  lines.push(`  Event count: ${events.length}${hasMore}`);
  return lines.join("\n");
}

export function formatTaskSession(data: any): string {
  const session = data.session ?? {};
  const lines: string[] = [];
  lines.push(data.task_id ? `Task session` : `Session`);
  if (data.task_id) lines.push(`  Task:        ${data.task_id}`);
  lines.push(`  Session:     ${data.session_id}`);
  if (data.project_id) lines.push(`  Project:     ${data.project_id}`);
  lines.push(
    `  State:       ${session.state ?? session.status ?? "unknown"}${(session.stateReason ?? session.statusReason) ? ` (${session.stateReason ?? session.statusReason})` : ""}`,
  );
  if (session.title) lines.push(`  Title:       ${session.title}`);
  if (session.startedAt) lines.push(`  Started:     ${session.startedAt}`);
  if (session.stoppedAt) lines.push(`  Stopped:     ${session.stoppedAt}`);
  return lines.join("\n");
}

function sessionEventPayload(event: any): Record<string, any> {
  return event?.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload : {};
}

function sessionEventType(event: any): string {
  return typeof event?.type === "string" ? event.type : "event";
}

function sessionEventMessage(event: any): Record<string, any> {
  const message = sessionEventPayload(event).message;
  return message && typeof message === "object" && !Array.isArray(message) ? message : {};
}

function sessionEventAssistantText(event: any): string {
  const message = sessionEventMessage(event);
  if (message.role !== "assistant" && message.role !== "agent") return "";
  return sessionMessageContentText(message.content);
}

function sessionMessageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => {
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      if (typeof part?.output === "string") return part.output;
      return "";
    })
    .filter(Boolean)
    .join("");
}

function truncateSingleLine(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

function jsonPreview(value: unknown, maxLength: number): string {
  if (value === undefined || value === null || value === "") return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return truncateSingleLine(text ?? "", maxLength);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function sessionEventOutputText(event: any): string {
  const content = sessionEventMessage(event).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: any) => {
      if (block?.type !== "tool_result") return "";
      const result = block.result && typeof block.result === "object" ? block.result : {};
      return toolResultText(result);
    })
    .filter(Boolean)
    .join("\n");
}

function toolResultText(result: Record<string, any>): string {
  const content = Array.isArray(result.content)
    ? result.content
        .map((part: any) => {
          if (part?.type === "text") return firstString(part.text);
          if (part?.type === "json") return JSON.stringify(part.value);
          if (part?.type === "file") return firstString(part.path, part.name);
          if (part?.type === "image") return firstString(part.url, "[image]");
          return "";
        })
        .filter(Boolean)
        .join("\n")
    : "";
  return firstString(result.stdout, result.stderr, result.output, content);
}

function sessionEventToolSummary(event: any, maxLength: number): string {
  const content = sessionEventMessage(event).content;
  if (!Array.isArray(content)) return "";
  const block = content.find((part: any) => part?.type === "tool_call" || part?.type === "tool_result");
  if (block?.type === "tool_call") {
    const toolCall = block.toolCall && typeof block.toolCall === "object" ? block.toolCall : {};
    return `${toolCall.name ?? "tool"} ${jsonPreview(toolCall.input ?? {}, maxLength)}`.trimEnd();
  }
  if (block?.type === "tool_result") {
    const outputText = sessionEventOutputText(event);
    return `result${block.error ? " error" : ""}${outputText ? ` ${truncateSingleLine(outputText, maxLength)}` : ""}`;
  }
  return "";
}

export function formatSessionEvent(
  event: any,
  mode: "all" | "tool" | "assistant" = "all",
  options: { verbose?: boolean; maxLength?: number } = {},
): string {
  const maxLength = options.maxLength ?? (options.verbose ? 800 : 220);
  if (mode === "assistant") return sessionEventAssistantText(event);
  const sequence = event.sequence != null ? `#${event.sequence}`.padEnd(8) : "";
  const eventType = sessionEventType(event);
  const type = eventType.padEnd(24);
  const roleValue = sessionEventMessage(event).role;
  const role = roleValue ? ` ${roleValue}` : "";
  if (mode === "tool") return `${sequence}${type}${role}  ${sessionEventToolSummary(event, maxLength)}`.trimEnd();
  const text = sessionEventAssistantText(event);
  const toolSummary = sessionEventToolSummary(event, maxLength);
  const outputText = text || sessionEventOutputText(event);
  const summary = outputText ? `  ${truncateSingleLine(outputText, maxLength)}` : toolSummary ? `  ${toolSummary}` : "";
  if (toolSummary) return `${sequence}${type}${role}  ${toolSummary}`.trimEnd();
  return `${sequence}${type}${role}${summary}`.trimEnd();
}

export function formatTaskNotes(notes: any[]): string {
  if (notes.length === 0) return "No notes.";
  return notes
    .map((l) => {
      const time = new Date(l.created_at).toLocaleString();
      const actor = l.actor_id ? ` [${l.actor_id}]` : "";
      return `  ${time}  ${l.action.padEnd(18)}${actor}  ${l.detail || ""}`;
    })
    .join("\n");
}

export function formatAgent(agent: any): string {
  const lines: string[] = [];
  const structuredStatus = typeof agent.status === "object" && agent.status ? agent.status : null;
  lines.push(`${agent.name}`);
  lines.push(`  ID:       ${agent.id}`);
  lines.push(`  Status:   ${structuredStatus ? (agent.status.schedulable ? "schedulable" : "unschedulable") : agent.status}`);
  if (structuredStatus) {
    lines.push(`  Todo:     ${agent.status.tasks.todo}`);
    lines.push(`  Progress: ${agent.status.tasks.in_progress}`);
    lines.push(`  Review:   ${agent.status.tasks.in_review}`);
    lines.push(`  Done:     ${agent.status.tasks.done}`);
    lines.push(`  Cancelled:${agent.status.tasks.cancelled}`);
  }
  if (agent.role) lines.push(`  Role:     ${agent.role}`);
  if (agent.bio) lines.push(`  Bio:      ${agent.bio}`);
  lines.push(`  Runtime:  ${agent.runtime}`);
  if (agent.model) lines.push(`  Model:    ${agent.model}`);
  if (agent.skills?.length) lines.push(`  Skills:   ${agent.skills.join(", ")}`);
  if (agent.handoff_to?.length) lines.push(`  Handoff:  ${agent.handoff_to.join(", ")}`);
  return lines.join("\n");
}

export function formatSubagent(agent: any): string {
  const lines: string[] = [];
  lines.push(`${agent.name}`);
  lines.push(`  ID:       ${agent.id}`);
  lines.push(`  Username: ${agent.username}`);
  if (agent.role) lines.push(`  Role:     ${agent.role}`);
  if (agent.bio) lines.push(`  Bio:      ${agent.bio}`);
  const models = formatSubagentModels(agent.models);
  if (models) lines.push(`  Models:   ${models}`);
  if (agent.skills?.length) lines.push(`  Skills:   ${agent.skills.join(", ")}`);
  return lines.join("\n");
}

export function formatBoard(board: any): string {
  const columnOrder = ["todo", "in_progress", "in_review", "done", "cancelled"];
  const columnLabels: Record<string, string> = {
    todo: "Todo",
    in_progress: "In Progress",
    in_review: "In Review",
    done: "Done",
    cancelled: "Cancelled",
  };

  const tasks: any[] = board.tasks || [];
  const grouped: Record<string, any[]> = {};
  for (const col of columnOrder) grouped[col] = [];
  for (const t of tasks) {
    if (grouped[t.status]) grouped[t.status].push(t);
  }

  const lines: string[] = [`Board: ${board.name} (${tasks.length} tasks)`];
  for (const key of columnOrder) {
    const col = grouped[key];
    if (col.length === 0) continue;
    lines.push(`\n${columnLabels[key]} (${col.length}):`);
    for (const t of col) {
      const agent = t.assigned_to ? ` → ${t.assigned_to.slice(0, 8)}` : "";
      const blocked = t.blocked ? " BLOCKED" : "";
      const pr = t.pr_url ? ` PR: ${t.pr_url}` : "";
      lines.push(`  ${t.id}  ${t.title}${blocked}${agent}${pr}`);
    }
  }

  return lines.join("\n");
}
