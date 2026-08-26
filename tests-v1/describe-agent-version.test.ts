// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAgent = vi.fn();
const listAgents = vi.fn();
const listSessions = vi.fn();
const output = vi.fn();

vi.mock("../packages/cli/src/agent/leader.js", () => ({
  createClient: vi.fn(async () => ({
    getAgent,
    listAgents,
    listSessions,
  })),
}));

vi.mock("../packages/cli/src/output.js", () => ({
  getOutputFormat: vi.fn((format?: string) => format ?? "text"),
  output,
  outputOption: vi.fn(() => ({ flags: "-o, --output <format>" })),
}));

type CommandAction = (...args: any[]) => Promise<void>;

type CapturedCommand = {
  action?: CommandAction;
  options: string[];
};

function buildProgram(captureCommand: (name: string, command: CapturedCommand) => void): any {
  const makeCommand = (name?: string): any => {
    const captured: CapturedCommand = { options: [] };
    const command = {
      description: () => command,
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
    command: () => makeCommand("describe"),
  };
}

async function registerDescribeCommands(): Promise<Map<string, CapturedCommand>> {
  const { registerDescribeCommand } = await import("../packages/cli/src/commands/describe.js");
  const commands = new Map<string, CapturedCommand>();
  registerDescribeCommand(buildProgram((name, command) => commands.set(name, command)));
  return commands;
}

describe("describe agent version", () => {
  beforeEach(() => {
    getAgent.mockReset();
    listAgents.mockReset();
    listSessions.mockReset();
    output.mockReset();
  });

  it("resolves username and version before describing an agent", async () => {
    const commands = await registerDescribeCommands();
    const command = commands.get("agent <id>")!;
    listAgents.mockResolvedValue([{ id: "agent-1", username: "alex-kim", version: "abc123def4" }]);
    getAgent.mockResolvedValue({ id: "agent-1", username: "alex-kim", version: "abc123def4", name: "Alex Kim" });

    await command.action!("alex-kim", { version: "abc123def4", output: "json" });

    expect(getAgent).toHaveBeenCalledWith("agent-1");
    expect(listSessions).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(
      { id: "agent-1", username: "alex-kim", version: "abc123def4", name: "Alex Kim" },
      "json",
      expect.any(Function),
      { kind: "agent" },
    );
  });
});
