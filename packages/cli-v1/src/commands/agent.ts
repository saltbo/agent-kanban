import type { Command } from "commander";
import { createClient } from "../agent/leader.js";
import { getOutputFormat, output, outputOption } from "../output.js";

const DIFF_FIELDS = ["name", "bio", "soul", "role", "kind", "handoff_to", "runtime", "model", "skills", "subagents"];

function normalizeVersion(version: string): string {
  return version.startsWith("v") && version.length > 1 ? version.slice(1) : version;
}

function splitVersionRef(ref: string): { username: string; version: string } | null {
  const index = ref.lastIndexOf("@");
  if (index <= 0 || index === ref.length - 1) return null;
  return { username: ref.slice(0, index), version: normalizeVersion(ref.slice(index + 1)) };
}

async function resolveAgentRef(client: any, ref: string): Promise<any> {
  const versionRef = splitVersionRef(ref);
  if (!versionRef) return client.getAgent(ref);

  const agents = await client.listAgents();
  const agent = agents.find((candidate: any) => candidate.username === versionRef.username && candidate.version === versionRef.version);
  if (!agent) {
    console.error(`Agent version not found: ${ref}`);
    process.exit(1);
  }
  return client.getAgent(agent.id);
}

function fieldValue(agent: any, field: string): string {
  const value = agent[field];
  if (Array.isArray(value)) return value.join(", ");
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function diffAgents(from: any, to: any) {
  const changes = DIFF_FIELDS.flatMap((field) => {
    const before = fieldValue(from, field);
    const after = fieldValue(to, field);
    return before === after ? [] : [{ field, before, after }];
  });
  return {
    from: { id: from.id, username: from.username, version: from.version },
    to: { id: to.id, username: to.username, version: to.version },
    changes,
  };
}

function formatAgentDiff(diff: ReturnType<typeof diffAgents>): string {
  const header = `Agent diff ${diff.from.username}@${diff.from.version}..${diff.to.username}@${diff.to.version}`;
  if (diff.changes.length === 0) return `${header}\n  No differences.`;
  const lines = [header];
  for (const change of diff.changes) {
    lines.push(`\n${change.field}:`);
    lines.push(`- ${change.before || "<empty>"}`);
    lines.push(`+ ${change.after || "<empty>"}`);
  }
  return lines.join("\n");
}

export function registerAgentCommand(program: Command) {
  const agentCmd = program.command("agent").description("Agent lifecycle commands");

  agentCmd
    .command("diff <from> [to]")
    .description("Compare two agent versions")
    .addOption(outputOption())
    .action(async (fromRef: string, toRef: string | undefined, opts) => {
      const client = await createClient();
      const from = await resolveAgentRef(client, fromRef);
      const to = toRef ? await resolveAgentRef(client, toRef) : await resolveAgentRef(client, `${from.username}@latest`);
      const fmt = getOutputFormat(opts.output);
      output(diffAgents(from, to), fmt, formatAgentDiff);
    });
}
