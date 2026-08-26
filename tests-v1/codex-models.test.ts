// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock("node:fs", () => fsMock);

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockImplementation(() => {
    throw new Error("missing");
  }),
}));

vi.mock("@openai/codex-sdk", () => ({
  Codex: vi.fn(),
}));

import { homedir } from "node:os";
import { join } from "node:path";
import { codexProvider } from "../packages/cli/src/providers/codex.js";

const MODELS_CACHE_PATH = join(homedir(), ".codex", "models_cache.json");

describe("codexProvider.listModels", () => {
  beforeEach(() => {
    fsMock.existsSync.mockReset();
    fsMock.readFileSync.mockReset();
    fsMock.readdirSync.mockReset();
  });

  it("requires the Codex CLI models cache", async () => {
    fsMock.existsSync.mockReturnValue(false);

    await expect(codexProvider.listModels?.()).rejects.toThrow("Codex models cache not found; start Codex CLI once to populate it");
    expect(fsMock.existsSync).toHaveBeenCalledWith(MODELS_CACHE_PATH);
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });

  it("filters hidden models, sorts by priority, and normalizes cache fields", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({
        models: [
          {
            slug: "hidden-model",
            display_name: "Hidden Model",
            visibility: "hide",
            priority: -1,
            context_window: 1,
          },
          {
            slug: "gpt-5.4",
            display_name: "GPT-5.4",
            description: "Strong model for everyday coding.",
            visibility: "list",
            priority: 20,
            context_window: 272000,
            supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
            default_reasoning_level: "medium",
            support_verbosity: true,
          },
          {
            slug: "gpt-5.5",
            display_name: "GPT-5.5",
            description: "Frontier model for complex work.",
            visibility: "list",
            priority: 10,
            context_window: 400000,
            supported_reasoning_levels: [{ effort: "medium" }, { effort: "xhigh" }],
            default_reasoning_level: "xhigh",
          },
        ],
      }),
    );

    const models = await codexProvider.listModels?.();

    expect(fsMock.readFileSync).toHaveBeenCalledWith(MODELS_CACHE_PATH, "utf-8");
    expect(models).toEqual([
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        description: "Frontier model for complex work.",
        context_window: 400000,
        supports: {
          verbosity: false,
        },
        supported_reasoning_efforts: ["medium", "xhigh"],
        default_reasoning_effort: "xhigh",
      },
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        description: "Strong model for everyday coding.",
        context_window: 272000,
        supports: {
          verbosity: true,
        },
        supported_reasoning_efforts: ["low", "medium", "high"],
        default_reasoning_effort: "medium",
      },
    ]);
  });
});
