import type { Command } from "commander";
import { createClient } from "../agent/leader.js";
import { getOutputFormat, output, outputOption } from "../output.js";

function pad(label: string): string {
  return `${label}:`.padEnd(14);
}

function formatDescribeTask(task: any, notes: any[], messages: any[]): string {
  const lines: string[] = [];

  lines.push(`${pad("Name")} ${task.title}`);
  lines.push(`${pad("ID")} ${task.id}`);
  lines.push(`${pad("Status")} ${task.status}`);
  if (task.board_id) lines.push(`${pad("Board")} ${task.board_id}`);
  if (task.repository_name) lines.push(`${pad("Repo")} ${task.repository_name}`);
  if (task.assigned_to) lines.push(`${pad("Agent")} ${task.assigned_to}`);
  if (task.labels?.length) lines.push(`${pad("Labels")} ${task.labels.join(", ")}`);
  if (task.created_at) lines.push(`${pad("Created")} ${task.created_at}`);
  if (task.depends_on?.length) {
    lines.push(`${pad("Dependencies")} ${task.depends_on.join(", ")}`);
  }
  lines.push(`${pad("Blocked")} ${task.blocked ? "true" : "false"}`);
  if (task.pr_url) lines.push(`${pad("PR")} ${task.pr_url}`);
  if (task.description) {
    lines.push("");
    lines.push("Description:");
    lines.push(`  ${task.description}`);
  }

  if (notes.length > 0) {
    lines.push("");
    lines.push("Logs:");
    for (const n of notes) {
      const time = n.created_at;
      const detail = n.detail || n.action || "";
      lines.push(`  ${time}  ${detail}`);
    }
  }

  if (messages.length > 0) {
    lines.push("");
    lines.push("Messages:");
    for (const m of messages) {
      const time = m.created_at;
      const sender = m.sender_type === "agent" ? `[agent:${m.sender_id?.slice(0, 8)}]` : "[human]";
      lines.push(`  ${time}  ${sender}  ${m.content}`);
    }
  }

  return lines.join("\n");
}

function formatDescribeAgent(agent: any): string {
  const lines: string[] = [];

  lines.push(`${pad("Name")} ${agent.name}`);
  lines.push(`${pad("ID")} ${agent.id}`);
  if (agent.username) lines.push(`${pad("Username")} ${agent.username}`);
  if (agent.version) lines.push(`${pad("Version")} ${agent.version}`);
  const structuredStatus = typeof agent.status === "object" && agent.status ? agent.status : null;
  lines.push(`${pad("Status")} ${structuredStatus ? (agent.status.schedulable ? "schedulable" : "unschedulable") : agent.status}`);
  if (structuredStatus) {
    lines.push(`${pad("Todo tasks")} ${agent.status.tasks.todo}`);
    lines.push(`${pad("In progress")} ${agent.status.tasks.in_progress}`);
    lines.push(`${pad("In review")} ${agent.status.tasks.in_review}`);
    lines.push(`${pad("Done tasks")} ${agent.status.tasks.done}`);
    lines.push(`${pad("Cancelled")} ${agent.status.tasks.cancelled}`);
  }
  if (agent.role) lines.push(`${pad("Role")} ${agent.role}`);
  if (agent.bio) lines.push(`${pad("Bio")} ${agent.bio}`);
  lines.push(`${pad("Runtime")} ${agent.runtime}`);
  if (agent.model) lines.push(`${pad("Model")} ${agent.model}`);
  if (agent.fingerprint) lines.push(`${pad("Fingerprint")} ${agent.fingerprint}`);
  if (agent.skills?.length) lines.push(`${pad("Skills")} ${agent.skills.join(", ")}`);
  if (agent.handoff_to?.length) lines.push(`${pad("Handoff")} ${agent.handoff_to.join(", ")}`);
  const logs = Array.isArray(agent.logs) ? agent.logs : [];
  if (logs.length > 0) {
    lines.push("");
    lines.push("Activity:");
    for (const log of logs.slice(0, 10)) {
      const time = log.created_at ?? "";
      const action = log.action ?? "activity";
      const detail = log.detail ? `  ${log.detail}` : "";
      lines.push(`  ${time}  ${action}${detail}`);
    }
  }

  return lines.join("\n");
}

function normalizeVersion(version: string): string {
  return version.startsWith("v") && version.length > 1 ? version.slice(1) : version;
}

async function resolveAgent(client: any, id: string, version?: string): Promise<any> {
  if (!version) return client.getAgent(id);

  const normalized = normalizeVersion(version);
  const agents = await client.listAgents();
  const agent = agents.find((candidate: any) => candidate.username === id && candidate.version === normalized);
  if (!agent) {
    console.error(`Agent version not found: ${id}@${version}`);
    process.exit(1);
  }
  return client.getAgent(agent.id);
}

function formatDescribeBoard(board: any): string {
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

  const counts = columnOrder.map((k) => `${columnLabels[k]}: ${grouped[k].length}`).join("  ");
  const lines: string[] = [];

  lines.push(`${pad("Name")} ${board.name}`);
  lines.push(`${pad("ID")} ${board.id}`);
  if (board.type) lines.push(`${pad("Type")} ${board.type}`);
  if (board.description) lines.push(`${pad("Description")} ${board.description}`);
  lines.push(`${pad("Tasks")} ${tasks.length} total  (${counts})`);

  for (const key of columnOrder) {
    const col = grouped[key];
    if (col.length === 0) continue;
    lines.push("");
    lines.push(`${columnLabels[key]} (${col.length}):`);
    for (const t of col) {
      const agent = t.assigned_to ? ` → ${t.assigned_to.slice(0, 8)}` : "";
      const blocked = t.blocked ? " BLOCKED" : "";
      const pr = t.pr_url ? ` PR: ${t.pr_url}` : "";
      const labels = t.labels?.length ? ` [${t.labels.join(",")}]` : "";
      lines.push(`  ${t.id}  ${t.title}${labels}${blocked}${agent}${pr}`);
    }
  }

  return lines.join("\n");
}

export function registerDescribeCommand(program: Command) {
  const describeCmd = program.command("describe").description("Show detailed view of a resource");

  describeCmd
    .command("task <id>")
    .description("Show full detail for a task: logs, messages")
    .addOption(outputOption())
    .action(async (id: string, opts) => {
      const client = await createClient();
      const fmt = getOutputFormat(opts.output);
      const [task, notes, messages] = await Promise.all([client.getTask(id), client.getTaskNotes(id), client.getMessages(id)]);
      output({ task, notes, messages }, fmt, () => formatDescribeTask(task, notes as any[], messages as any[]), { kind: "task" });
    });

  describeCmd
    .command("agent <id>")
    .description("Show full detail for an agent")
    .option("--version <version>", "Agent version when <id> is a username")
    .addOption(outputOption())
    .action(async (id: string, opts) => {
      const client = await createClient();
      const fmt = getOutputFormat(opts.output);
      const agent = await resolveAgent(client, id, opts.version);
      output(agent, fmt, () => formatDescribeAgent(agent), { kind: "agent" });
    });

  describeCmd
    .command("board <id>")
    .description("Show full detail for a board: all tasks with status counts")
    .addOption(outputOption())
    .action(async (id: string, opts) => {
      const client = await createClient();
      const fmt = getOutputFormat(opts.output);
      const board = await client.getBoard(id);
      output(board, fmt, formatDescribeBoard, { kind: "board" });
    });
}
