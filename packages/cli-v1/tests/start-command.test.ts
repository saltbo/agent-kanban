// @vitest-environment node

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
  getCredentials: vi.fn(),
  setCurrent: vi.fn(),
}));

vi.mock("../src/config.js", () => config);
vi.mock("../src/session/store.js", () => ({ isPidAlive: vi.fn(() => false) }));

const { registerRestartCommand, registerStartCommand } = await import("../src/commands/start.js");

function program() {
  const value = new Command();
  value.exitOverride();
  registerStartCommand(value);
  registerRestartCommand(value);
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  config.getCredentials.mockImplementation(() => {
    throw new Error("missing Realmroot login");
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ak start Realmroot authentication", () => {
  it("does not accept the removed static API-key option", async () => {
    await expect(program().parseAsync(["start", "--api-key", "ak_removed"], { from: "user" })).rejects.toMatchObject({
      code: "commander.unknownOption",
    });
  });

  it("requires a configured Realmroot login", async () => {
    await expect(program().parseAsync(["start"], { from: "user" })).rejects.toThrow("exit:1");
    expect(console.error).toHaveBeenCalledWith("Realmroot login required. Run ak auth login --api-url <url>.");
  });

  it("selects only an API URL that already has a Realmroot environment", async () => {
    config.setCurrent.mockImplementation(() => {
      throw new Error("not logged in");
    });

    await expect(program().parseAsync(["start", "--api-url", "https://ak.example.test"], { from: "user" })).rejects.toThrow("exit:1");
    expect(config.setCurrent).toHaveBeenCalledWith("https://ak.example.test");
    expect(console.error).toHaveBeenCalledWith(
      "No Realmroot login for https://ak.example.test. Run ak auth login --api-url https://ak.example.test.",
    );
  });
});
