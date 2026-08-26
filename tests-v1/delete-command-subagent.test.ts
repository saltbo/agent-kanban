// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteSubagent = vi.fn();
const output = vi.fn();

vi.mock("../packages/cli/src/agent/leader.js", () => ({
  createClient: vi.fn(async () => ({
    deleteSubagent,
  })),
}));

vi.mock("../packages/cli/src/output.js", () => ({
  getOutputFormat: vi.fn((format?: string) => format ?? "text"),
  output,
  outputOption: vi.fn(() => ({ flags: "-o, --output <format>" })),
}));

type CommandAction = (id: string, opts: Record<string, string | undefined>) => Promise<void>;

type CapturedCommand = {
  action?: CommandAction;
};

function buildProgram(captureCommand: (name: string, command: CapturedCommand) => void): any {
  const makeCommand = (name?: string): any => {
    const captured: CapturedCommand = {};
    const command = {
      description: () => command,
      option: () => command,
      addOption: () => command,
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
    command: () => makeCommand("delete"),
  };
}

async function registerDeleteSubagent(): Promise<CapturedCommand> {
  const { registerDeleteCommand } = await import("../packages/cli/src/commands/delete.js");
  const commands = new Map<string, CapturedCommand>();
  registerDeleteCommand(buildProgram((name, command) => commands.set(name, command)));
  return commands.get("subagent <id>")!;
}

describe("registerDeleteCommand subagent", () => {
  beforeEach(() => {
    deleteSubagent.mockReset();
    output.mockReset();
  });

  it("deletes a subagent by id", async () => {
    const command = await registerDeleteSubagent();
    deleteSubagent.mockResolvedValue({ ok: true });

    await command.action!("subagent-1", { output: "json" });

    expect(deleteSubagent).toHaveBeenCalledWith("subagent-1");
    expect(output).toHaveBeenCalledWith({ ok: true }, "json", expect.any(Function));
  });
});
