// @vitest-environment node

import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateTask = vi.fn();
const mockUpdateTask = vi.fn();
const mockClient = {
  createTask: mockCreateTask,
  updateTask: mockUpdateTask,
};
const mockCreateClient = vi.fn(() => Promise.resolve(mockClient));

vi.mock("../src/agent/leader.js", () => ({
  createClient: mockCreateClient,
}));

vi.mock("../src/output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/output.js")>();
  return {
    ...actual,
    getOutputFormat: vi.fn(() => "text"),
    output: vi.fn(),
  };
});

const { registerCreateCommand } = await import("../src/commands/create.js");
const { registerUpdateCommand } = await import("../src/commands/update.js");

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerCreateCommand(program);
  registerUpdateCommand(program);
  return program;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateTask.mockResolvedValue({ id: "task-1", title: "Build" });
  mockUpdateTask.mockResolvedValue({ id: "task-1", title: "Build" });
});

describe("task runtime dispatch stays server-owned", () => {
  it("creates a task without client-side runtime annotations", async () => {
    const program = makeProgram();
    await program.parseAsync(["create", "task", "--board", "board-1", "--title", "Build", "--assign-to", "ak-agent-1"], { from: "user" });

    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Build",
        board_id: "board-1",
        assigned_to: "ak-agent-1",
      }),
    );
    expect(mockCreateTask.mock.calls[0][0]).not.toHaveProperty("metadata");
  });

  it("updates a task without client-side runtime annotations", async () => {
    const program = makeProgram();
    await program.parseAsync(["update", "task", "task-1", "--title", "Build v2"], { from: "user" });

    expect(mockUpdateTask).toHaveBeenCalledWith("task-1", {
      title: "Build v2",
    });
  });
});
