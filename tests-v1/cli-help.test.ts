// @vitest-environment node

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "../packages/cli/node_modules/commander/index.js";

const state = vi.hoisted(() => ({
  program: null as Command | null,
  createClient: vi.fn(),
}));

vi.mock("../packages/cli/src/agent/leader.js", () => ({
  createClient: state.createClient,
}));

vi.mock("../packages/cli/src/updateCheck.js", () => ({
  checkForUpdate: vi.fn(async () => null),
  isNpx: vi.fn(() => true),
  isWorkerAgent: vi.fn(() => false),
}));

function command(root: Command, ...names: string[]): Command {
  return names.reduce((parent, name) => {
    const child = parent.commands.find((candidate) => candidate.name() === name);
    if (!child) throw new Error(`Missing command: ${names.join(" ")}`);
    return child;
  }, root);
}

function allCommands(root: Command): Command[] {
  return [root, ...root.commands.flatMap(allCommands)];
}

function commandsWithOutput(root: Command, parentPath: string[] = []): string[] {
  return root.commands.flatMap((child) => {
    const path = [...parentPath, child.name()];
    const ownPath = child.options.some((option) => option.attributeName() === "output") ? [path.join(" ")] : [];
    return [...ownPath, ...commandsWithOutput(child, path)];
  });
}

describe("CLI help and output options", () => {
  let program: Command;

  beforeAll(async () => {
    const parseSpy = vi.spyOn(Command.prototype, "parseAsync").mockImplementation(function (this: Command) {
      state.program = this;
      return Promise.resolve(this);
    });
    try {
      await import("../packages/cli/src/index.js");
    } finally {
      parseSpy.mockRestore();
    }
    if (!state.program) throw new Error("CLI program was not captured");
    program = state.program;
  });

  beforeEach(() => {
    state.createClient.mockReset();
  });

  it("generates top-level help from the registered Commander command tree", () => {
    const help = program.helpInformation();
    const expectedCommands = [
      "config",
      "auth",
      "task",
      "agent",
      "get",
      "describe",
      "create",
      "update",
      "delete",
      "apply",
      "wait",
      "start",
      "stop",
      "restart",
      "status",
      "logs",
      "upgrade",
    ];

    expect(help).toContain("Usage: ak [options] [command]");
    expect(program.commands.map((candidate) => candidate.name())).toEqual(expectedCommands);
    for (const name of expectedCommands) {
      expect(help).toMatch(new RegExp(`^  ${name}(?: |$)`, "m"));
    }
  });

  it("groups top-level help commands by workflow and leaves implicit help in Commands", () => {
    const helpLines = program.helpInformation().split("\n");
    const expectedGroups = new Map([
      ["Configuration:", ["config", "auth"]],
      ["Task Lifecycle:", ["task"]],
      ["Agent:", ["agent"]],
      ["Resources:", ["get", "describe", "create", "update", "delete", "apply"]],
      ["Wait:", ["wait"]],
      ["Runtime:", ["start", "stop", "restart", "status", "logs"]],
      ["Maintenance:", ["upgrade"]],
      ["Commands:", ["help"]],
    ]);

    const headings = helpLines.filter((line) => expectedGroups.has(line));
    expect(headings).toEqual([...expectedGroups.keys()]);

    for (const [heading, expectedCommands] of expectedGroups) {
      const start = helpLines.indexOf(heading) + 1;
      const endOffset = helpLines.slice(start).findIndex((line) => /^[^\s].*:$/.test(line));
      const end = endOffset === -1 ? helpLines.length : start + endOffset;
      const commands = helpLines
        .slice(start, end)
        .map((line) => line.match(/^ {2}([a-z][a-z-]*)(?:\s|\[)/)?.[1])
        .filter((name): name is string => Boolean(name));

      expect(commands, heading).toEqual(expectedCommands);
    }
  });

  it("does not advertise output as a global option", () => {
    expect(program.options.some((option) => option.attributeName() === "output")).toBe(false);
    expect(program.helpInformation()).not.toContain("--output");
  });

  it("shows the same output choices on every output-capable subcommand", () => {
    const expectedPaths = [
      "task claim",
      "task cancel",
      "task review",
      "task complete",
      "task reject",
      "task release",
      "agent diff",
      "get board",
      "get label",
      "get task",
      "get session",
      "get maintainer",
      "get agent",
      "get subagent",
      "get model",
      "get repo",
      "get note",
      "describe task",
      "describe agent",
      "describe board",
      "create board",
      "create task",
      "create label",
      "create maintainer",
      "create agent",
      "create subagent",
      "create repo",
      "update board",
      "update task",
      "update label",
      "update agent",
      "update subagent",
      "update maintainer",
      "delete label",
      "delete board",
      "delete task",
      "delete agent",
      "delete subagent",
      "delete repo",
      "delete maintainer",
      "apply",
    ];

    expect(commandsWithOutput(program).sort()).toEqual([...expectedPaths].sort());
    for (const path of expectedPaths) {
      const outputOption = command(program, ...path.split(" ")).options.find((option) => option.attributeName() === "output");
      expect(outputOption?.argChoices, path).toEqual(["text", "json", "yaml", "wide"]);
    }
    expect(command(program, "get", "task").helpInformation()).toContain('(choices: "text", "json", "yaml", "wide")');
  });

  it("rejects an invalid output choice before creating an API client", async () => {
    for (const candidate of allCommands(program)) {
      candidate.exitOverride();
      candidate.configureOutput({ writeErr: () => {} });
    }

    await expect(program.parseAsync(["node", "ak", "get", "task", "-o", "xml"])).rejects.toMatchObject({
      code: "commander.invalidArgument",
    });
    expect(state.createClient).not.toHaveBeenCalled();
  });
});
