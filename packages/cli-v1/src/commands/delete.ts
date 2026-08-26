import type { Command } from "commander";
import { createClient } from "../agent/leader.js";
import { getOutputFormat, output, outputOption } from "../output.js";

export function registerDeleteCommand(program: Command) {
  const deleteCmd = program.command("delete").description("Delete a resource (board, task, agent, subagent, repo, maintainer)");

  deleteCmd
    .command("label")
    .description("Delete a board label")
    .option("--board <id>", "Board ID")
    .option("--name <name>", "Label name")
    .addOption(outputOption())
    .action(async (opts) => {
      if (!opts.board || !opts.name) {
        console.error("Missing required options: --board and --name");
        process.exit(1);
      }
      const client = await createClient();
      const board = await client.deleteBoardLabel(opts.board, opts.name);
      const fmt = getOutputFormat(opts.output);
      output(board, fmt, (b) => `Deleted label ${opts.name} from board ${b.id}`);
    });

  deleteCmd
    .command("board <id>")
    .description("Delete a board")
    .addOption(outputOption())
    .action(async (id: string, opts) => {
      const client = await createClient();
      const fmt = getOutputFormat(opts.output);
      const board = await client.deleteBoard(id);
      output(board, fmt, () => `Deleted board ${id}`);
    });

  deleteCmd
    .command("task <id>")
    .description("Delete a task")
    .addOption(outputOption())
    .action(async (id: string, opts) => {
      const client = await createClient();
      const fmt = getOutputFormat(opts.output);
      const task = await client.deleteTask(id);
      output(task, fmt, () => `Deleted task ${id}`);
    });

  deleteCmd
    .command("agent <id>")
    .description("Delete an agent")
    .addOption(outputOption())
    .action(async (id: string, opts) => {
      const client = await createClient();
      const fmt = getOutputFormat(opts.output);
      const agent = await client.deleteAgent(id);
      output(agent, fmt, () => `Deleted agent ${id}`);
    });

  deleteCmd
    .command("subagent <id>")
    .description("Delete a task-local subagent")
    .addOption(outputOption())
    .action(async (id: string, opts) => {
      const client = await createClient();
      const fmt = getOutputFormat(opts.output);
      const subagent = await client.deleteSubagent(id);
      output(subagent, fmt, () => `Deleted subagent ${id}`);
    });

  deleteCmd
    .command("repo <id>")
    .description("Delete a repository")
    .addOption(outputOption())
    .action(async (id: string, opts) => {
      const client = await createClient();
      const fmt = getOutputFormat(opts.output);
      const repo = await client.deleteRepository(id);
      output(repo, fmt, () => `Deleted repository ${id}`);
    });

  deleteCmd
    .command("maintainer <id>")
    .description("Delete (archive) a board maintainer")
    .option("--board <id>", "Board ID")
    .addOption(outputOption())
    .action(async (id: string, opts) => {
      if (!opts.board) {
        console.error("--board is required");
        process.exit(1);
      }
      const client = await createClient();
      const fmt = getOutputFormat(opts.output);
      const maintainer = await client.deleteBoardMaintainer(opts.board, id);
      output(maintainer, fmt, () => `Deleted maintainer ${id}`);
    });
}
