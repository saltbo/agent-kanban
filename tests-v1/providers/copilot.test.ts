// @vitest-environment node

import type { SessionEvent } from "@github/copilot-sdk";
import { describe, expect, it } from "vitest";
import { mapCopilotEvent } from "../../packages/cli/src/providers/copilot.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<{ turnOpen: boolean }> = {}) {
  return {
    turnOpen: overrides.turnOpen ?? false,
    usage: {
      cost: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    pendingToolUses: new Map(),
  };
}

/** Collect all events emitted by the generator into an array. */
function collect(gen: Generator<unknown>): unknown[] {
  return [...gen];
}

// ---------------------------------------------------------------------------
// assistant.turn_start
// ---------------------------------------------------------------------------

describe("assistant.turn_start", () => {
  it("emits turn.start when turnOpen is false", () => {
    const state = makeState({ turnOpen: false });
    const event = { type: "assistant.turn_start", data: {} } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state));
    expect(events).toEqual([{ type: "turn.start" }]);
  });

  it("sets state.turnOpen to true", () => {
    const state = makeState({ turnOpen: false });
    const event = { type: "assistant.turn_start", data: {} } as SessionEvent;
    collect(mapCopilotEvent(event, state));
    expect(state.turnOpen).toBe(true);
  });

  it("emits nothing when turnOpen is already true", () => {
    const state = makeState({ turnOpen: true });
    const event = { type: "assistant.turn_start", data: {} } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state));
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// assistant.reasoning
// ---------------------------------------------------------------------------

describe("assistant.reasoning", () => {
  it("emits block.start and block.done with type thinking when content is present", () => {
    const state = makeState();
    const event = { type: "assistant.reasoning", data: { content: "I am thinking" } } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state));
    expect(events).toEqual([
      { type: "block.start", block: { type: "thinking", text: "" } },
      { type: "block.done", block: { type: "thinking", text: "I am thinking" } },
    ]);
  });

  it("emits nothing when content is empty string", () => {
    const state = makeState();
    const event = { type: "assistant.reasoning", data: { content: "" } } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state));
    expect(events).toHaveLength(0);
  });

  it("emits nothing when content is undefined", () => {
    const state = makeState();
    const event = { type: "assistant.reasoning", data: {} } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state));
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// assistant.message — content only
// ---------------------------------------------------------------------------

describe("assistant.message with content only", () => {
  it("emits turn.start when turnOpen is false", () => {
    const state = makeState({ turnOpen: false });
    const event = { type: "assistant.message", data: { content: "Hello" } } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state));
    expect(events[0]).toEqual({ type: "turn.start" });
  });

  it("sets state.turnOpen to true when auto-opening", () => {
    const state = makeState({ turnOpen: false });
    const event = { type: "assistant.message", data: { content: "Hello" } } as SessionEvent;
    collect(mapCopilotEvent(event, state));
    expect(state.turnOpen).toBe(true);
  });

  it("emits block.start and block.done for text content", () => {
    const state = makeState({ turnOpen: true });
    const event = { type: "assistant.message", data: { content: "Hello" } } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state));
    expect(events).toContainEqual({ type: "block.start", block: { type: "text", text: "" } });
    expect(events).toContainEqual({ type: "block.done", block: { type: "text", text: "Hello" } });
  });

  it("does not emit turn.start when turnOpen is already true", () => {
    const state = makeState({ turnOpen: true });
    const event = { type: "assistant.message", data: { content: "Hello" } } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state));
    expect(events.every((e: unknown) => (e as { type: string }).type !== "turn.start")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assistant.message — reasoningText + content
// ---------------------------------------------------------------------------

describe("assistant.message with reasoningText and content", () => {
  it("emits thinking block before text block", () => {
    const state = makeState({ turnOpen: true });
    const event = {
      type: "assistant.message",
      data: { content: "Answer", reasoningText: "Thinking..." },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state));
    const types = (events as { type: string }[]).map((e) => e.type);
    expect(types.indexOf("block.start")).toBeLessThan(types.lastIndexOf("block.start"));
  });

  it("emits block.start thinking with reasoningText", () => {
    const state = makeState({ turnOpen: true });
    const event = {
      type: "assistant.message",
      data: { content: "Answer", reasoningText: "Thinking..." },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as { type: string; block?: { type: string; text: string } }[];
    const thinkingStart = events.find((e) => e.type === "block.start" && e.block?.type === "thinking");
    expect(thinkingStart?.block?.text).toBe("");
  });

  it("emits block.start text with content", () => {
    const state = makeState({ turnOpen: true });
    const event = {
      type: "assistant.message",
      data: { content: "Answer", reasoningText: "Thinking..." },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as { type: string; block?: { type: string; text: string } }[];
    const textStart = events.find((e) => e.type === "block.start" && e.block?.type === "text");
    expect(textStart?.block?.text).toBe("");
  });
});

// ---------------------------------------------------------------------------
// assistant.message — toolRequests
// ---------------------------------------------------------------------------

describe("assistant.message with toolRequests", () => {
  it("emits block.start tool_use for each tool request", () => {
    const state = makeState({ turnOpen: true });
    const event = {
      type: "assistant.message",
      data: {
        toolRequests: [
          { toolCallId: "tc1", name: "bash", arguments: { command: "ls" } },
          { toolCallId: "tc2", name: "glob", arguments: { pattern: "**/*.ts" } },
        ],
      },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as {
      type: string;
      block?: { type: string; id: string; name: string; input: unknown };
    }[];
    const toolStarts = events.filter((e) => e.type === "block.start" && e.block?.type === "tool_use");
    expect(toolStarts).toHaveLength(2);
  });

  it("block.start tool_use has correct id, name, and input", () => {
    const state = makeState({ turnOpen: true });
    const event = {
      type: "assistant.message",
      data: {
        toolRequests: [{ toolCallId: "tc1", name: "bash", arguments: { command: "ls" } }],
      },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as {
      type: string;
      block?: { type: string; id: string; name: string; input: unknown };
    }[];
    const toolStart = events.find((e) => e.type === "block.start" && e.block?.type === "tool_use");
    expect(toolStart?.block?.id).toBe("tc1");
    expect(toolStart?.block?.name).toBe("Bash");
    expect(toolStart?.block?.input).toEqual({ command: "ls" });
  });

  it("uses empty object as input when arguments is null/undefined", () => {
    const state = makeState({ turnOpen: true });
    const event = {
      type: "assistant.message",
      data: {
        toolRequests: [{ toolCallId: "tc3", name: "noop", arguments: null }],
      },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as {
      type: string;
      block?: { type: string; id: string; name: string; input: unknown };
    }[];
    const toolStart = events.find((e) => e.type === "block.start" && e.block?.type === "tool_use");
    expect(toolStart?.block?.input).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// tool.execution_complete — success
// ---------------------------------------------------------------------------

describe("tool.execution_complete success", () => {
  it("emits block.done with type tool_use then block.done with type tool_result", () => {
    const state = makeState();
    state.pendingToolUses.set("tc1", { type: "tool_use", id: "tc1", name: "bash", input: {} });
    const event = {
      type: "tool.execution_complete",
      data: { toolCallId: "tc1", result: { content: "output text" }, success: true },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as {
      type: string;
      block?: { type: string; tool_use_id: string; output: string; error?: boolean };
    }[];
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("block.done");
    expect(events[0].block?.type).toBe("tool_use");
    expect(events[1].type).toBe("block.done");
    expect(events[1].block?.type).toBe("tool_result");
  });

  it("block has correct tool_use_id and output", () => {
    const state = makeState();
    state.pendingToolUses.set("tc1", { type: "tool_use", id: "tc1", name: "bash", input: {} });
    const event = {
      type: "tool.execution_complete",
      data: { toolCallId: "tc1", result: { content: "output text" }, success: true },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as {
      type: string;
      block?: { type: string; tool_use_id: string; output: string; error?: boolean };
    }[];
    const resultBlock = events[1];
    expect(resultBlock.block?.tool_use_id).toBe("tc1");
    expect(resultBlock.block?.output).toBe("output text");
  });

  it("block.error is not set (undefined) on success", () => {
    const state = makeState();
    state.pendingToolUses.set("tc1", { type: "tool_use", id: "tc1", name: "bash", input: {} });
    const event = {
      type: "tool.execution_complete",
      data: { toolCallId: "tc1", result: { content: "ok" }, success: true },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as {
      type: string;
      block?: { type: string; tool_use_id: string; output: string; error?: boolean };
    }[];
    const resultBlock = events[1];
    expect(resultBlock.block?.error).toBeUndefined();
  });

  it("removes the pending tool_use from state after emitting", () => {
    const state = makeState();
    state.pendingToolUses.set("tc1", { type: "tool_use", id: "tc1", name: "bash", input: {} });
    const event = {
      type: "tool.execution_complete",
      data: { toolCallId: "tc1", result: { content: "ok" }, success: true },
    } as SessionEvent;
    collect(mapCopilotEvent(event, state));
    expect(state.pendingToolUses.has("tc1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tool.execution_complete — failure
// ---------------------------------------------------------------------------

describe("tool.execution_complete failure", () => {
  it("emits block.done with error: true on failure", () => {
    const state = makeState();
    state.pendingToolUses.set("tc1", { type: "tool_use", id: "tc1", name: "bash", input: {} });
    const event = {
      type: "tool.execution_complete",
      data: { toolCallId: "tc1", result: null, success: false },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as {
      type: string;
      block?: { type: string; tool_use_id: string; output: string; error?: boolean };
    }[];
    const resultBlock = events[1];
    expect(resultBlock.block?.error).toBe(true);
  });

  it("uses fallback output 'Tool execution failed' when result has no content", () => {
    const state = makeState();
    state.pendingToolUses.set("tc1", { type: "tool_use", id: "tc1", name: "bash", input: {} });
    const event = {
      type: "tool.execution_complete",
      data: { toolCallId: "tc1", result: null, success: false },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as {
      type: string;
      block?: { type: string; tool_use_id: string; output: string; error?: boolean };
    }[];
    const resultBlock = events[1];
    expect(resultBlock.block?.output).toBe("Tool execution failed");
  });
});

// ---------------------------------------------------------------------------
// tool.execution_complete — no matching pending tool_use
// ---------------------------------------------------------------------------

describe("tool.execution_complete with no matching pending tool_use", () => {
  it("emits no events when toolCallId has no matching pending tool_use", () => {
    const state = makeState();
    const event = {
      type: "tool.execution_complete",
      data: { toolCallId: "tc1", result: { content: "output text" }, success: true },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as {
      type: string;
      block?: { type: string; tool_use_id: string; output: string; error?: boolean };
    }[];
    expect(events).toHaveLength(0);
  });

  it("does not emit block.done for tool_use when toolCallId does not match any pending entry", () => {
    const state = makeState();
    state.pendingToolUses.set("tc-other", { type: "tool_use", id: "tc-other", name: "bash", input: {} });
    const event = {
      type: "tool.execution_complete",
      data: { toolCallId: "tc1", result: { content: "output text" }, success: true },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as {
      type: string;
      block?: { type: string };
    }[];
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// assistant.usage
// ---------------------------------------------------------------------------

describe("assistant.usage", () => {
  it("accumulates cost into state.usage.cost", () => {
    const state = makeState();
    const event = {
      type: "assistant.usage",
      data: { cost: 1.5, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    } as SessionEvent;
    collect(mapCopilotEvent(event, state));
    expect(state.usage.cost).toBe(1.5);
  });

  it("accumulates input_tokens into state.usage.input_tokens", () => {
    const state = makeState();
    const event = {
      type: "assistant.usage",
      data: { cost: 0, inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    } as SessionEvent;
    collect(mapCopilotEvent(event, state));
    expect(state.usage.input_tokens).toBe(100);
  });

  it("accumulates output_tokens into state.usage.output_tokens", () => {
    const state = makeState();
    const event = {
      type: "assistant.usage",
      data: { cost: 0, inputTokens: 0, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    } as SessionEvent;
    collect(mapCopilotEvent(event, state));
    expect(state.usage.output_tokens).toBe(50);
  });

  it("accumulates cache_read_input_tokens", () => {
    const state = makeState();
    const event = {
      type: "assistant.usage",
      data: { cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 20, cacheWriteTokens: 0 },
    } as SessionEvent;
    collect(mapCopilotEvent(event, state));
    expect(state.usage.cache_read_input_tokens).toBe(20);
  });

  it("accumulates cache_creation_input_tokens", () => {
    const state = makeState();
    const event = {
      type: "assistant.usage",
      data: { cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 10 },
    } as SessionEvent;
    collect(mapCopilotEvent(event, state));
    expect(state.usage.cache_creation_input_tokens).toBe(10);
  });

  it("sums values across multiple calls", () => {
    const state = makeState();
    const eventA = {
      type: "assistant.usage",
      data: { cost: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 3 },
    } as SessionEvent;
    const eventB = {
      type: "assistant.usage",
      data: { cost: 2, inputTokens: 20, outputTokens: 10, cacheReadTokens: 4, cacheWriteTokens: 6 },
    } as SessionEvent;
    collect(mapCopilotEvent(eventA, state));
    collect(mapCopilotEvent(eventB, state));
    expect(state.usage.cost).toBe(3);
    expect(state.usage.input_tokens).toBe(30);
    expect(state.usage.output_tokens).toBe(15);
    expect(state.usage.cache_read_input_tokens).toBe(6);
    expect(state.usage.cache_creation_input_tokens).toBe(9);
  });

  it("emits no events", () => {
    const state = makeState();
    const event = {
      type: "assistant.usage",
      data: { cost: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 3 },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state));
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// session.idle
// ---------------------------------------------------------------------------

describe("session.idle", () => {
  it("emits turn.end when turnOpen is true", () => {
    const state = makeState({ turnOpen: true });
    state.usage.cost = 0.5;
    const event = { type: "session.idle", data: {} } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as { type: string }[];
    expect(events[0]?.type).toBe("turn.end");
  });

  it("turn.end carries cost from accumulated usage", () => {
    const state = makeState({ turnOpen: true });
    state.usage.cost = 2.5;
    const event = { type: "session.idle", data: {} } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as { type: string; cost?: number }[];
    expect(events[0]?.cost).toBe(2.5);
  });

  it("turn.end carries usage without cost field", () => {
    const state = makeState({ turnOpen: true });
    state.usage.input_tokens = 100;
    state.usage.output_tokens = 50;
    const event = { type: "session.idle", data: {} } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as {
      type: string;
      usage?: Record<string, number | undefined>;
    }[];
    expect(events[0]?.usage).toBeDefined();
    expect((events[0]?.usage as Record<string, number | undefined>)?.input_tokens).toBe(100);
    expect((events[0]?.usage as Record<string, number | undefined>)?.output_tokens).toBe(50);
    expect("cost" in (events[0]?.usage ?? {})).toBe(false);
  });

  it("sets turnOpen to false", () => {
    const state = makeState({ turnOpen: true });
    const event = { type: "session.idle", data: {} } as SessionEvent;
    collect(mapCopilotEvent(event, state));
    expect(state.turnOpen).toBe(false);
  });

  it("emits nothing when turnOpen is false", () => {
    const state = makeState({ turnOpen: false });
    const event = { type: "session.idle", data: {} } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state));
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// session.error
// ---------------------------------------------------------------------------

describe("session.error", () => {
  it("emits turn.rate_limit for errorType 'rate_limit'", () => {
    const state = makeState();
    const event = {
      type: "session.error",
      data: { errorType: "rate_limit", message: "too many requests" },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as { type: string; status?: string }[];
    expect(events[0]?.type).toBe("turn.rate_limit");
    expect(events[0]?.status).toBe("rejected");
  });

  it("emits turn.rate_limit for errorType 'quota'", () => {
    const state = makeState();
    const event = {
      type: "session.error",
      data: { errorType: "quota", message: "quota exceeded" },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as { type: string; status?: string }[];
    expect(events[0]?.type).toBe("turn.rate_limit");
    expect(events[0]?.status).toBe("rejected");
  });

  it("emits turn.error for other errorTypes", () => {
    const state = makeState();
    const event = {
      type: "session.error",
      data: { errorType: "internal_error", message: "something went wrong" },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as { type: string; code?: string; detail?: string }[];
    expect(events[0]?.type).toBe("turn.error");
  });

  it("turn.error carries the errorType as code", () => {
    const state = makeState();
    const event = {
      type: "session.error",
      data: { errorType: "internal_error", message: "something went wrong" },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as { type: string; code?: string; detail?: string }[];
    expect(events[0]?.code).toBe("internal_error");
  });

  it("turn.error carries the message as detail", () => {
    const state = makeState();
    const event = {
      type: "session.error",
      data: { errorType: "internal_error", message: "something went wrong" },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as { type: string; code?: string; detail?: string }[];
    expect(events[0]?.detail).toBe("something went wrong");
  });

  it("turn.error uses 'Unknown error' as detail when message is null", () => {
    const state = makeState();
    const event = {
      type: "session.error",
      data: { errorType: "internal_error", message: null },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as { type: string; code?: string; detail?: string }[];
    expect(events[0]?.detail).toBe("Unknown error");
  });
});

// ---------------------------------------------------------------------------
// internal tool skipping
// ---------------------------------------------------------------------------

describe("internal tool skipping", () => {
  it("emits no block.start events when all tool requests are internal tools", () => {
    const state = makeState({ turnOpen: true });
    const event = {
      type: "assistant.message",
      data: {
        toolRequests: [{ toolCallId: "tc-skip", name: "report_intent", arguments: {} }],
      },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as {
      type: string;
      block?: { type: string };
    }[];
    const blockStarts = events.filter((e) => e.type === "block.start");
    expect(blockStarts).toHaveLength(0);
  });

  it("emits no events for tool.execution_complete when toolCallId has no matching pending entry", () => {
    const state = makeState();
    // No pending tool_use registered — simulates a skipped tool whose tc-skip was never stored
    const event = {
      type: "tool.execution_complete",
      data: { toolCallId: "tc-skip", result: { content: "ok" }, success: true },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state));
    expect(events).toHaveLength(0);
  });

  it("emits exactly one block.start for bash and skips report_intent in a mixed toolRequests list", () => {
    const state = makeState({ turnOpen: true });
    const event = {
      type: "assistant.message",
      data: {
        toolRequests: [
          { toolCallId: "tc-bash", name: "bash", arguments: { command: "ls" } },
          { toolCallId: "tc-skip", name: "report_intent", arguments: {} },
        ],
      },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as {
      type: string;
      block?: { type: string; name: string };
    }[];
    const blockStarts = events.filter((e) => e.type === "block.start" && e.block?.type === "tool_use");
    expect(blockStarts).toHaveLength(1);
    expect(blockStarts[0].block?.name).toBe("Bash");
  });
});

// ---------------------------------------------------------------------------
// Unknown event type
// ---------------------------------------------------------------------------

describe("unknown event type", () => {
  it("emits nothing for an unrecognized event type", () => {
    const state = makeState();
    const event = { type: "some.future_event", data: {} } as unknown as SessionEvent;
    const events = collect(mapCopilotEvent(event, state));
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// user.message
// ---------------------------------------------------------------------------

describe("user.message", () => {
  it("emits message.user event with content when data.content is present", () => {
    const state = makeState();
    const event = { type: "user.message", data: { content: "Hello from user" } } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as { type: string; text?: string }[];
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "message.user", text: "Hello from user" });
  });

  it("emits no events when data.content is empty string", () => {
    const state = makeState();
    const event = { type: "user.message", data: { content: "" } } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state));
    expect(events).toHaveLength(0);
  });

  it("emits no events when data.content is undefined (falsy)", () => {
    const state = makeState();
    const event = { type: "user.message", data: {} } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state));
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// normalizeCopilotTool field remapping
// ---------------------------------------------------------------------------

describe("normalizeCopilotTool field remapping", () => {
  it("write: remaps path → filePath and file_text → content in block input", () => {
    const state = makeState({ turnOpen: true });
    const event = {
      type: "assistant.message",
      data: {
        toolRequests: [{ toolCallId: "tw1", name: "write", arguments: { path: "/tmp/f.ts", file_text: "hello" } }],
      },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as {
      type: string;
      block?: { type: string; name: string; input: Record<string, unknown> };
    }[];
    const toolStart = events.find((e) => e.type === "block.start" && e.block?.type === "tool_use");
    expect(toolStart?.block?.input).toMatchObject({ filePath: "/tmp/f.ts", content: "hello" });
  });

  it("edit: remaps path → filePath, old_str → oldString, new_str → newString in block input", () => {
    const state = makeState({ turnOpen: true });
    const event = {
      type: "assistant.message",
      data: {
        toolRequests: [{ toolCallId: "te1", name: "edit", arguments: { path: "/tmp/f.ts", old_str: "a", new_str: "b" } }],
      },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as {
      type: string;
      block?: { type: string; name: string; input: Record<string, unknown> };
    }[];
    const toolStart = events.find((e) => e.type === "block.start" && e.block?.type === "tool_use");
    expect(toolStart?.block?.input).toMatchObject({ filePath: "/tmp/f.ts", oldString: "a", newString: "b" });
  });

  it("read: remaps path → filePath in block input", () => {
    const state = makeState({ turnOpen: true });
    const event = {
      type: "assistant.message",
      data: {
        toolRequests: [{ toolCallId: "tr1", name: "read", arguments: { path: "/tmp/f.ts" } }],
      },
    } as SessionEvent;
    const events = collect(mapCopilotEvent(event, state)) as {
      type: string;
      block?: { type: string; name: string; input: Record<string, unknown> };
    }[];
    const toolStart = events.find((e) => e.type === "block.start" && e.block?.type === "tool_use");
    expect(toolStart?.block?.input).toMatchObject({ filePath: "/tmp/f.ts" });
  });
});
