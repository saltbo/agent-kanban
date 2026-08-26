import type { ApiClient } from "../client/index.js";
import { type OutputFormat, output } from "../output.js";

function isUrl(value: string): boolean {
  return value.includes("://") || value.startsWith("git@");
}

async function resolveRepoField(client: ApiClient, spec: Record<string, unknown>): Promise<void> {
  const repo = spec.repo as string | undefined;
  if (!repo) return;
  delete spec.repo;
  if (isUrl(repo)) {
    const repos = await client.listRepositories({ url: repo });
    if (repos.length === 0) {
      console.error(`Repository not found for URL: ${repo}`);
      process.exit(1);
    }
    spec.repository_id = repos[0].id;
  } else {
    spec.repository_id = repo;
  }
}

function agentBody(spec: Record<string, unknown>, metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if ("kind" in spec) {
    console.error("Agent resources create worker agents only. Remove spec.kind.");
    process.exit(1);
  }
  if ("username" in spec || "name" in spec) {
    console.error("Agent identity belongs in metadata.name and metadata.annotations, not spec.");
    process.exit(1);
  }
  const username = metadata?.name;
  if (typeof username !== "string" || username.length === 0) {
    console.error("Agent resources require metadata.name.");
    process.exit(1);
  }
  const annotations = metadata?.annotations as Record<string, unknown> | undefined;
  const name = annotations?.["agent-kanban.dev/nickname"];
  return {
    ...spec,
    username,
    ...(typeof name === "string" && name.length > 0 ? { name } : {}),
    kind: "worker",
  };
}

function subagentBody(spec: Record<string, unknown>, metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if ("username" in spec || "name" in spec) {
    console.error("Subagent identity belongs in metadata.name and metadata.annotations, not spec.");
    process.exit(1);
  }
  const annotations = metadata?.annotations as Record<string, unknown> | undefined;
  const name = annotations?.["agent-kanban.dev/nickname"];
  return {
    ...spec,
    ...(typeof name === "string" && name.length > 0 ? { name } : {}),
  };
}

function subagentCreateBody(spec: Record<string, unknown>, metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const username = metadata?.name;
  if (typeof username !== "string" || username.length === 0) {
    console.error("Subagent resources require metadata.name.");
    process.exit(1);
  }
  return {
    ...subagentBody(spec, metadata),
    username,
  };
}

export async function applyResource(
  client: ApiClient,
  kind: string,
  spec: Record<string, unknown>,
  fmt: OutputFormat,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const id = spec.id as string | undefined;

  switch (kind.toLowerCase()) {
    case "task": {
      await resolveRepoField(client, spec);
      if (id) {
        const { id: _, ...body } = spec;
        const task = (await client.updateTask(id, body)) as any;
        output(task, fmt, (t) => `Updated task ${t.id}: ${t.title}`, { kind: "task" });
      } else {
        const task = (await client.createTask(spec)) as any;
        output(task, fmt, (t) => `Created task ${t.id}: ${t.title}`, { kind: "task" });
      }
      break;
    }
    case "board": {
      if (id) {
        const { id: _, ...body } = spec;
        const board = (await client.updateBoard(id, body)) as any;
        output(board, fmt, (b) => `Updated board ${b.id}: ${b.name}`, { kind: "board" });
      } else {
        const board = (await client.createBoard(spec as any)) as any;
        output(board, fmt, (b) => `Created board ${b.id}: ${b.name}`, { kind: "board" });
      }
      break;
    }
    case "agent": {
      const body = agentBody(spec, metadata);
      if (id) {
        const { id: _, username: _username, kind: _kind, ...updates } = body;
        const agent = (await client.updateAgent(id, updates)) as any;
        output(agent, fmt, (a) => `Updated agent ${a.id}: ${a.name}`, { kind: "agent" });
      } else {
        const agent = (await client.createAgent(body as any)) as any;
        output(agent, fmt, (a) => `Created agent ${a.id}: ${a.name} (${a.role || "no role"})`, { kind: "agent" });
      }
      break;
    }
    case "subagent": {
      if (id) {
        const { id: _, ...updates } = subagentBody(spec, metadata);
        const subagent = (await client.updateSubagent(id, updates)) as any;
        output(subagent, fmt, (a) => `Updated subagent ${a.id}: ${a.name}`, { kind: "subagent" });
      } else {
        const subagent = (await client.createSubagent(subagentCreateBody(spec, metadata) as any)) as any;
        output(subagent, fmt, (a) => `Created subagent ${a.id}: ${a.name} (${a.role || "no role"})`, { kind: "subagent" });
      }
      break;
    }
    case "repo": {
      const repo = (await client.createRepository(spec as any)) as any;
      output(repo, fmt, (r) => `Added repository ${r.id}: ${r.name}`, { kind: "repo" });
      break;
    }
    default:
      console.error(`Unknown kind: ${kind}. Supported: Task, Board, Agent, Subagent, Repo`);
      process.exit(1);
  }
}
