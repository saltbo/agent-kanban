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

const codexMocks = vi.hoisted(() => ({
  startThread: vi.fn(),
  resumeThread: vi.fn(),
}));

vi.mock("@openai/codex-sdk", () => ({
  Codex: vi.fn(() => ({ startThread: codexMocks.startThread, resumeThread: codexMocks.resumeThread })),
}));

import { codexProvider } from "../packages/cli/src/providers/codex.js";

function lastThreadOpts(): Record<string, unknown> {
  return codexMocks.startThread.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe("codexProvider.execute — reasoning effort", () => {
  beforeEach(() => {
    codexMocks.startThread.mockReset();
    codexMocks.resumeThread.mockReset();
    fsMock.readFileSync.mockReset();
    // No ~/.codex/auth.json in tests — readAccessToken() falls back to null.
    fsMock.readFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    codexMocks.startThread.mockReturnValue({
      runStreamed: vi.fn().mockResolvedValue({ events: (async function* () {})() }),
    });
  });

  it.each(["minimal", "low", "medium", "high", "xhigh"] as const)("passes modelReasoningEffort=%s through to the thread options", async (effort) => {
    await codexProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx", model: "o3", reasoningEffort: effort });

    expect(codexMocks.startThread).toHaveBeenCalledTimes(1);
    expect(lastThreadOpts().modelReasoningEffort).toBe(effort);
  });

  it("omits modelReasoningEffort for an unrecognized reasoningEffort value", async () => {
    await codexProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx", model: "o3", reasoningEffort: "extreme" });

    expect(lastThreadOpts()).not.toHaveProperty("modelReasoningEffort");
  });

  // max is a claude-only effort level — the codex provider must drop it.
  it("omits modelReasoningEffort for the claude-only value max", async () => {
    await codexProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx", model: "o3", reasoningEffort: "max" });

    expect(lastThreadOpts()).not.toHaveProperty("modelReasoningEffort");
  });

  it("omits modelReasoningEffort when reasoningEffort is not provided", async () => {
    await codexProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx", model: "o3" });

    expect(lastThreadOpts()).not.toHaveProperty("modelReasoningEffort");
  });

  it("passes reasoning effort through on resumeThread too", async () => {
    codexMocks.resumeThread.mockReturnValue({
      runStreamed: vi.fn().mockResolvedValue({ events: (async function* () {})() }),
    });

    await codexProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx", model: "o3", resume: true, reasoningEffort: "low" });

    expect(codexMocks.resumeThread).toHaveBeenCalledTimes(1);
    const threadOpts = codexMocks.resumeThread.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(threadOpts.modelReasoningEffort).toBe("low");
    expect(codexMocks.startThread).not.toHaveBeenCalled();
  });
});
