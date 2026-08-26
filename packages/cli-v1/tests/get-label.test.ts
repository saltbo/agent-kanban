// @vitest-environment node
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetBoard = vi.fn();
const mockClient = { getBoard: mockGetBoard };
const mockCreateClient = vi.fn(() => Promise.resolve(mockClient));
const mockOutput = vi.fn();
const mockFormatLabelList = vi.fn();

vi.mock("../src/agent/leader.js", () => ({
  createClient: mockCreateClient,
}));

vi.mock("../src/output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/output.js")>();
  return {
    ...actual,
    getOutputFormat: vi.fn(() => "text"),
    output: mockOutput,
    formatAgent: vi.fn(),
    formatAgentList: vi.fn(),
    formatBoard: vi.fn(),
    formatBoardList: vi.fn(),
    formatLabelList: mockFormatLabelList,
    formatRepository: vi.fn(),
    formatRepositoryList: vi.fn(),
    formatTask: vi.fn(),
    formatTaskList: vi.fn(),
    formatTaskListWide: vi.fn(),
    formatTaskNotes: vi.fn(),
  };
});

const { registerGetCommand } = await import("../src/commands/get.js");

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerGetCommand(program);
  return program;
}

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetBoard.mockResolvedValue({
    id: "board-1",
    labels: [{ name: "backend", color: "#38BDF8", description: "Backend/API work" }],
  });
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as any);
});

afterEach(() => {
  exitSpy.mockRestore();
});

describe("get label", () => {
  it("loads labels from the board", async () => {
    const program = makeProgram();
    await program.parseAsync(["get", "label", "--board", "board-1"], { from: "user" });

    expect(mockGetBoard).toHaveBeenCalledWith("board-1");
    expect(mockOutput).toHaveBeenCalledWith([{ name: "backend", color: "#38BDF8", description: "Backend/API work" }], "text", mockFormatLabelList, {
      kind: "label",
    });
  });

  it("outputs an empty label list when the board has no labels", async () => {
    mockGetBoard.mockResolvedValue({ id: "board-1", labels: undefined });
    const program = makeProgram();
    await program.parseAsync(["get", "label", "--board", "board-1"], { from: "user" });

    expect(mockOutput).toHaveBeenCalledWith([], "text", mockFormatLabelList, { kind: "label" });
  });
});
