import { Command } from "commander";
import { createClient } from "./agent/leader.js";
import { registerAgentCommand } from "./commands/agent.js";
import { registerApplyCommand } from "./commands/apply.js";
import { registerAuthCommand } from "./commands/auth.js";
import { registerCreateCommand } from "./commands/create.js";
import { registerDeleteCommand } from "./commands/delete.js";
import { registerDescribeCommand } from "./commands/describe.js";
import { registerGetCommand } from "./commands/get.js";
import { registerLogsCommand, registerRestartCommand, registerStartCommand, registerStatusCommand, registerStopCommand } from "./commands/start.js";
import { registerUpdateCommand } from "./commands/update.js";
import { registerUpgradeCommand } from "./commands/upgrade.js";
import { registerWaitCommand } from "./commands/wait.js";
import { getCredentials, readConfig, setCurrent } from "./config.js";
import { getOutputFormat, output, outputOption } from "./output.js";
import { checkForUpdate, isNpx, isWorkerAgent } from "./updateCheck.js";
import { getVersion } from "./version.js";

const program = new Command();
program.name("ak").description("Agent-first kanban board").version(getVersion());

// ─── Config ───

program.commandsGroup("Configuration:");
const configCmd = program.command("config").description("Manage CLI configuration");

configCmd
  .command("get")
  .description("Show current credentials")
  .action(() => {
    try {
      const { apiUrl, issuer, resource } = getCredentials();
      console.log(`api-url: ${apiUrl}`);
      console.log(`issuer: ${issuer}`);
      console.log(`resource: ${resource}`);
    } catch (e: any) {
      console.error(e.message);
      process.exit(1);
    }
  });

configCmd
  .command("use")
  .description("Switch to saved credentials for an API URL")
  .requiredOption("--api-url <url>", "API server URL")
  .action((opts) => {
    try {
      setCurrent(opts.apiUrl);
      const host = new URL(opts.apiUrl).host;
      console.log(`Switched to ${host}`);
    } catch (e: any) {
      console.error(e.message);
      process.exit(1);
    }
  });

configCmd
  .command("list")
  .description("List all saved environments")
  .action(() => {
    const config = readConfig();
    const hosts = Object.keys(config.environments);
    if (hosts.length === 0) {
      console.log("No environments configured.");
      return;
    }
    for (const host of hosts) {
      const marker = host === config.current ? "* " : "  ";
      console.log(`${marker}${host}`);
    }
  });

registerAuthCommand(program);

// ─── Task ───

program.commandsGroup("Task Lifecycle:");
const taskCmd = program.command("task").description("Task lifecycle commands");

taskCmd
  .command("claim <id>")
  .description("Claim an assigned task — start working on it")
  .addOption(outputOption())
  .action(async (id, opts) => {
    const client = await createClient();
    const task = await client.claimTask(id);
    const fmt = getOutputFormat(opts.output);
    output(task, fmt, (t: any) => `Claimed task ${t.id}: ${t.title} (now in progress)`);
  });

taskCmd
  .command("cancel <id>")
  .description("Cancel a task")
  .addOption(outputOption())
  .action(async (id, opts) => {
    const client = await createClient();
    const task = await client.cancelTask(id);
    const fmt = getOutputFormat(opts.output);
    output(task, fmt, (t) => `Cancelled task ${t.id}: ${t.title}`);
  });

taskCmd
  .command("review <id>")
  .description("Move a task to In Review")
  .option("--pr-url <url>", "Pull request URL")
  .addOption(outputOption())
  .action(async (id, opts) => {
    const client = await createClient();
    const body: Record<string, unknown> = {};
    if (opts.prUrl) body.pr_url = opts.prUrl;
    const task = await client.reviewTask(id, body);
    const fmt = getOutputFormat(opts.output);
    output(task, fmt, (t) => `Moved task ${t.id} to review: ${t.title}`);
  });

taskCmd
  .command("complete <id>")
  .description("Complete a task (ops fallback)")
  .addOption(outputOption())
  .action(async (id, opts) => {
    const client = await createClient();
    const task = await client.completeTask(id);
    const fmt = getOutputFormat(opts.output);
    output(task, fmt, (t) => `Completed task ${t.id}: ${t.title}`);
  });

taskCmd
  .command("reject <id>")
  .description("Reject a task from review back to in-progress")
  .option("--reason <reason>", "Reason for rejection (logged)")
  .addOption(outputOption())
  .action(async (id, opts) => {
    const client = await createClient();
    const body: Record<string, unknown> = {};
    if (opts.reason) body.reason = opts.reason;
    const task = await client.rejectTask(id, body);
    const fmt = getOutputFormat(opts.output);
    output(task, fmt, (t) => `Rejected task ${t.id}: ${t.title} (back to in-progress)`);
  });

taskCmd
  .command("release <id>")
  .description("Release a task back to todo (ops fallback)")
  .addOption(outputOption())
  .action(async (id, opts) => {
    const client = await createClient();
    const task = await client.releaseTask(id);
    const fmt = getOutputFormat(opts.output);
    output(task, fmt, (t) => `Released task ${t.id}: ${t.title} (back to todo)`);
  });

// ─── Top-level CRUD ───

program.commandsGroup("Agent:");
registerAgentCommand(program);

program.commandsGroup("Resources:");
registerGetCommand(program);
registerDescribeCommand(program);
registerCreateCommand(program);
registerUpdateCommand(program);
registerDeleteCommand(program);
registerApplyCommand(program);

program.commandsGroup("Wait:");
registerWaitCommand(program);

// ─── Daemon ───

program.commandsGroup("Runtime:");
registerStartCommand(program);
registerStopCommand(program);
registerRestartCommand(program);
registerStatusCommand(program);
registerLogsCommand(program);

program.commandsGroup("Maintenance:");
registerUpgradeCommand(program);

// Fire update check in background for non-npx, non-worker invocations
const updatePromise = !isNpx() && !isWorkerAgent() ? checkForUpdate() : Promise.resolve(null);

program
  .parseAsync()
  .then(async () => {
    const update = await updatePromise;
    if (update) {
      process.stderr.write(`\nUpdate available: v${update.current} → v${update.latest}. Run \`ak upgrade\` to update.\n`);
    }
  })
  .catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
