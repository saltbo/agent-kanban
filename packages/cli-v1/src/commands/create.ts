import {
  isBoardType,
  MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS,
  MAINTAINER_HEARTBEAT_MIN_INTERVAL_SECONDS,
  parseScheduledAt,
} from "@agent-kanban/shared";
import type { Command } from "commander";
import { createClient } from "../agent/leader.js";
import type { ApiClient } from "../client/index.js";
import { getOutputFormat, output, outputOption } from "../output.js";

function isUrl(value: string): boolean {
  return value.includes("://") || value.startsWith("git@");
}

function parseModels(value: string): Record<string, string> {
  const entries = value.split(",").map((entry) => entry.trim());
  const models: Record<string, string> = {};
  for (const entry of entries) {
    const index = entry.indexOf("=");
    if (index <= 0 || index === entry.length - 1) {
      console.error("--models must use runtime=model pairs, e.g. claude=sonnet,codex=gpt-5.1-codex");
      process.exit(1);
    }
    models[entry.slice(0, index).trim()] = entry.slice(index + 1).trim();
  }
  return models;
}

async function resolveRepoId(client: ApiClient, repoRef: string): Promise<string> {
  if (!isUrl(repoRef)) return repoRef;
  const repos = await client.listRepositories({ url: repoRef });
  if (repos.length === 0) {
    console.error(`Repository not found for URL: ${repoRef}`);
    process.exit(1);
  }
  return repos[0].id;
}

function parseHeartbeat(value: string): boolean {
  const normalized = value.toLowerCase();
  if (["on", "enabled", "true", "1"].includes(normalized)) return true;
  if (["off", "disabled", "false", "0"].includes(normalized)) return false;
  console.error("--heartbeat must be on or off");
  process.exit(1);
}

export function registerCreateCommand(program: Command) {
  const createCmd = program.command("create").description("Create a resource");

  createCmd
    .command("board")
    .description("Create a board")
    .requiredOption("--name <name>", "Board name")
    .requiredOption("--type <type>", "Board type: dev, ops")
    .option("--description <desc>", "Board description")
    .addOption(outputOption())
    .action(async (opts) => {
      if (!isBoardType(opts.type)) {
        console.error(`Unknown type "${opts.type}" — must be dev or ops`);
        process.exit(1);
      }
      const client = await createClient();
      const board = await client.createBoard({ name: opts.name, type: opts.type, description: opts.description });
      const fmt = getOutputFormat(opts.output);
      output(board, fmt, (b) => `Created board ${b.id}: ${b.name}`);
    });

  createCmd
    .command("task")
    .description("Create a task")
    .requiredOption("--board <id>", "Board ID")
    .requiredOption("--title <title>", "Task title")
    .option("--description <desc>", "Task description")
    .option("--repo <repo>", "Repository ID or URL")
    .option("--labels <labels>", "Comma-separated labels")
    .option("--input <json>", "JSON input payload")
    .option("--assign-to <id>", "Agent ID to assign")
    .option("--parent <id>", "Parent task ID")
    .option("--depends-on <ids>", "Comma-separated dependency task IDs")
    .option("--scheduled-at <time>", "ISO 8601 time to schedule task")
    .addOption(outputOption())
    .action(async (opts) => {
      const client = await createClient();
      const body: Record<string, unknown> = { title: opts.title, board_id: opts.board };
      if (opts.description) body.description = opts.description;
      if (opts.repo) body.repository_id = await resolveRepoId(client, opts.repo);
      if (opts.labels) body.labels = opts.labels.split(",").map((l: string) => l.trim());
      if (opts.assignTo) body.assigned_to = opts.assignTo;
      if (opts.parent) body.created_from = opts.parent;
      if (opts.dependsOn) body.depends_on = opts.dependsOn.split(",").map((id: string) => id.trim());
      if (opts.scheduledAt) {
        const normalized = parseScheduledAt(opts.scheduledAt);
        if (!normalized) {
          console.error("--scheduled-at must be ISO 8601 with timezone (e.g. 2026-03-28T09:00:00Z)");
          process.exit(1);
        }
        body.scheduled_at = normalized;
      }
      if (opts.input) {
        try {
          body.input = JSON.parse(opts.input);
        } catch {
          console.error("Invalid JSON for --input");
          process.exit(1);
        }
      }
      const task = await client.createTask(body);
      const fmt = getOutputFormat(opts.output);
      output(task, fmt, (t) => `Created task ${t.id}: ${t.title}`);
    });

  createCmd
    .command("label")
    .description("Create a board label")
    .option("--board <id>", "Board ID")
    .option("--name <name>", "Label name")
    .option("--color <hex>", "Label color, e.g. #22D3EE")
    .option("--description <desc>", "Label description")
    .addOption(outputOption())
    .action(async (opts) => {
      if (!opts.board || !opts.name || !opts.color) {
        console.error("Missing required options: --board, --name, and --color");
        process.exit(1);
      }
      const client = await createClient();
      const board = await client.createBoardLabel(opts.board, {
        name: opts.name,
        color: opts.color,
        description: opts.description,
      });
      const fmt = getOutputFormat(opts.output);
      output(board, fmt, (b) => `Created label ${opts.name} on board ${b.id}`);
    });

  createCmd
    .command("maintainer")
    .description("Create an AI maintainer for a board")
    .requiredOption("--board <id>", "Board ID")
    .requiredOption("--agent <id>", "Maintainer agent ID")
    .option("--interval-seconds <seconds>", "Heartbeat interval in seconds", String(MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS))
    .option("--heartbeat <on|off>", "Scheduled heartbeat switch", "on")
    .option("--paused", "Create maintainer paused")
    .addOption(outputOption())
    .action(async (opts) => {
      const intervalSeconds = Number.parseInt(String(opts.intervalSeconds), 10);
      if (!Number.isInteger(intervalSeconds) || intervalSeconds < MAINTAINER_HEARTBEAT_MIN_INTERVAL_SECONDS) {
        console.error(`--interval-seconds must be an integer >= ${MAINTAINER_HEARTBEAT_MIN_INTERVAL_SECONDS}`);
        process.exit(1);
      }
      const client = await createClient();
      const body: Record<string, unknown> = {
        agent_id: opts.agent,
        interval_seconds: intervalSeconds,
        heartbeat_enabled: parseHeartbeat(String(opts.heartbeat)),
      };
      if (opts.paused) body.status = "paused";
      const maintainer = await client.createBoardMaintainer(opts.board, body);
      const fmt = getOutputFormat(opts.output);
      output(maintainer, fmt, (m) => `Created maintainer ${m.id}`);
    });

  createCmd
    .command("agent")
    .description("Create an agent")
    .option("--name <name>", "Agent display name")
    .option("--username <username>", "Agent username")
    .option("--bio <bio>", "Agent bio")
    .option("--soul <soul>", "Agent soul — persistent behavior instructions")
    .option("--role <role>", "Agent role")
    .option("--runtime <runtime>", "Agent runtime")
    .option("--model <model>", "Model to use")
    .option("--handoff-to <roles>", "Comma-separated agent roles this agent may hand off to")
    .option("--skills <skills>", "Comma-separated installable skill refs (<source>@<skill>)")
    .option("--subagents <ids>", "Comma-separated subagent IDs to install as task-local subagents")
    .addOption(outputOption())
    .action(async (opts) => {
      const client = await createClient();
      if (!opts.username) {
        console.error("--username is required");
        process.exit(1);
      }
      if (!opts.runtime) {
        console.error("--runtime is required");
        process.exit(1);
      }
      const body: Record<string, unknown> = { name: opts.name || opts.username, username: opts.username, runtime: opts.runtime };
      if (opts.bio) body.bio = opts.bio;
      if (opts.soul) body.soul = opts.soul;
      if (opts.role) body.role = opts.role;
      if (opts.handoffTo) body.handoff_to = opts.handoffTo.split(",").map((s: string) => s.trim());
      if (opts.model) body.model = opts.model;
      if (opts.skills) body.skills = opts.skills.split(",").map((s: string) => s.trim());
      if (opts.subagents) body.subagents = opts.subagents.split(",").map((s: string) => s.trim());

      const agent = await client.createAgent(body as any);
      const fmt = getOutputFormat(opts.output);
      output(agent, fmt, (a) => `Created agent ${a.id}: ${a.name} (${a.role || "no role"})`);
    });

  createCmd
    .command("subagent")
    .description("Create a task-local subagent definition")
    .option("--name <name>", "Subagent display name")
    .option("--username <username>", "Subagent username")
    .option("--bio <bio>", "Subagent bio")
    .option("--soul <soul>", "Subagent soul — persistent behavior instructions")
    .option("--role <role>", "Subagent role")
    .option("--models <pairs>", "Comma-separated runtime=model pairs")
    .option("--skills <skills>", "Comma-separated installable skill refs (<source>@<skill>)")
    .addOption(outputOption())
    .action(async (opts) => {
      const client = await createClient();
      if (!opts.username) {
        console.error("--username is required");
        process.exit(1);
      }
      const body: Record<string, unknown> = { name: opts.name || opts.username, username: opts.username };
      if (opts.bio) body.bio = opts.bio;
      if (opts.soul) body.soul = opts.soul;
      if (opts.role) body.role = opts.role;
      if (opts.models) body.models = parseModels(opts.models);
      if (opts.skills) body.skills = opts.skills.split(",").map((s: string) => s.trim());

      const subagent = await client.createSubagent(body as any);
      const fmt = getOutputFormat(opts.output);
      output(subagent, fmt, (a) => `Created subagent ${a.id}: ${a.name} (${a.role || "no role"})`);
    });

  createCmd
    .command("repo")
    .description("Create a repository")
    .requiredOption("--name <name>", "Repository name")
    .requiredOption("--url <url>", "Clone URL")
    .addOption(outputOption())
    .action(async (opts) => {
      const client = await createClient();
      const repo = await client.createRepository({ name: opts.name, url: opts.url });
      const fmt = getOutputFormat(opts.output);
      output(repo, fmt, (r) => `Added repository ${r.id}: ${r.name}`);
    });

  createCmd
    .command("note <message>")
    .description("Add a log note to a task")
    .requiredOption("--task <id>", "Task ID")
    .action(async (message, opts) => {
      const client = await createClient();
      await client.addNote(opts.task, message);
      console.log("Log entry added.");
    });
}
