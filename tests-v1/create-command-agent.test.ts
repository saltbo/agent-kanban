// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const createAgent = vi.fn();
const createSubagent = vi.fn();
const createBoardMaintainer = vi.fn();
const output = vi.fn();

vi.mock("../packages/cli/src/agent/leader.js", () => ({
  createClient: vi.fn(async () => ({
    createAgent,
    createSubagent,
    createBoardMaintainer,
  })),
}));

vi.mock("../packages/cli/src/output.js", () => ({
  getOutputFormat: vi.fn((format?: string) => format ?? "text"),
  output,
  outputOption: vi.fn(() => ({ flags: "-o, --output <format>" })),
}));

type CommandAction = (opts: Record<string, unknown>) => Promise<void>;

type CapturedCommand = {
  action?: CommandAction;
  options: string[];
};

function buildProgram(captureCommand: (name: string, command: CapturedCommand) => void): any {
  const makeCommand = (name?: string): any => {
    const captured: CapturedCommand = { options: [] };
    const command = {
      description: () => command,
      requiredOption: (flags: string) => {
        captured.options.push(flags);
        return command;
      },
      option: (flags: string) => {
        captured.options.push(flags);
        return command;
      },
      addOption: (option: { flags: string }) => {
        captured.options.push(option.flags);
        return command;
      },
      action: (action: CommandAction) => {
        captured.action = action;
        if (name) captureCommand(name, captured);
        return command;
      },
      command: (childName: string) => makeCommand(childName),
    };
    return command;
  };

  return {
    command: () => makeCommand("create"),
  };
}

async function registerCreateAgent(): Promise<CapturedCommand> {
  const { registerCreateCommand } = await import("../packages/cli/src/commands/create.js");
  const commands = new Map<string, CapturedCommand>();
  registerCreateCommand(buildProgram((name, command) => commands.set(name, command)));
  return commands.get("agent")!;
}

async function registerCreateSubagent(): Promise<CapturedCommand> {
  const { registerCreateCommand } = await import("../packages/cli/src/commands/create.js");
  const commands = new Map<string, CapturedCommand>();
  registerCreateCommand(buildProgram((name, command) => commands.set(name, command)));
  return commands.get("subagent")!;
}

async function registerCreateMaintainer(): Promise<CapturedCommand> {
  const { registerCreateCommand } = await import("../packages/cli/src/commands/create.js");
  const commands = new Map<string, CapturedCommand>();
  registerCreateCommand(buildProgram((name, command) => commands.set(name, command)));
  return commands.get("maintainer")!;
}

describe("registerCreateCommand agent", () => {
  beforeEach(() => {
    createAgent.mockReset();
    createSubagent.mockReset();
    createBoardMaintainer.mockReset();
    output.mockReset();
  });

  it("does not expose a template option", async () => {
    const command = await registerCreateAgent();

    expect(command.options.some((option) => option.includes("--template"))).toBe(false);
  });

  it("does not expose a kind option", async () => {
    const command = await registerCreateAgent();

    expect(command.options.some((option) => option.includes("--kind"))).toBe(false);
  });

  it("creates an agent from explicit flags", async () => {
    const command = await registerCreateAgent();
    createAgent.mockResolvedValue({ id: "agent-1", name: "Worker Agent", role: "build" });

    await command.action!({
      username: "worker-agent",
      name: "Worker Agent",
      bio: "Coordinates work",
      soul: "Keep work moving",
      role: "build",
      runtime: "codex",
      model: "gpt-5",
      handoffTo: "qa, devops",
      skills: "saltbo/agent-kanban@agent-kanban,trailofbits/skills@differential-review",
      subagents: "worker-1",
      output: "json",
    });

    expect(createAgent).toHaveBeenCalledWith({
      username: "worker-agent",
      name: "Worker Agent",
      bio: "Coordinates work",
      soul: "Keep work moving",
      role: "build",
      runtime: "codex",
      model: "gpt-5",
      handoff_to: ["qa", "devops"],
      skills: ["saltbo/agent-kanban@agent-kanban", "trailofbits/skills@differential-review"],
      subagents: ["worker-1"],
    });
    expect(output).toHaveBeenCalledWith({ id: "agent-1", name: "Worker Agent", role: "build" }, "json", expect.any(Function));
  });

  it("creates a subagent with model mappings", async () => {
    const command = await registerCreateSubagent();
    createSubagent.mockResolvedValue({ id: "subagent-1", name: "Test Writer", role: "test-writer" });

    await command.action!({
      username: "test-writer",
      name: "Test Writer",
      bio: "Writes focused tests",
      soul: "Cover behavior",
      role: "test-writer",
      models: "claude=sonnet,codex=gpt-5.1-codex",
      skills: "saltbo/agent-kanban@agent-kanban",
      output: "json",
    });

    expect(createSubagent).toHaveBeenCalledWith({
      username: "test-writer",
      name: "Test Writer",
      bio: "Writes focused tests",
      soul: "Cover behavior",
      role: "test-writer",
      models: { claude: "sonnet", codex: "gpt-5.1-codex" },
      skills: ["saltbo/agent-kanban@agent-kanban"],
    });
    expect(output).toHaveBeenCalledWith({ id: "subagent-1", name: "Test Writer", role: "test-writer" }, "json", expect.any(Function));
  });

  it("creates a board maintainer", async () => {
    const command = await registerCreateMaintainer();
    createBoardMaintainer.mockResolvedValue({
      id: "maintainer-1",
      board_id: "board-1",
      agent_id: "agent-1",
    });

    await command.action!({
      board: "board-1",
      agent: "agent-1",
      intervalSeconds: "3600",
      heartbeat: "off",
      paused: true,
      output: "json",
    });

    expect(createBoardMaintainer).toHaveBeenCalledWith("board-1", {
      agent_id: "agent-1",
      interval_seconds: 3600,
      heartbeat_enabled: false,
      status: "paused",
    });
    expect(output).toHaveBeenCalledWith({ id: "maintainer-1", board_id: "board-1", agent_id: "agent-1" }, "json", expect.any(Function));
  });
});
