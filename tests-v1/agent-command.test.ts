// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAgent = vi.fn();
const output = vi.fn();

vi.mock("../packages/cli/src/agent/leader.js", () => ({
  createClient: vi.fn(async () => ({
    getAgent,
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
    command: () => makeCommand("agent"),
  };
}

async function registerAgentCommands(): Promise<Map<string, CapturedCommand>> {
  const { registerAgentCommand } = await import("../packages/cli/src/commands/agent.js");
  const commands = new Map<string, CapturedCommand>();
  registerAgentCommand(buildProgram((name, command) => commands.set(name, command)));
  return commands;
}

describe("agent command", () => {
  beforeEach(() => {
    getAgent.mockReset();
    output.mockReset();
  });

  it("diffs an agent id against latest by default", async () => {
    const commands = await registerAgentCommands();
    const command = commands.get("diff <from> [to]")!;
    getAgent.mockResolvedValueOnce({ id: "agent-2", username: "alex-kim", version: "abc123def4", name: "Alex", soul: "new", runtime: "codex" });
    const listAgents = vi.fn().mockResolvedValue([{ id: "agent-latest", username: "alex-kim", version: "latest" }]);
    vi.mocked((await import("../packages/cli/src/agent/leader.js")).createClient).mockResolvedValueOnce({
      getAgent,
      listAgents,
    } as any);
    getAgent.mockResolvedValueOnce({ id: "agent-latest", username: "alex-kim", version: "latest", name: "Alex", soul: "old", runtime: "codex" });

    await command.action!("agent-2", undefined, { output: "json" });

    expect(getAgent).toHaveBeenNthCalledWith(1, "agent-2");
    expect(getAgent).toHaveBeenNthCalledWith(2, "agent-latest");
    expect(output).toHaveBeenCalledWith(
      {
        from: { id: "agent-2", username: "alex-kim", version: "abc123def4" },
        to: { id: "agent-latest", username: "alex-kim", version: "latest" },
        changes: [{ field: "soul", before: "new", after: "old" }],
      },
      "json",
      expect.any(Function),
    );
  });

  it("diffs username version refs", async () => {
    const commands = await registerAgentCommands();
    const command = commands.get("diff <from> [to]")!;
    const listAgents = vi.fn();
    vi.mocked((await import("../packages/cli/src/agent/leader.js")).createClient).mockResolvedValueOnce({
      getAgent,
      listAgents,
    } as any);
    listAgents
      .mockResolvedValueOnce([{ id: "agent-1", username: "alex-kim", version: "abc123def4" }])
      .mockResolvedValueOnce([{ id: "agent-2", username: "alex-kim", version: "def456abc7" }]);
    getAgent
      .mockResolvedValueOnce({ id: "agent-1", username: "alex-kim", version: "abc123def4", name: "Alex", role: "builder" })
      .mockResolvedValueOnce({ id: "agent-2", username: "alex-kim", version: "def456abc7", name: "Alex", role: "reviewer" });

    await command.action!("alex-kim@abc123def4", "alex-kim@def456abc7", { output: "json" });

    expect(getAgent).toHaveBeenNthCalledWith(1, "agent-1");
    expect(getAgent).toHaveBeenNthCalledWith(2, "agent-2");
    expect(output.mock.calls[0][0].changes).toEqual([{ field: "role", before: "builder", after: "reviewer" }]);
  });
});
