// @vitest-environment node
/**
 * Unit tests for getClaudeHistory (claude.ts).
 *
 * getClaudeHistory calls getSessionMessages from the SDK and maps each
 * message through mapSDKMessage. The SDK is mocked so no real Claude session
 * is required.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Suppress child_process and fs calls from readOAuthToken ──────────────────
vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockImplementation(() => {
    throw new Error("not available in tests");
  }),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn().mockImplementation(() => {
    throw new Error("ENOENT");
  }),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: vi.fn().mockReturnValue("linux"), homedir: actual.homedir };
});

vi.mock("../packages/cli/src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ── Mock the SDK ──────────────────────────────────────────────────────────────
const mockGetSessionMessages = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn().mockReturnValue({
    [Symbol.asyncIterator]: async function* () {},
    close: vi.fn(),
    streamInput: vi.fn().mockResolvedValue(undefined),
  }),
  getSessionMessages: (...args: any[]) => mockGetSessionMessages(...args),
}));

import { claudeProvider } from "../packages/cli/src/providers/claude.js";

const getClaudeHistory = (sessionId: string) => claudeProvider.getHistory!(sessionId);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assistantMsg(text: string, uuid = "uuid-1") {
  return {
    type: "assistant",
    uuid,
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function resultMsg(cost = 0.01) {
  return {
    type: "result",
    subtype: "success",
    result: "done",
    total_cost_usd: cost,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// User message helpers
// ---------------------------------------------------------------------------

function userMsg(content: string | unknown[], uuid = "uuid-u1") {
  return {
    type: "user",
    uuid,
    parent_tool_use_id: null,
    message: { role: "user", content },
  };
}

function toolResultBlock(toolUseId: string, content: string) {
  return { type: "tool_result", tool_use_id: toolUseId, content };
}

function textBlock(text: string) {
  return { type: "text", text };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getClaudeHistory — basic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when SDK returns no messages", async () => {
    mockGetSessionMessages.mockResolvedValue([]);
    const events = await getClaudeHistory("session-1");
    expect(events).toEqual([]);
  });

  it("filters out messages that mapSDKMessage returns null for", async () => {
    // system messages with unknown subtype → mapSDKMessage returns null
    mockGetSessionMessages.mockResolvedValue([{ type: "system", subtype: "unknown_thing", tool_use_id: null }]);
    const events = await getClaudeHistory("session-2");
    expect(events).toHaveLength(0);
  });

  it("returns one event for a single assistant message", async () => {
    mockGetSessionMessages.mockResolvedValue([assistantMsg("Hello")]);
    const events = await getClaudeHistory("session-3");
    expect(events).toHaveLength(1);
    expect(events[0].event.type).toBe("message");
  });

  it("uses uuid from SessionMessage as event id", async () => {
    mockGetSessionMessages.mockResolvedValue([assistantMsg("A"), assistantMsg("B", "uuid-2")]);
    const events = await getClaudeHistory("session-4");
    expect(events[0].id).toBe("uuid-1");
    expect(events[1].id).toBe("uuid-2");
  });

  it("assigns a timestamp ISO string to each event", async () => {
    mockGetSessionMessages.mockResolvedValue([assistantMsg("A")]);
    const events = await getClaudeHistory("session-5");
    expect(() => new Date(events[0].timestamp)).not.toThrow();
    expect(events[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("maps a result message to turn.end event", async () => {
    mockGetSessionMessages.mockResolvedValue([resultMsg(0.05)]);
    const events = await getClaudeHistory("session-6");
    expect(events).toHaveLength(1);
    expect(events[0].event.type).toBe("turn.end");
    if (events[0].event.type === "turn.end") {
      expect(events[0].event.cost).toBe(0.05);
    }
  });

  it("returns multiple events for a mixed message list", async () => {
    mockGetSessionMessages.mockResolvedValue([assistantMsg("First"), assistantMsg("Second", "uuid-2"), resultMsg()]);
    const events = await getClaudeHistory("session-7");
    expect(events).toHaveLength(3);
    expect(events[0].event.type).toBe("message");
    expect(events[1].event.type).toBe("message");
    expect(events[2].event.type).toBe("turn.end");
  });

  it("calls getSessionMessages with the provided sessionId", async () => {
    mockGetSessionMessages.mockResolvedValue([]);
    await getClaudeHistory("my-session-id");
    expect(mockGetSessionMessages).toHaveBeenCalledWith("my-session-id");
  });
});

// ---------------------------------------------------------------------------
// getClaudeHistory — user message splitting (bug-fix coverage)
// ---------------------------------------------------------------------------

describe("getClaudeHistory — user message splitting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Case 1: plain string content → one message.user event with id ending in -user
  it("emits message.user event for user message with plain string content", async () => {
    mockGetSessionMessages.mockResolvedValue([userMsg("hello world")]);
    const events = await getClaudeHistory("s1");
    const userEvents = events.filter((e) => e.event.type === "message.user");
    expect(userEvents).toHaveLength(1);
  });

  it("sets text to the plain string content on message.user event", async () => {
    mockGetSessionMessages.mockResolvedValue([userMsg("hello world")]);
    const events = await getClaudeHistory("s1");
    const userEvent = events.find((e) => e.event.type === "message.user");
    expect((userEvent!.event as any).text).toBe("hello world");
  });

  it("gives the message.user event an id ending in -user", async () => {
    mockGetSessionMessages.mockResolvedValue([userMsg("hello world", "msg-abc")]);
    const events = await getClaudeHistory("s1");
    const userEvent = events.find((e) => e.event.type === "message.user");
    expect(userEvent!.id).toBe("msg-abc-user");
  });

  it("emits only one event for plain string content (no tool-result event)", async () => {
    mockGetSessionMessages.mockResolvedValue([userMsg("hello world")]);
    const events = await getClaudeHistory("s1");
    expect(events).toHaveLength(1);
  });

  // Case 2: array with single text block → one message.user event
  it("emits message.user event for user message with text block array", async () => {
    mockGetSessionMessages.mockResolvedValue([userMsg([textBlock("tell me about X")])]);
    const events = await getClaudeHistory("s2");
    const userEvents = events.filter((e) => e.event.type === "message.user");
    expect(userEvents).toHaveLength(1);
  });

  it("sets correct text for user message with text block array", async () => {
    mockGetSessionMessages.mockResolvedValue([userMsg([textBlock("tell me about X")])]);
    const events = await getClaudeHistory("s2");
    const userEvent = events.find((e) => e.event.type === "message.user");
    expect((userEvent!.event as any).text).toBe("tell me about X");
  });

  // Case 3: mixed content — tool_result + text → TWO events, user text first
  it("emits two events for mixed tool_result and text content", async () => {
    const mixed = [toolResultBlock("t1", "ok"), textBlock("follow up")];
    mockGetSessionMessages.mockResolvedValue([userMsg(mixed, "msg-mix")]);
    const events = await getClaudeHistory("s3");
    expect(events).toHaveLength(2);
  });

  it("emits message.user event first for mixed content", async () => {
    const mixed = [toolResultBlock("t1", "ok"), textBlock("follow up")];
    mockGetSessionMessages.mockResolvedValue([userMsg(mixed, "msg-mix")]);
    const events = await getClaudeHistory("s3");
    expect(events[0].event.type).toBe("message.user");
  });

  it("emits message event second (tool results) for mixed content", async () => {
    const mixed = [toolResultBlock("t1", "ok"), textBlock("follow up")];
    mockGetSessionMessages.mockResolvedValue([userMsg(mixed, "msg-mix")]);
    const events = await getClaudeHistory("s3");
    expect(events[1].event.type).toBe("message");
  });

  it("gives message.user id ending in -user for mixed content", async () => {
    const mixed = [toolResultBlock("t1", "ok"), textBlock("follow up")];
    mockGetSessionMessages.mockResolvedValue([userMsg(mixed, "msg-mix")]);
    const events = await getClaudeHistory("s3");
    expect(events[0].id).toBe("msg-mix-user");
  });

  it("gives message (tool) event id ending in -tool for mixed content", async () => {
    const mixed = [toolResultBlock("t1", "ok"), textBlock("follow up")];
    mockGetSessionMessages.mockResolvedValue([userMsg(mixed, "msg-mix")]);
    const events = await getClaudeHistory("s3");
    expect(events[1].id).toBe("msg-mix-tool");
  });

  it("tool result event contains the tool_result block for mixed content", async () => {
    const mixed = [toolResultBlock("t1", "ok"), textBlock("follow up")];
    mockGetSessionMessages.mockResolvedValue([userMsg(mixed, "msg-mix")]);
    const events = await getClaudeHistory("s3");
    const toolEvent = events[1];
    expect(toolEvent.event.type).toBe("message");
    const blocks = (toolEvent.event as any).blocks as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("tool_result");
    expect(blocks[0].tool_use_id).toBe("t1");
  });

  // Case 4: only tool_result blocks (no text) → one message event with -tool id, no message.user
  it("emits only a message event (no message.user) when content has only tool_result blocks", async () => {
    mockGetSessionMessages.mockResolvedValue([userMsg([toolResultBlock("t2", "result")], "msg-tool-only")]);
    const events = await getClaudeHistory("s4");
    expect(events).toHaveLength(1);
    expect(events[0].event.type).toBe("message");
  });

  it("gives the tool-only message event id ending in -tool", async () => {
    mockGetSessionMessages.mockResolvedValue([userMsg([toolResultBlock("t2", "result")], "msg-tool-only")]);
    const events = await getClaudeHistory("s4");
    expect(events[0].id).toBe("msg-tool-only-tool");
  });

  it("does not emit message.user when user message has only tool_result content", async () => {
    mockGetSessionMessages.mockResolvedValue([userMsg([toolResultBlock("t2", "result")], "msg-tool-only")]);
    const events = await getClaudeHistory("s4");
    const userEvents = events.filter((e) => e.event.type === "message.user");
    expect(userEvents).toHaveLength(0);
  });

  // Case 5: empty/whitespace-only text → no message.user emitted
  it("does not emit message.user for empty string content", async () => {
    mockGetSessionMessages.mockResolvedValue([userMsg("", "msg-empty")]);
    const events = await getClaudeHistory("s5");
    const userEvents = events.filter((e) => e.event.type === "message.user");
    expect(userEvents).toHaveLength(0);
  });

  it("does not emit message.user for whitespace-only string content", async () => {
    mockGetSessionMessages.mockResolvedValue([userMsg("   \n  ", "msg-ws")]);
    const events = await getClaudeHistory("s5");
    const userEvents = events.filter((e) => e.event.type === "message.user");
    expect(userEvents).toHaveLength(0);
  });

  it("does not emit message.user for text block with empty text", async () => {
    mockGetSessionMessages.mockResolvedValue([userMsg([textBlock("   ")], "msg-ws-block")]);
    const events = await getClaudeHistory("s5");
    const userEvents = events.filter((e) => e.event.type === "message.user");
    expect(userEvents).toHaveLength(0);
  });

  // Case 6: multiple text blocks → joined with \n
  it("joins multiple text blocks with newline in message.user text", async () => {
    mockGetSessionMessages.mockResolvedValue([userMsg([textBlock("first"), textBlock("second")], "msg-multi")]);
    const events = await getClaudeHistory("s6");
    const userEvent = events.find((e) => e.event.type === "message.user");
    expect((userEvent!.event as any).text).toBe("first\nsecond");
  });

  it("emits only one message.user event for multiple text blocks", async () => {
    mockGetSessionMessages.mockResolvedValue([userMsg([textBlock("a"), textBlock("b")])]);
    const events = await getClaudeHistory("s6");
    const userEvents = events.filter((e) => e.event.type === "message.user");
    expect(userEvents).toHaveLength(1);
  });
});
