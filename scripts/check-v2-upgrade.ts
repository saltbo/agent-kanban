import { spawnSync } from "node:child_process";

const mode = process.argv[2];
if (mode !== "--local" && mode !== "--remote") {
  throw new Error("Usage: tsx scripts/check-v2-upgrade.ts <--local|--remote>");
}

const schema = execute("PRAGMA table_info(tasks)");
if (schema === null || schema.some((column) => column.name === "assignee_identity_type")) process.exit(0);

const blockingTasks = execute("SELECT id, status FROM tasks WHERE status NOT IN ('done', 'cancelled') ORDER BY id") ?? [];
if (blockingTasks.length === 0) process.exit(0);

process.stderr.write("Cannot upgrade Agent Kanban v1 to v2 while non-terminal Tasks remain:\n");
for (const task of blockingTasks) process.stderr.write(`- ${task.id} (${task.status})\n`);
process.exit(1);

function execute<T extends Record<string, unknown>>(query: string): T[] | null {
  const result = spawnSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", mode, "--command", query, "--json"], { encoding: "utf8" });
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (output.includes("no such table: tasks")) return null;
    process.stderr.write(output);
    process.exit(result.status ?? 1);
  }
  const executions = JSON.parse(result.stdout) as Array<{ results?: T[] }>;
  return executions.flatMap((execution) => execution.results ?? []);
}
