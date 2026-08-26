// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const listModels = vi.fn();
const createClient = vi.fn();
const output = vi.fn();

vi.mock("../packages/cli/src/agent/leader.js", () => ({
  createClient,
}));

vi.mock("../packages/cli/src/output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../packages/cli/src/output.js")>();
  return {
    ...actual,
    getOutputFormat: vi.fn((format?: string) => format ?? "text"),
    output,
  };
});

type CommandAction = (opts: Record<string, string | undefined>) => Promise<void>;

type CapturedCommand = {
  action?: CommandAction;
  options: string[];
};

function buildProgram(captureModel: (command: CapturedCommand) => void): any {
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
        if (name === "model") captureModel(captured);
        return command;
      },
      command: (childName: string) => makeCommand(childName),
    };
    return command;
  };

  return {
    command: () => makeCommand("get"),
  };
}

async function registerGetModel(): Promise<CapturedCommand> {
  const { registerGetCommand } = await import("../packages/cli/src/commands/get.js");
  let modelCommand!: CapturedCommand;
  registerGetCommand(buildProgram((command) => (modelCommand = command)));
  return modelCommand;
}

describe("registerGetCommand model", () => {
  beforeEach(() => {
    listModels.mockReset();
    createClient.mockReset();
    output.mockReset();
    createClient.mockResolvedValue({ listModels });
  });

  it("requires a runtime option", async () => {
    const command = await registerGetModel();

    expect(command.options).toContain("--runtime <runtime>");
  });

  it("lists models from the API for the normalized runtime", async () => {
    const command = await registerGetModel();
    const models = [{ id: "claude-opus-4-1", name: "Claude Opus 4.1" }];
    listModels.mockResolvedValue(models);

    await command.action!({ runtime: "claude-code", output: "json" });

    expect(listModels).toHaveBeenCalledWith("claude");
    expect(output).toHaveBeenCalledWith(models, "json", expect.any(Function), { kind: "model" });
  });
});
