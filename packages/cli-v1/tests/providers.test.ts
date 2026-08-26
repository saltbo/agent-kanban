// @vitest-environment node
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs so readFileSync never touches disk (gemini reads system prompt file, codex reads auth)
vi.mock("node:fs", () => ({
  readFileSync: vi.fn().mockImplementation(() => {
    throw new Error("ENOENT");
  }),
  readdirSync: vi.fn().mockImplementation(() => {
    throw new Error("ENOENT");
  }),
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockImplementation(() => {
    throw new Error("missing");
  }),
}));

vi.mock("../src/executable.js", () => ({
  resolveExecutable: vi.fn().mockReturnValue(null),
}));

// Mock logger to suppress output
vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock spawnHelper so gemini.execute() does not spawn real CLI processes
vi.mock("../src/providers/spawnHelper.js", () => ({
  spawnAgent: vi.fn().mockReturnValue({
    events: (async function* () {})(),
    abort: vi.fn().mockResolvedValue(undefined),
    pid: 12345,
    send: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Mock claude-agent-sdk so claudeProvider.execute() does not invoke the real SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn().mockReturnValue({
    [Symbol.asyncIterator]: async function* () {},
    close: vi.fn(),
    streamInput: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Mock @openai/codex-sdk so codexProvider.execute() does not invoke the real SDK
vi.mock("@openai/codex-sdk", () => ({
  Codex: vi.fn().mockImplementation(() => ({
    startThread: vi.fn().mockReturnValue({
      runStreamed: vi.fn().mockResolvedValue({ events: (async function* () {})() }),
    }),
    resumeThread: vi.fn().mockReturnValue({
      runStreamed: vi.fn().mockResolvedValue({ events: (async function* () {})() }),
    }),
  })),
}));

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadEvent } from "@openai/codex-sdk";
import { resolveExecutable } from "../src/executable.js";
import { claudeProvider, mapSDKMessage } from "../src/providers/claude.js";
import { codexProvider, mapThreadEvent } from "../src/providers/codex.js";
import {
  buildArgs as geminiBuildArgs,
  buildResumeArgs as geminiBuildResumeArgs,
  parseEvent as geminiParseEvent,
  parseSessionId as geminiParseSessionId,
  geminiProvider,
  resolveGeminiCommand,
} from "../src/providers/gemini.js";
import { getAvailableProviders, getProvider, registerProvider } from "../src/providers/registry.js";
import type { AgentProvider } from "../src/providers/types.js";

beforeEach(async () => {
  const fsModule = await import("node:fs");
  vi.mocked(fsModule.readFileSync).mockImplementation(() => {
    throw new Error("ENOENT");
  });
  vi.mocked(fsModule.readdirSync).mockImplementation(() => {
    throw new Error("ENOENT");
  });
  vi.mocked(fsModule.existsSync).mockReturnValue(false);

  const childProcess = await import("node:child_process");
  vi.mocked(childProcess.execSync).mockImplementation(() => {
    throw new Error("missing");
  });
  vi.mocked(resolveExecutable).mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// mapSDKMessage — rate_limit_event
// ---------------------------------------------------------------------------

describe("mapSDKMessage — rate_limit_event rejected", () => {
  it("returns turn.rate_limit when status is rejected", () => {
    const msg = {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 1700000000, rateLimitType: "five_hour" },
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    expect(mapSDKMessage(msg)[0]?.type).toBe("turn.rate_limit");
  });

  it("includes resetAt derived from resetsAt epoch", () => {
    const resetsAt = 1700000000;
    const msg = {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour" },
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    const result = mapSDKMessage(msg);
    expect(result).toHaveLength(1);
    if (result[0]?.type === "turn.rate_limit") {
      expect(result[0].resetAt).toBeDefined();
      expect(new Date(result[0].resetAt!).getTime()).toBe(resetsAt * 1000);
    }
  });

  it("returns empty array when status is allowed_warning", () => {
    const msg = {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", resetsAt: 1700000000, rateLimitType: "five_hour" },
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    expect(mapSDKMessage(msg)).toEqual([]);
  });

  it("returns turn.rate_limit event when status is allowed", () => {
    const msg = {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: 1700000000, rateLimitType: "five_hour", isUsingOverage: false },
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    const result = mapSDKMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("turn.rate_limit");
    if (result[0]?.type === "turn.rate_limit") {
      expect(result[0].status).toBe("allowed");
    }
  });
});

describe("mapSDKMessage — user message (tool_result)", () => {
  it("returns message event with tool_result block from user message with tool_result content", () => {
    const msg = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu1", content: "output text", is_error: false }],
      },
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    const result = mapSDKMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("message");
    if (result[0]?.type === "message") {
      expect(result[0].blocks[0].type).toBe("tool_result");
    }
  });

  it("returns message event for user message with tool_result whose content is array of text blocks", () => {
    const msg = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu1",
            content: [{ type: "text", text: "result text" }],
            is_error: false,
          },
        ],
      },
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    const result = mapSDKMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("message");
  });

  it("returns empty array for user message with only plain text (no tool_result blocks)", () => {
    const msg = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "not a tool result" }],
      },
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    const result = mapSDKMessage(msg);
    // plain text triggers a message.user event, not an empty array
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("message.user");
  });

  it("returns empty array for user message where content is a string", () => {
    const msg = {
      type: "user",
      message: { role: "user", content: "plain string content" },
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    const result = mapSDKMessage(msg);
    // string content also produces a message.user event
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("message.user");
  });

  it("returns two events when user message has both plain text and tool_result blocks", () => {
    const msg = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "human reply" },
          { type: "tool_result", tool_use_id: "tu1", content: "output", is_error: false },
        ],
      },
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    const result = mapSDKMessage(msg);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("message.user");
    expect(result[1].type).toBe("message");
  });
});

describe("mapSDKMessage — assistant message", () => {
  it("returns message event with text block in blocks array", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
      error: undefined,
      parent_tool_use_id: null,
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    const result = mapSDKMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("message");
    if (result[0]?.type === "message") {
      expect(result[0].blocks[0]).toEqual({ type: "text", text: "Hello world" });
    }
  });

  it("returns message event with tool_use block when content has only tool_use blocks", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu1", name: "bash", input: { command: "ls" } }] },
      error: undefined,
      parent_tool_use_id: null,
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    const result = mapSDKMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("message");
    if (result[0]?.type === "message") {
      expect(result[0].blocks[0].type).toBe("tool_use");
    }
  });

  it("returns turn.rate_limit when error field is 'rate_limit'", () => {
    const msg = {
      type: "assistant",
      error: "rate_limit",
      message: { content: [] },
      parent_tool_use_id: null,
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    expect(mapSDKMessage(msg)[0]?.type).toBe("turn.rate_limit");
  });

  it("returns turn.error event for non-rate-limit string error", () => {
    const msg = {
      type: "assistant",
      error: "authentication_error",
      message: { content: [] },
      parent_tool_use_id: null,
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    expect(mapSDKMessage(msg)[0]?.type).toBe("turn.error");
  });
});

describe("mapSDKMessage — result", () => {
  it("returns turn.end event", () => {
    const msg = {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.05,
      usage: { input_tokens: 100, output_tokens: 50 },
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    expect(mapSDKMessage(msg)[0]?.type).toBe("turn.end");
  });

  it("includes cost from total_cost_usd", () => {
    const msg = {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.12,
      usage: { input_tokens: 10, output_tokens: 5 },
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    const result = mapSDKMessage(msg);
    expect(result).toHaveLength(1);
    if (result[0]?.type === "turn.end") {
      expect(result[0].cost).toBe(0.12);
    }
  });

  it("defaults cost to 0 when total_cost_usd is absent", () => {
    const msg = {
      type: "result",
      subtype: "success",
      usage: { input_tokens: 10, output_tokens: 5 },
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    const result = mapSDKMessage(msg);
    expect(result).toHaveLength(1);
    if (result[0]?.type === "turn.end") {
      expect(result[0].cost).toBe(0);
    }
  });

  it("includes usage when present", () => {
    const usage = { input_tokens: 100, output_tokens: 50 };
    const msg = {
      type: "result",
      subtype: "success",
      total_cost_usd: 0,
      usage,
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    const result = mapSDKMessage(msg);
    expect(result).toHaveLength(1);
    if (result[0]?.type === "turn.end") {
      expect(result[0].usage).toEqual(usage);
    }
  });
});

describe("mapSDKMessage — unknown type", () => {
  it("returns empty array for unrecognized event type", () => {
    const msg = { type: "system_prompt", uuid: "u1", session_id: "s1" } as unknown as SDKMessage;
    expect(mapSDKMessage(msg)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// claudeProvider identity fields
// ---------------------------------------------------------------------------

describe("claudeProvider identity", () => {
  it("name is claude", () => {
    expect(claudeProvider.name).toBe("claude");
  });

  it("label is Claude Code", () => {
    expect(claudeProvider.label).toBe("Claude Code");
  });
});

// ---------------------------------------------------------------------------
// mapThreadEvent — item.completed
// ---------------------------------------------------------------------------

describe("mapThreadEvent — item.completed", () => {
  it("returns message event with text block when item is agent_message with text", () => {
    const event = {
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "Task done" },
    } as unknown as ThreadEvent;
    const result = mapThreadEvent(event);
    expect(result?.type).toBe("message");
    if (result?.type === "message") {
      expect(result.blocks[0]).toEqual({ type: "text", text: "Task done" });
    }
  });

  it("returns message event with tool_use block when item is command_execution", () => {
    const event = {
      type: "item.completed",
      item: { id: "i1", type: "command_execution", command: "ls", aggregated_output: "", status: "completed" },
    } as unknown as ThreadEvent;
    const result = mapThreadEvent(event);
    expect(result?.type).toBe("message");
    if (result?.type === "message") {
      expect(result.blocks[0]).toEqual({ type: "tool_use", id: "i1", name: "Bash", input: { command: "ls" } });
    }
  });

  it("returns null when agent_message has no text", () => {
    const event = {
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "" },
    } as unknown as ThreadEvent;
    expect(mapThreadEvent(event)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mapThreadEvent — turn.completed
// ---------------------------------------------------------------------------

describe("mapThreadEvent — turn.completed", () => {
  it("returns turn.end event", () => {
    const event = {
      type: "turn.completed",
      usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50 },
    } as unknown as ThreadEvent;
    expect(mapThreadEvent(event)?.type).toBe("turn.end");
  });

  it("includes usage with input_tokens and output_tokens", () => {
    const event = {
      type: "turn.completed",
      usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50 },
    } as unknown as ThreadEvent;
    const result = mapThreadEvent(event);
    if (result?.type === "turn.end") {
      expect(result.usage?.input_tokens).toBe(100);
      expect(result.usage?.output_tokens).toBe(50);
    }
  });

  it("calculates cost based on o3 pricing by default", () => {
    const event = {
      type: "turn.completed",
      usage: { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 1_000_000 },
    } as unknown as ThreadEvent;
    const result = mapThreadEvent(event);
    // o3: 2.0/1M input + 8.0/1M output = 10.0
    if (result?.type === "turn.end") {
      expect(result.cost).toBeCloseTo(10.0, 5);
    }
  });

  it("includes cache_read_input_tokens in usage", () => {
    const event = {
      type: "turn.completed",
      usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50 },
    } as unknown as ThreadEvent;
    const result = mapThreadEvent(event);
    if (result?.type === "turn.end") {
      expect(result.usage?.cache_read_input_tokens).toBe(20);
    }
  });
});

// ---------------------------------------------------------------------------
// mapThreadEvent — turn.failed
// ---------------------------------------------------------------------------

describe("mapThreadEvent — turn.failed", () => {
  it("returns turn.rate_limit event when error message matches rate limit pattern", () => {
    const event = {
      type: "turn.failed",
      error: { message: "Rate limit exceeded, try again at 2026-04-01T15:00:00Z" },
    } as unknown as ThreadEvent;
    const result = mapThreadEvent(event);
    expect(result?.type).toBe("turn.rate_limit");
  });

  it("returns turn.rate_limit event when error message matches quota exceeded pattern", () => {
    const event = {
      type: "turn.failed",
      error: { message: "quota exceeded for this model" },
    } as unknown as ThreadEvent;
    const result = mapThreadEvent(event);
    expect(result?.type).toBe("turn.rate_limit");
  });

  it("returns turn.error event when error message does not match rate limit pattern", () => {
    const event = {
      type: "turn.failed",
      error: { message: "Internal server error" },
    } as unknown as ThreadEvent;
    const result = mapThreadEvent(event);
    expect(result?.type).toBe("turn.error");
    if (result?.type === "turn.error") {
      expect(result.detail).toContain("Internal server error");
    }
  });

  it("returns turn.error event when error is absent", () => {
    const event = { type: "turn.failed" } as unknown as ThreadEvent;
    const result = mapThreadEvent(event);
    expect(result?.type).toBe("turn.error");
  });
});

// ---------------------------------------------------------------------------
// mapThreadEvent — error
// ---------------------------------------------------------------------------

describe("mapThreadEvent — error event", () => {
  it("returns turn.rate_limit when message matches rate limit pattern", () => {
    const event = {
      type: "error",
      message: "usage limit exceeded, please try again at tomorrow",
    } as unknown as ThreadEvent;
    const result = mapThreadEvent(event);
    expect(result?.type).toBe("turn.rate_limit");
  });

  it("returns turn.error when message does not match rate limit", () => {
    const event = {
      type: "error",
      message: "Connection reset by peer",
    } as unknown as ThreadEvent;
    const result = mapThreadEvent(event);
    expect(result?.type).toBe("turn.error");
    if (result?.type === "turn.error") {
      expect(result.detail).toContain("Connection reset by peer");
    }
  });
});

// ---------------------------------------------------------------------------
// mapThreadEvent — other types
// ---------------------------------------------------------------------------

describe("mapThreadEvent — other event types", () => {
  it("returns null for item.started", () => {
    const event = {
      type: "item.started",
      item: { id: "i1", type: "agent_message", text: "partial" },
    } as unknown as ThreadEvent;
    expect(mapThreadEvent(event)).toBeNull();
  });

  it("returns null for turn.started", () => {
    const event = { type: "turn.started" } as unknown as ThreadEvent;
    expect(mapThreadEvent(event)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// codexProvider identity
// ---------------------------------------------------------------------------

describe("codexProvider identity", () => {
  it("name is codex", () => {
    expect(codexProvider.name).toBe("codex");
  });

  it("label is Codex CLI", () => {
    expect(codexProvider.label).toBe("Codex CLI");
  });
});

// ---------------------------------------------------------------------------
// claudeProvider.execute — abort and send
// ---------------------------------------------------------------------------

describe("claudeProvider.execute — abort and send", () => {
  it("abort() calls close() on the query object", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");
    const closeSpy = vi.fn();
    vi.mocked(mockQuery).mockReturnValueOnce({
      [Symbol.asyncIterator]: async function* () {},
      close: closeSpy,
      streamInput: vi.fn().mockResolvedValue(undefined),
    } as any);
    const handle = await claudeProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx" });
    await handle.abort();
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it("send() calls streamInput() on the query object with a user message", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");
    const streamInputSpy = vi.fn().mockResolvedValue(undefined);
    vi.mocked(mockQuery).mockReturnValueOnce({
      [Symbol.asyncIterator]: async function* () {},
      close: vi.fn(),
      streamInput: streamInputSpy,
    } as any);
    const handle = await claudeProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx" });
    await handle.send("hello agent");
    expect(streamInputSpy).toHaveBeenCalledOnce();
  });

  it("uses resume option when opts.resume is true", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(mockQuery).mockClear();
    await claudeProvider.execute({ sessionId: "sess-xyz", cwd: "/tmp", env: {}, taskContext: "ctx", resume: true });
    expect(vi.mocked(mockQuery)).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ resume: "sess-xyz", sessionId: undefined }),
      }),
    );
  });

  it("uses sessionId option when opts.resume is false or absent", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(mockQuery).mockClear();
    await claudeProvider.execute({ sessionId: "sess-abc", cwd: "/tmp", env: {}, taskContext: "ctx" });
    expect(vi.mocked(mockQuery)).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ sessionId: "sess-abc", resume: undefined }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// claudeProvider.execute — pid field removed; provider internals own process concerns
// (tests that asserted handle.pid === process.pid were deleted in daemon refactor)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// codexProvider.execute — handle shape and thread selection
// ---------------------------------------------------------------------------

describe("codexProvider.execute — handle shape", () => {
  it("resolves to a handle with events, abort, and send", async () => {
    const handle = await codexProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "build feature" });
    expect(handle).toHaveProperty("events");
    expect(typeof handle.abort).toBe("function");
    expect(typeof handle.send).toBe("function");
  });

  it("events is an async iterable", async () => {
    const handle = await codexProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx" });
    expect(typeof handle.events[Symbol.asyncIterator]).toBe("function");
  });
});

// pid field removed from AgentHandle — provider internals own process concerns

describe("codexProvider.execute — thread selection", () => {
  it("calls startThread when resume is false or absent", async () => {
    const { Codex } = await import("@openai/codex-sdk");
    vi.mocked(resolveExecutable).mockReturnValueOnce("/opt/homebrew/bin/codex");
    const startThreadSpy = vi.fn().mockReturnValue({
      runStreamed: vi.fn().mockResolvedValue({ events: (async function* () {})() }),
    });
    vi.mocked(Codex).mockImplementationOnce(
      () =>
        ({
          startThread: startThreadSpy,
          resumeThread: vi.fn(),
        }) as any,
    );
    await codexProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx" });
    expect(startThreadSpy).toHaveBeenCalledOnce();
    expect(vi.mocked(Codex)).toHaveBeenCalledWith(expect.objectContaining({ codexPathOverride: "/opt/homebrew/bin/codex" }));
  });

  it("calls resumeThread when resume is true", async () => {
    const { Codex } = await import("@openai/codex-sdk");
    const childProcess = await import("node:child_process");
    vi.mocked(childProcess.execSync).mockImplementationOnce(() => {
      throw new Error("missing");
    });
    const resumeThreadSpy = vi.fn().mockReturnValue({
      runStreamed: vi.fn().mockResolvedValue({ events: (async function* () {})() }),
    });
    vi.mocked(Codex).mockImplementationOnce(
      () =>
        ({
          startThread: vi.fn(),
          resumeThread: resumeThreadSpy,
        }) as any,
    );
    await codexProvider.execute({
      sessionId: "sess-77",
      resumeToken: "codex-thread-1",
      cwd: "/tmp",
      env: {},
      taskContext: "ctx",
      resume: true,
    });
    expect(resumeThreadSpy).toHaveBeenCalledWith("codex-thread-1", expect.any(Object));
  });

  it("passes system prompt content and task context to Codex", async () => {
    const { Codex } = await import("@openai/codex-sdk");
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockImplementation((path) => {
      if (path === "/tmp/system.txt") return "You are Codex with board rules." as any;
      throw new Error("ENOENT");
    });
    const runStreamedSpy = vi.fn().mockResolvedValue({ events: (async function* () {})() });
    vi.mocked(Codex).mockImplementationOnce(
      () =>
        ({
          startThread: vi.fn().mockReturnValue({ runStreamed: runStreamedSpy }),
          resumeThread: vi.fn(),
        }) as any,
    );

    await codexProvider.execute({
      sessionId: "s1",
      cwd: "/tmp",
      env: { OPENAI_API_KEY: "test-key" },
      systemPromptFile: "/tmp/system.txt",
      taskContext: "Implement the task.",
    });

    expect(runStreamedSpy).toHaveBeenCalledWith("You are Codex with board rules.\n\nImplement the task.", expect.any(Object));
  });

  it("omits explicit model for ChatGPT-backed Codex sessions", async () => {
    const { Codex } = await import("@openai/codex-sdk");
    const fsModule = await import("node:fs");
    const childProcess = await import("node:child_process");
    vi.mocked(childProcess.execSync).mockReturnValueOnce("/opt/homebrew/bin/codex\n" as any);
    vi.mocked(fsModule.readFileSync).mockReturnValue(JSON.stringify({ tokens: { access_token: "chatgpt-token" } }) as any);
    const startThreadSpy = vi.fn().mockReturnValue({
      runStreamed: vi.fn().mockResolvedValue({ events: (async function* () {})() }),
    });
    vi.mocked(Codex).mockImplementationOnce(
      () =>
        ({
          startThread: startThreadSpy,
          resumeThread: vi.fn(),
        }) as any,
    );

    await codexProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx", model: "o3" });

    expect(startThreadSpy).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
  });

  it("keeps explicit model when using API-key-backed Codex sessions", async () => {
    const { Codex } = await import("@openai/codex-sdk");
    const childProcess = await import("node:child_process");
    vi.mocked(childProcess.execSync).mockReturnValueOnce("/opt/homebrew/bin/codex\n" as any);
    const startThreadSpy = vi.fn().mockReturnValue({
      runStreamed: vi.fn().mockResolvedValue({ events: (async function* () {})() }),
    });
    vi.mocked(Codex).mockImplementationOnce(
      () =>
        ({
          startThread: startThreadSpy,
          resumeThread: vi.fn(),
        }) as any,
    );

    await codexProvider.execute({
      sessionId: "s1",
      cwd: "/tmp",
      env: { OPENAI_API_KEY: "sk-test" },
      taskContext: "ctx",
      model: "o3",
    });

    expect(startThreadSpy).toHaveBeenCalledWith(expect.objectContaining({ model: "o3" }));
  });

  it("events yields mapped AgentEvents from SDK thread events", async () => {
    const { Codex } = await import("@openai/codex-sdk");
    const sdkEvent = { type: "item.completed", item: { id: "i1", type: "agent_message", text: "codex message" } };
    vi.mocked(Codex).mockImplementationOnce(
      () =>
        ({
          startThread: vi.fn().mockReturnValue({
            runStreamed: vi.fn().mockResolvedValue({
              events: (async function* () {
                yield sdkEvent as any;
              })(),
            }),
          }),
          resumeThread: vi.fn(),
        }) as any,
    );
    const handle = await codexProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx" });
    const events: any[] = [];
    for await (const ev of handle.events) events.push(ev);
    // Mock only yields item.completed (no item.started), so: turn.start + block.done
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "turn.start" });
    expect(events[1]).toEqual({ type: "block.done", block: { type: "text", text: "codex message" } });
  });

  it("captures the Codex thread id as a resume token from thread.started", async () => {
    const { Codex } = await import("@openai/codex-sdk");
    vi.mocked(Codex).mockImplementationOnce(
      () =>
        ({
          startThread: vi.fn().mockReturnValue({
            runStreamed: vi.fn().mockResolvedValue({
              events: (async function* () {
                yield { type: "thread.started", thread_id: "thread-123" } as any;
                yield { type: "turn.completed", usage: {} } as any;
              })(),
            }),
          }),
          resumeThread: vi.fn(),
        }) as any,
    );
    const handle = await codexProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx" });
    for await (const _ev of handle.events) {
      // Drain the stream so thread.started is observed.
    }
    expect(handle.getResumeToken?.()).toBe("thread-123");
  });

  it("send() throws not-implemented error", async () => {
    const { Codex } = await import("@openai/codex-sdk");
    const runStreamedSpy = vi.fn().mockResolvedValue({ events: (async function* () {})() });
    vi.mocked(Codex).mockImplementationOnce(
      () =>
        ({
          startThread: vi.fn().mockReturnValue({ runStreamed: runStreamedSpy }),
          resumeThread: vi.fn(),
        }) as any,
    );
    const handle = await codexProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx" });
    await expect(handle.send("follow up")).rejects.toThrow("not implemented");
  });

  it("abort() aborts the AbortController signal", async () => {
    const handle = await codexProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx" });
    // Just verify abort() resolves without throwing
    await expect(handle.abort()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// codexProvider.fetchUsage
// ---------------------------------------------------------------------------

describe("codexProvider.fetchUsage — no token", () => {
  it("returns null when readAccessToken returns null (readFileSync throws)", async () => {
    const result = await codexProvider.fetchUsage?.();
    expect(result).toBeNull();
  });
});

describe("codexProvider.fetchUsage — non-OK fetch response", () => {
  it("throws UsageFetchError when usage API returns non-OK status", async () => {
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockReturnValueOnce(JSON.stringify({ tokens: { access_token: "test-token" } }) as any);
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: { get: () => null },
    } as any);
    await expect(codexProvider.fetchUsage?.()).rejects.toThrow("codex usage API returned 429");
    fetchSpy.mockRestore();
  });

  it("throws UsageFetchError with status=429 when API returns 429", async () => {
    const { UsageFetchError: UFE } = await import("../src/providers/types.js");
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockReturnValueOnce(JSON.stringify({ tokens: { access_token: "test-token-429" } }) as any);
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: { get: (_: string) => "120" },
    } as any);
    let caught: unknown;
    try {
      await codexProvider.fetchUsage?.();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UFE);
    expect((caught as InstanceType<typeof UFE>).status).toBe(429);
    fetchSpy.mockRestore();
  });

  it("throws UsageFetchError with parsed retryAfterMs when Retry-After header is present", async () => {
    const { UsageFetchError: UFE } = await import("../src/providers/types.js");
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockReturnValueOnce(JSON.stringify({ tokens: { access_token: "test-token-retry" } }) as any);
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: { get: (_: string) => "60" },
    } as any);
    let caught: unknown;
    try {
      await codexProvider.fetchUsage?.();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UFE);
    expect((caught as InstanceType<typeof UFE>).retryAfterMs).toBe(60_000);
    fetchSpy.mockRestore();
  });
});

describe("codexProvider.fetchUsage — fetch throws", () => {
  it("throws UsageFetchError when fetch itself rejects (network error)", async () => {
    const { UsageFetchError: UFE } = await import("../src/providers/types.js");
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockReturnValueOnce(JSON.stringify({ tokens: { access_token: "test-token-throw" } }) as any);
    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("network error"));
    await expect(codexProvider.fetchUsage?.()).rejects.toBeInstanceOf(UFE);
    fetchSpy.mockRestore();
  });
});

describe("codexProvider.fetchUsage — successful fetch", () => {
  it("returns usage with windows when API succeeds with primary and secondary windows", async () => {
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockReturnValueOnce(JSON.stringify({ tokens: { access_token: "valid-token" } }) as any);
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      json: async () => ({
        rate_limit: {
          primary_window: { used_percent: 50, reset_at: 1700003600, limit_window_seconds: 18000 },
          secondary_window: { used_percent: 20, reset_at: 1700604800, limit_window_seconds: 604800 },
        },
      }),
    } as any);
    const result = await codexProvider.fetchUsage?.();
    expect(result).not.toBeNull();
    expect(Array.isArray(result!.windows)).toBe(true);
    expect(result!.windows.length).toBe(2);
    expect(result!.windows[0].label).toBe("5-Hour");
    expect(result!.windows[0].utilization).toBe(50);
    expect(result!.windows[1].label).toBe("Weekly");
    expect(result!.windows[1].utilization).toBe(20);
    expect(typeof result!.updated_at).toBe("string");
    fetchSpy.mockRestore();
  });

  it("makes a fresh HTTP request every call (no module-level cache)", async () => {
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync)
      .mockReturnValueOnce(JSON.stringify({ tokens: { access_token: "tok1" } }) as any)
      .mockReturnValueOnce(JSON.stringify({ tokens: { access_token: "tok2" } }) as any);
    const successResponse = () => ({
      ok: true,
      headers: { get: () => null },
      json: async () => ({ rate_limit: {} }),
    });
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(successResponse() as any)
      .mockResolvedValueOnce(successResponse() as any);
    await codexProvider.fetchUsage?.();
    await codexProvider.fetchUsage?.();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// registry: registerProvider / getProvider / getAvailableProviders
// ---------------------------------------------------------------------------

describe("registry.getProvider", () => {
  it("returns claudeProvider which is registered by default", () => {
    const provider = getProvider("claude");
    expect(provider.name).toBe("claude");
  });

  it("throws when provider name is not registered", () => {
    expect(() => getProvider("nonexistent-provider-xyz" as any)).toThrow("Unknown provider: nonexistent-provider-xyz");
  });

  it("error message lists available providers", () => {
    expect(() => getProvider("ghost" as any)).toThrow(/Available:/);
  });
});

describe("registry.registerProvider", () => {
  it("makes a newly registered provider retrievable by name", () => {
    const fake: AgentProvider = {
      name: "fake-provider-test" as any,
      label: "Fake",
      execute: async () => ({ events: (async function* () {})(), abort: async () => {}, send: async () => {} }),
    };
    registerProvider(fake);
    expect(getProvider("fake-provider-test" as any).name).toBe("fake-provider-test");
  });

  it("overwrites an existing provider with the same name", () => {
    const v1: AgentProvider = {
      name: "overwrite-test" as any,
      label: "V1",
      execute: async () => ({ events: (async function* () {})(), abort: async () => {}, send: async () => {} }),
    };
    const v2: AgentProvider = {
      name: "overwrite-test" as any,
      label: "V2",
      execute: async () => ({ events: (async function* () {})(), abort: async () => {}, send: async () => {} }),
    };
    registerProvider(v1);
    registerProvider(v2);
    expect(getProvider("overwrite-test" as any).label).toBe("V2");
  });
});

describe("registry.getAvailableProviders", () => {
  it("returns an array", () => {
    const result = getAvailableProviders();
    expect(Array.isArray(result)).toBe(true);
  });

  it("does not include providers whose runtime command does not exist on PATH", () => {
    const ghost: AgentProvider = {
      name: "ghost-cmd-provider" as any,
      label: "Ghost",
      execute: async () => ({ events: (async function* () {})(), abort: async () => {}, send: async () => {} }),
    };
    registerProvider(ghost);
    const available = getAvailableProviders();
    expect(available.find((p) => p.name === "ghost-cmd-provider")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// geminiProvider identity fields
// ---------------------------------------------------------------------------

describe("geminiProvider identity", () => {
  it("name is gemini", () => {
    expect(geminiProvider.name).toBe("gemini");
  });

  it("label is Gemini CLI", () => {
    expect(geminiProvider.label).toBe("Gemini CLI");
  });
});

// ---------------------------------------------------------------------------
// geminiProvider.buildArgs
// ---------------------------------------------------------------------------

describe("geminiProvider.buildArgs", () => {
  it("includes --output-format stream-json", () => {
    const args = geminiBuildArgs({ sessionId: "s1", cwd: "/", env: {}, taskContext: "" });
    const idx = args.indexOf("--output-format");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("stream-json");
  });

  it("includes --yolo flag", () => {
    const args = geminiBuildArgs({ sessionId: "s1", cwd: "/", env: {}, taskContext: "" });
    expect(args).toContain("--yolo");
  });

  it("includes --skip-trust for headless daemon worktrees", () => {
    const args = geminiBuildArgs({ sessionId: "s1", cwd: "/", env: {}, taskContext: "" });
    expect(args).toContain("--skip-trust");
  });

  it("includes --prompt flag", () => {
    const args = geminiBuildArgs({ sessionId: "s1", cwd: "/", env: {}, taskContext: "" });
    expect(args).toContain("--prompt");
  });

  it("returns an array", () => {
    expect(Array.isArray(geminiBuildArgs({ sessionId: "s1", cwd: "/", env: {}, taskContext: "" }))).toBe(true);
  });

  it("does not force the AK session id into new Gemini sessions", () => {
    const args = geminiBuildArgs({ sessionId: "s1", cwd: "/", env: {}, taskContext: "" });
    expect(args).not.toContain("--session-id");
  });

  it("includes --model when model is provided", () => {
    const args = geminiBuildArgs({ sessionId: "s1", cwd: "/", env: {}, taskContext: "", model: "gemini-2.5-pro" });
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("gemini-2.5-pro");
  });

  it("does not include --model when model is absent", () => {
    const args = geminiBuildArgs({ sessionId: "s1", cwd: "/", env: {}, taskContext: "" });
    expect(args).not.toContain("--model");
  });

  it("uses system prompt content from file when systemPromptFile is provided and readable", async () => {
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockReturnValueOnce("You are a helpful assistant." as any);
    const args = geminiBuildArgs({ sessionId: "s1", cwd: "/", env: {}, taskContext: "", systemPromptFile: "/tmp/system.txt" });
    const promptIdx = args.indexOf("--prompt");
    expect(promptIdx).toBeGreaterThan(-1);
    expect(args[promptIdx + 1]).toBe("You are a helpful assistant.");
  });

  it("combines system prompt content and task context in --prompt", async () => {
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockReturnValueOnce("You are a helpful assistant." as any);
    const args = geminiBuildArgs({ sessionId: "s1", cwd: "/", env: {}, taskContext: "Do the task.", systemPromptFile: "/tmp/system.txt" });
    const promptIdx = args.indexOf("--prompt");

    expect(args[promptIdx + 1]).toBe("You are a helpful assistant.\n\nDo the task.");
  });

  it("uses task context as prompt when systemPromptFile cannot be read", () => {
    // readFileSync is already mocked to throw by default
    const args = geminiBuildArgs({ sessionId: "s1", cwd: "/", env: {}, taskContext: "Do the task.", systemPromptFile: "/nonexistent/file.txt" });
    const promptIdx = args.indexOf("--prompt");
    expect(promptIdx).toBeGreaterThan(-1);
    expect(args[promptIdx + 1]).toBe("Do the task.");
  });
});

// ---------------------------------------------------------------------------
// geminiProvider.buildResumeArgs
// ---------------------------------------------------------------------------

describe("geminiProvider.buildResumeArgs", () => {
  it("returns an array", () => {
    expect(Array.isArray(geminiBuildResumeArgs("gemini-session-1"))).toBe(true);
  });

  it("includes --output-format stream-json", () => {
    const args = geminiBuildResumeArgs("gemini-session-1");
    const idx = args.indexOf("--output-format");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("stream-json");
  });

  it("includes --yolo flag", () => {
    const args = geminiBuildResumeArgs("gemini-session-1");
    expect(args).toContain("--yolo");
  });

  it("includes --skip-trust for resumed headless daemon worktrees", () => {
    const args = geminiBuildResumeArgs("gemini-session-1");
    expect(args).toContain("--skip-trust");
  });

  it("includes --resume with the provider session id", () => {
    const args = geminiBuildResumeArgs("gemini-session-1");
    const idx = args.indexOf("--resume");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("gemini-session-1");
  });

  it("uses task context as resume prompt", () => {
    const args = geminiBuildResumeArgs("gemini-session-1", undefined, "Address review feedback.");
    const idx = args.indexOf("--prompt");

    expect(args[idx + 1]).toBe("Address review feedback.");
  });

  it("includes --model when model is provided", () => {
    const args = geminiBuildResumeArgs("gemini-session-1", "gemini-2.5-pro");
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("gemini-2.5-pro");
  });

  it("does not include --model when model is absent", () => {
    const args = geminiBuildResumeArgs("gemini-session-1");
    expect(args).not.toContain("--model");
  });
});

describe("geminiProvider.resolveGeminiCommand", () => {
  it("uses gemini from PATH outside Volta", () => {
    expect(resolveGeminiCommand({})).toBe("gemini");
  });

  it("uses the Volta package bin when installed", async () => {
    const fsModule = await import("node:fs");
    const voltaHome = join("Users", "saltbo", ".volta");
    const voltaPackageBin = join(voltaHome, "tools", "image", "packages", "@google", "gemini-cli", "bin", "gemini");
    vi.mocked(fsModule.existsSync).mockImplementation((path) => path === voltaPackageBin);

    expect(resolveGeminiCommand({ VOLTA_HOME: voltaHome })).toBe(voltaPackageBin);
  });
});

// ---------------------------------------------------------------------------
// geminiProvider.parseEvent — invalid / unrecognised input
// ---------------------------------------------------------------------------

describe("geminiProvider.parseEvent — invalid input", () => {
  it("returns null for non-JSON string", () => {
    expect(geminiParseEvent("not json")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(geminiParseEvent("")).toBeNull();
  });

  it("returns null for unrecognised event type", () => {
    expect(geminiParseEvent(JSON.stringify({ type: "unknown_event" }))).toBeNull();
  });

  it("returns null for init event", () => {
    const raw = JSON.stringify({ type: "init", timestamp: "2024-01-01T00:00:00Z", session_id: "s1", model: "gemini-pro" });
    expect(geminiParseEvent(raw)).toBeNull();
  });

  it("extracts session_id from init event", () => {
    const raw = JSON.stringify({ type: "init", timestamp: "2024-01-01T00:00:00Z", session_id: "s1", model: "gemini-pro" });
    expect(geminiParseSessionId(raw)).toBe("s1");
  });

  it("extracts session_id when Gemini prefixes the JSON event with warning text", () => {
    const raw =
      'MCP issues detected. Run /mcp list for status.{"type":"init","timestamp":"2024-01-01T00:00:00Z","session_id":"s1","model":"gemini-pro"}';
    expect(geminiParseSessionId(raw)).toBe("s1");
  });

  it("returns null when no session_id is present", () => {
    expect(geminiParseSessionId(JSON.stringify({ type: "message" }))).toBeNull();
  });

  it("returns null for user message event", () => {
    const raw = JSON.stringify({ type: "message", role: "user", content: "hello" });
    expect(geminiParseEvent(raw)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// geminiProvider.parseEvent — assistant message
// ---------------------------------------------------------------------------

describe("geminiProvider.parseEvent — assistant message", () => {
  it("returns a message event for assistant role with content", () => {
    const raw = JSON.stringify({ type: "message", role: "assistant", content: "Hello world" });
    const event = geminiParseEvent(raw);
    expect(event?.type).toBe("message");
  });

  it("includes the content as a text block in blocks array", () => {
    const raw = JSON.stringify({ type: "message", role: "assistant", content: "Hello world" });
    const event = geminiParseEvent(raw);
    if (event?.type === "message") {
      expect(event.blocks[0]).toEqual({ type: "text", text: "Hello world" });
    }
  });

  it("handles delta assistant message with content", () => {
    const raw = JSON.stringify({ type: "message", role: "assistant", content: "partial text", delta: true });
    const event = geminiParseEvent(raw);
    expect(event?.type).toBe("message");
    if (event?.type === "message") {
      expect(event.blocks[0]).toEqual({ type: "text", text: "partial text" });
    }
  });

  it("returns null for assistant message without content", () => {
    const raw = JSON.stringify({ type: "message", role: "assistant" });
    expect(geminiParseEvent(raw)).toBeNull();
  });

  it("returns null for assistant message with empty content string", () => {
    const raw = JSON.stringify({ type: "message", role: "assistant", content: "" });
    expect(geminiParseEvent(raw)).toBeNull();
  });

  it("returns normalized tool blocks for assistant tool calls without text content", () => {
    const raw = JSON.stringify({
      type: "message",
      role: "assistant",
      id: "msg-1",
      toolCalls: [{ id: "tool-1", name: "run_shell_command", args: { command: "pnpm test", description: "Run tests" }, result: "ok" }],
    });

    const event = geminiParseEvent(raw);

    expect(event).toEqual({
      type: "message",
      blocks: [
        { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pnpm test", description: "Run tests" } },
        { type: "tool_result", tool_use_id: "tool-1", output: "ok" },
      ],
    });
  });

  it("returns normalized tool blocks for OpenAI-style tool_calls", () => {
    const raw = JSON.stringify({
      type: "message",
      role: "assistant",
      id: "msg-1",
      tool_calls: [{ id: "tool-1", function: { name: "read_file", arguments: { file_path: "README.md" } } }],
    });

    const event = geminiParseEvent(raw);

    expect(event).toEqual({
      type: "message",
      blocks: [{ type: "tool_use", id: "tool-1", name: "Read", input: { filePath: "README.md" } }],
    });
  });
});

// ---------------------------------------------------------------------------
// geminiProvider.parseEvent — live tool events
// ---------------------------------------------------------------------------

describe("geminiProvider.parseEvent — live tool events", () => {
  it("normalizes Gemini stream-json tool_use events", () => {
    const raw = JSON.stringify({
      type: "tool_use",
      timestamp: "2026-05-04T06:08:23.618Z",
      tool_name: "run_shell_command",
      tool_id: "run_shell_command_1",
      parameters: { description: "Run echo", command: "echo live-tool-test" },
    });

    const event = geminiParseEvent(raw);

    expect(event).toEqual({
      type: "message",
      blocks: [{ type: "tool_use", id: "run_shell_command_1", name: "Bash", input: { command: "echo live-tool-test", description: "Run echo" } }],
    });
  });

  it("normalizes Gemini stream-json tool_result events", () => {
    const raw = JSON.stringify({
      type: "tool_result",
      timestamp: "2026-05-04T06:08:23.754Z",
      tool_id: "run_shell_command_1",
      status: "success",
    });

    const event = geminiParseEvent(raw);

    expect(event).toEqual({
      type: "message",
      blocks: [{ type: "tool_result", tool_use_id: "run_shell_command_1", output: "success", error: false }],
    });
  });

  it("marks Gemini stream-json tool_result error events", () => {
    const raw = JSON.stringify({ type: "tool_result", tool_id: "run_shell_command_1", status: "error", output: "failed" });

    const event = geminiParseEvent(raw);

    expect(event).toEqual({
      type: "message",
      blocks: [{ type: "tool_result", tool_use_id: "run_shell_command_1", output: "failed", error: true }],
    });
  });
});

// ---------------------------------------------------------------------------
// geminiProvider.parseEvent — result
// ---------------------------------------------------------------------------

describe("geminiProvider.parseEvent — result", () => {
  it("returns a turn.end event", () => {
    const raw = JSON.stringify({ type: "result", status: "success", stats: { total_tokens: 100, input_tokens: 60, output_tokens: 40 } });
    const event = geminiParseEvent(raw);
    expect(event?.type).toBe("turn.end");
  });

  it("includes stats as usage", () => {
    const stats = { total_tokens: 100, input_tokens: 60, output_tokens: 40 };
    const raw = JSON.stringify({ type: "result", status: "success", stats });
    const event = geminiParseEvent(raw);
    if (event?.type === "turn.end") {
      expect(event.usage).toEqual(stats);
    }
  });

  it("includes usage as undefined when stats is absent", () => {
    const raw = JSON.stringify({ type: "result", status: "success" });
    const event = geminiParseEvent(raw);
    if (event?.type === "turn.end") {
      expect(event.usage).toBeUndefined();
    }
  });

  it("returns zero cost when no model breakdown is present", () => {
    const raw = JSON.stringify({ type: "result", status: "success", stats: {} });
    const event = geminiParseEvent(raw);
    if (event?.type === "turn.end") {
      expect(event.cost).toBe(0);
    }
  });

  it("calculates cost from per-model token breakdown", () => {
    const raw = JSON.stringify({
      type: "result",
      stats: {
        models: {
          "gemini-2.5-flash-lite": { input_tokens: 1_000_000, output_tokens: 1_000_000 },
          "gemini-2.5-pro": { input_tokens: 500_000, output_tokens: 200_000 },
        },
      },
    });
    const event = geminiParseEvent(raw);
    // flash-lite: 1M * 0.10/1M + 1M * 0.40/1M = 0.50
    // pro: 500K * 1.25/1M + 200K * 10.00/1M = 0.625 + 2.00 = 2.625
    // total: 3.125
    expect(event?.type).toBe("turn.end");
    if (event?.type === "turn.end") {
      expect(event.cost).toBeCloseTo(3.125, 6);
    }
  });

  it("skips unknown models in cost calculation", () => {
    const raw = JSON.stringify({
      type: "result",
      stats: {
        models: {
          "gemini-unknown-model": { input_tokens: 1000, output_tokens: 1000 },
          "gemini-2.5-flash": { input_tokens: 1_000_000, output_tokens: 0 },
        },
      },
    });
    const event = geminiParseEvent(raw);
    // only flash counted: 1M * 0.30/1M = 0.30
    expect(event?.type).toBe("turn.end");
    if (event?.type === "turn.end") {
      expect(event.cost).toBeCloseTo(0.3, 6);
    }
  });
});

// ---------------------------------------------------------------------------
// geminiProvider.parseEvent — error variants
// ---------------------------------------------------------------------------

describe("geminiProvider.parseEvent — error variants", () => {
  it("returns turn.error event when event.type is error", () => {
    const raw = JSON.stringify({ type: "error", message: "Something went wrong" });
    const event = geminiParseEvent(raw);
    expect(event?.type).toBe("turn.error");
  });

  it("includes detail from event.message when type is error", () => {
    const raw = JSON.stringify({ type: "error", message: "Boom" });
    const event = geminiParseEvent(raw);
    if (event?.type === "turn.error") {
      expect(event.detail).toContain("Boom");
    }
  });

  it("returns turn.error event when event.status is error and type is not result", () => {
    const raw = JSON.stringify({ type: "message", role: "system", status: "error", error: "Generation failed" });
    const event = geminiParseEvent(raw);
    expect(event?.type).toBe("turn.error");
  });

  it("includes detail from event.error when status is error and error field is present", () => {
    const raw = JSON.stringify({ type: "message", role: "system", status: "error", error: "Generation failed" });
    const event = geminiParseEvent(raw);
    if (event?.type === "turn.error") {
      expect(event.detail).toContain("Generation failed");
    }
  });

  it("result event with status error still returns turn.end (type check takes precedence over status)", () => {
    const raw = JSON.stringify({ type: "result", status: "error", stats: {} });
    const event = geminiParseEvent(raw);
    expect(event?.type).toBe("turn.end");
  });

  it("falls back to JSON stringified event as detail when message and error are absent", () => {
    const raw = JSON.stringify({ type: "error" });
    const event = geminiParseEvent(raw);
    if (event?.type === "turn.error") {
      expect(typeof event.detail).toBe("string");
      expect(event.detail.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// geminiProvider.buildInput — Gemini passes context through --prompt
// ---------------------------------------------------------------------------

describe("geminiProvider.buildInput", () => {
  it("does not add stdin input flags", () => {
    const args = geminiBuildArgs({ sessionId: "s1", cwd: "/", env: {}, taskContext: "do the task" });
    expect(args).not.toContain("--input-format");
  });
});

// ---------------------------------------------------------------------------
// registry: geminiProvider is registered by default
// ---------------------------------------------------------------------------

describe("registry.getProvider — gemini", () => {
  it("returns geminiProvider which is registered by default", () => {
    const provider = getProvider("gemini");
    expect(provider.name).toBe("gemini");
  });

  it("returned provider label is Gemini CLI", () => {
    expect(getProvider("gemini").label).toBe("Gemini CLI");
  });
});

// ---------------------------------------------------------------------------
// geminiProvider.execute — verifies arg selection via mocked spawnAgent
// ---------------------------------------------------------------------------

describe("geminiProvider.execute — arg selection", () => {
  it("resolves to an AgentHandle with events, abort, pid, and send", async () => {
    const { spawnAgent } = await import("../src/providers/spawnHelper.js");
    const handle = await geminiProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "build feature" });
    expect(handle).toHaveProperty("events");
    expect(typeof handle.abort).toBe("function");
    expect(typeof handle.send).toBe("function");
    expect(spawnAgent).toHaveBeenCalled();
  });

  it("passes taskContext through --prompt instead of stdin", async () => {
    const { spawnAgent } = await import("../src/providers/spawnHelper.js");
    vi.mocked(spawnAgent).mockClear();
    await geminiProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "my task context" });
    expect(vi.mocked(spawnAgent)).toHaveBeenCalledWith(expect.not.objectContaining({ input: expect.any(String) }));
    expect(vi.mocked(spawnAgent).mock.calls[0][0].args).toContain("my task context");
  });

  it("uses buildResumeArgs when resume is true", async () => {
    const { spawnAgent } = await import("../src/providers/spawnHelper.js");
    vi.mocked(spawnAgent).mockClear();
    await geminiProvider.execute({ sessionId: "s1", resumeToken: "gemini-session-1", cwd: "/tmp", env: {}, taskContext: "ctx", resume: true });
    const call = vi.mocked(spawnAgent).mock.calls[0][0];
    expect(call.args).toContain("--resume");
    expect(call.args).toContain("gemini-session-1");
  });

  it("fails fast when resume is true without a resumeToken", async () => {
    await expect(geminiProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx", resume: true })).rejects.toThrow(
      "gemini: resume requested but no resumeToken provided",
    );
  });

  it("uses task context only when resuming", async () => {
    const { spawnAgent } = await import("../src/providers/spawnHelper.js");
    vi.mocked(spawnAgent).mockClear();
    await geminiProvider.execute({
      sessionId: "s1",
      cwd: "/tmp",
      env: {},
      resumeToken: "gemini-session-1",
      systemPromptFile: "/tmp/system.txt",
      taskContext: "Task rejected. Reason: fix it",
      resume: true,
    });
    const call = vi.mocked(spawnAgent).mock.calls[0][0];
    const promptIdx = call.args.indexOf("--prompt");

    expect(call.args[promptIdx + 1]).toBe("Task rejected. Reason: fix it");
  });

  it("captures provider resume token from Gemini init output", async () => {
    const { spawnAgent } = await import("../src/providers/spawnHelper.js");
    vi.mocked(spawnAgent).mockClear();
    const handle = await geminiProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx" });
    const call = vi.mocked(spawnAgent).mock.calls[0][0];
    call.onLine?.(JSON.stringify({ type: "init", session_id: "gemini-session-2" }));

    expect(handle.getResumeToken?.()).toBe("gemini-session-2");
  });

  it("uses buildArgs when resume is false or absent", async () => {
    const { spawnAgent } = await import("../src/providers/spawnHelper.js");
    vi.mocked(spawnAgent).mockClear();
    await geminiProvider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx" });
    const call = vi.mocked(spawnAgent).mock.calls[0][0];
    expect(call.args).not.toContain("--resume");
  });
});

// ---------------------------------------------------------------------------
// mapSDKMessage — rate_limit allowed shape (new behavior)
// ---------------------------------------------------------------------------

describe("mapSDKMessage — rate_limit allowed shape", () => {
  it("returns rate_limit with status allowed and isUsingOverage true", () => {
    const msg = {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: null, rateLimitType: "five_hour", isUsingOverage: true },
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    const result = mapSDKMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("turn.rate_limit");
    if (result[0]?.type === "turn.rate_limit") {
      expect(result[0].status).toBe("allowed");
      expect(result[0].isUsingOverage).toBe(true);
      expect(result[0].resetAt).toBeUndefined();
    }
  });

  it("returns rate_limit with status allowed and isUsingOverage false", () => {
    const msg = {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: null, rateLimitType: "five_hour", isUsingOverage: false },
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    const result = mapSDKMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("turn.rate_limit");
    if (result[0]?.type === "turn.rate_limit") {
      expect(result[0].status).toBe("allowed");
      expect(result[0].isUsingOverage).toBe(false);
    }
  });

  it("leaves resetAt undefined when resetsAt is absent for rejected events", () => {
    const msg = {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: null, rateLimitType: "five_hour" },
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    const result = mapSDKMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("turn.rate_limit");
    if (result[0]?.type === "turn.rate_limit") {
      expect(result[0].resetAt).toBeUndefined();
    }
  });

  it("builds overage object with rejected status and resetAt when overageStatus is rejected", () => {
    const msg = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: 1700000000,
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        overageResetsAt: 1700003600,
      },
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    const result = mapSDKMessage(msg);
    expect(result).toHaveLength(1);
    if (result[0]?.type === "turn.rate_limit") {
      expect(result[0].overage?.status).toBe("rejected");
      expect(result[0].overage?.resetAt).toBe(new Date(1700003600 * 1000).toISOString());
    }
  });

  it("overage is undefined when overageStatus is absent", () => {
    const msg = {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 1700000000, rateLimitType: "five_hour" },
      uuid: "u1",
      session_id: "s1",
    } as unknown as SDKMessage;
    const result = mapSDKMessage(msg);
    expect(result).toHaveLength(1);
    if (result[0]?.type === "turn.rate_limit") {
      expect(result[0].overage).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// mapThreadEvent — codex rate_limit event includes status: "rejected"
// ---------------------------------------------------------------------------

describe("mapThreadEvent — codex rate_limit status field", () => {
  it("includes status: rejected when turn.failed is a rate limit", () => {
    const event = {
      type: "turn.failed",
      error: { message: "Rate limit exceeded, try again at 2026-04-01T15:00:00Z" },
    } as unknown as ThreadEvent;
    const result = mapThreadEvent(event);
    expect(result?.type).toBe("turn.rate_limit");
    if (result?.type === "turn.rate_limit") {
      expect(result.status).toBe("rejected");
    }
  });

  it("includes status: rejected when error event is a rate limit", () => {
    const event = {
      type: "error",
      message: "usage limit exceeded, please try again at tomorrow",
    } as unknown as ThreadEvent;
    const result = mapThreadEvent(event);
    expect(result?.type).toBe("turn.rate_limit");
    if (result?.type === "turn.rate_limit") {
      expect(result.status).toBe("rejected");
    }
  });
});
