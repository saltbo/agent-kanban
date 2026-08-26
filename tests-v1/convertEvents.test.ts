/**
 * Unit tests for convertEvents (RelayRuntimeProvider.tsx).
 *
 * Tests the message merging logic where consecutive assistant events
 * are merged into single messages, tool_result events update tool_use
 * results, and status handling based on agentStatus.
 */

import { describe, expect, it } from "vitest";
import { amaEventToRelayEvent, convertEvents } from "../apps/web/src/components/RelayRuntimeProvider.js";
import type { RelayEvent } from "../apps/web/src/hooks/useSessionRelay.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

function createAssistantEvent(id: string, blocks: any[]): RelayEvent {
  return {
    id,
    event: { type: "message", blocks },
    timestamp: "2026-04-08T10:00:00.000Z",
  };
}

function createUserEvent(id: string, text: string): RelayEvent {
  return {
    id,
    event: { type: "message.user", text },
    timestamp: "2026-04-08T10:00:00.000Z",
  };
}

function createResultEvent(id: string, text?: string, cost?: number): RelayEvent {
  return {
    id,
    event: { type: "turn.end", text, cost },
    timestamp: "2026-04-08T10:00:00.000Z",
  };
}

function createErrorEvent(id: string, detail: string): RelayEvent {
  return {
    id,
    event: { type: "turn.error", detail },
    timestamp: "2026-04-08T10:00:00.000Z",
  };
}

// ── Consecutive assistant events merging ──────────────────────────────────────

describe("convertEvents — consecutive assistant events merging", () => {
  it("merges consecutive assistant events into a single message", () => {
    const events = [
      createAssistantEvent("evt-1", [{ type: "text", text: "First part" }]),
      createAssistantEvent("evt-2", [{ type: "text", text: "Second part" }]),
      createAssistantEvent("evt-3", [{ type: "thinking", text: "I'm thinking..." }]),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("evt-1");
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content as any[]).toHaveLength(2);
    expect((messages[0].content as any[])[0]).toEqual({ type: "text", text: "First partSecond part" });
  });

  it("starts a new message after user event", () => {
    const events = [
      createAssistantEvent("evt-1", [{ type: "text", text: "Assistant first" }]),
      createUserEvent("user-1", "User input"),
      createAssistantEvent("evt-2", [{ type: "text", text: "Assistant second" }]),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("assistant");
    expect(messages[1].role).toBe("user");
    expect(messages[2].role).toBe("assistant");
  });

  it("starts a new message after result event", () => {
    const events = [
      createAssistantEvent("evt-1", [{ type: "text", text: "Working..." }]),
      createResultEvent("result-1", "Task completed"),
      createAssistantEvent("evt-2", [{ type: "text", text: "Next task" }]),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("assistant");
    expect((messages[1].content as any[])[0].text).toContain("Done — Task completed");
    expect(messages[2].role).toBe("assistant");
  });

  it("starts a new message after error event", () => {
    const events = [
      createAssistantEvent("evt-1", [{ type: "text", text: "Working..." }]),
      createErrorEvent("error-1", "Something went wrong"),
      createAssistantEvent("evt-2", [{ type: "text", text: "Trying again" }]),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(3);
    expect((messages[1].content as any[])[0].text).toBe("Error: Something went wrong");
    expect(messages[1].status).toEqual({ type: "incomplete", reason: "error" });
  });
});

// ── Tool use and tool result handling ─────────────────────────────────────────

describe("convertEvents — tool use and tool result handling", () => {
  it("creates tool call parts for tool_use blocks", () => {
    const events = [createAssistantEvent("evt-1", [{ type: "tool_use", id: "tool-123", name: "bash", input: { command: "ls -la" } }])];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    const toolCall = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(toolCall).toEqual({
      type: "tool-call",
      toolCallId: "tool-123",
      toolName: "bash",
      args: { command: "ls -la" },
    });
  });

  it("updates tool call result when tool_result event arrives", () => {
    const events = [
      createAssistantEvent("evt-1", [{ type: "tool_use", id: "tool-456", name: "read", input: { file: "test.txt" } }]),
      createAssistantEvent("evt-2", [{ type: "tool_result", tool_use_id: "tool-456", output: "File contents here", error: false }]),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    const toolCall = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(toolCall?.result).toBe("File contents here");
  });

  it("marks tool call result as error when tool_result has error flag", () => {
    const events = [
      createAssistantEvent("evt-1", [{ type: "tool_use", id: "tool-error", name: "bash", input: { command: "invalid" } }]),
      createAssistantEvent("evt-2", [{ type: "tool_result", tool_use_id: "tool-error", output: "Command not found", error: true }]),
    ];

    const messages = convertEvents(events, "idle");

    const toolCall = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(toolCall?.result).toEqual({ error: "Command not found" });
  });

  it("handles tool_result without output", () => {
    const events = [
      createAssistantEvent("evt-1", [{ type: "tool_use", id: "tool-empty", name: "action" }]),
      createAssistantEvent("evt-2", [{ type: "tool_result", tool_use_id: "tool-empty" }]),
    ];

    const messages = convertEvents(events, "idle");

    const toolCall = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(toolCall?.result).toBe("Done");
  });

  it("ignores tool_result for unknown tool_use_id", () => {
    const events = [
      createAssistantEvent("evt-1", [{ type: "text", text: "Some text" }]),
      createAssistantEvent("evt-2", [{ type: "tool_result", tool_use_id: "unknown-tool", output: "Should be ignored" }]),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    expect(messages[0].content as any[]).toHaveLength(1);
  });
});

// ── Agent status and message status ───────────────────────────────────────────

describe("convertEvents — agent status and message status", () => {
  it("marks last message as running when agentStatus is working", () => {
    const events = [createAssistantEvent("evt-1", [{ type: "text", text: "Working on it..." }])];

    const messages = convertEvents(events, "working");

    expect(messages).toHaveLength(1);
    expect(messages[0].status).toEqual({ type: "running" });
  });

  it("marks last message as complete when agentStatus is idle", () => {
    const events = [createAssistantEvent("evt-1", [{ type: "text", text: "All done" }])];

    const messages = convertEvents(events, "idle");

    expect(messages[0].status).toEqual({ type: "complete", reason: "unknown" });
  });

  it("marks last message as complete when agentStatus is done", () => {
    const events = [createAssistantEvent("evt-1", [{ type: "text", text: "Finished" }])];

    const messages = convertEvents(events, "done");

    expect(messages[0].status).toEqual({ type: "complete", reason: "unknown" });
  });

  it("only last assistant message gets running status", () => {
    const events = [
      createAssistantEvent("evt-1", [{ type: "text", text: "First message" }]),
      createUserEvent("user-1", "User input"),
      createAssistantEvent("evt-2", [{ type: "text", text: "Second message" }]),
    ];

    const messages = convertEvents(events, "working");

    expect(messages).toHaveLength(3);
    expect(messages[0].status).toEqual({ type: "complete", reason: "unknown" });
    expect(messages[2].status).toEqual({ type: "running" });
  });
});

// ── Result and error event handling ───────────────────────────────────────────

describe("convertEvents — result and error events", () => {
  it("formats result with cost and text", () => {
    const events = [createResultEvent("r-1", "Task completed", 0.1234)];
    const messages = convertEvents(events, "idle");

    expect((messages[0].content as any[])[0].text).toBe("Done ($0.1234) — Task completed");
    expect(messages[0].status).toEqual({ type: "complete", reason: "stop" });
  });

  it("formats result without cost", () => {
    const events = [createResultEvent("r-2", "All finished")];
    const messages = convertEvents(events, "idle");

    expect((messages[0].content as any[])[0].text).toBe("Done — All finished");
  });

  it("formats result with only cost", () => {
    const events = [createResultEvent("r-3", undefined, 0.0567)];
    const messages = convertEvents(events, "idle");

    expect((messages[0].content as any[])[0].text).toBe("Done ($0.0567)");
  });

  it("truncates long result text to 120 chars", () => {
    const longText = "x".repeat(200);
    const events = [createResultEvent("r-4", longText)];
    const messages = convertEvents(events, "idle");

    expect((messages[0].content as any[])[0].text).toBe(`Done — ${"x".repeat(120)}`);
  });

  it("creates error message with incomplete status", () => {
    const events = [createErrorEvent("err-1", "Network timeout")];
    const messages = convertEvents(events, "idle");

    expect((messages[0].content as any[])[0].text).toBe("Error: Network timeout");
    expect(messages[0].status).toEqual({ type: "incomplete", reason: "error" });
  });
});

// ── Rate limit handling ─────────────────────────────────────────────────────

describe("convertEvents — rate limit events", () => {
  it("creates rate limit message with reset time", () => {
    const events: RelayEvent[] = [
      {
        id: "rate-1",
        event: {
          type: "turn.rate_limit",
          status: "rejected",
          resetAt: new Date("2026-04-08T11:00:00.000Z").toISOString(),
        },
        timestamp: "2026-04-08T10:00:00.000Z",
      },
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    expect((messages[0].content as any[])[0].text).toContain("Rate limited — resets at");
    expect(messages[0].status).toEqual({ type: "incomplete", reason: "error" });
  });

  it("shows overage info when applicable", () => {
    const events: RelayEvent[] = [
      {
        id: "rate-2",
        event: { type: "turn.rate_limit", status: "rejected", isUsingOverage: true },
        timestamp: "2026-04-08T10:00:00.000Z",
      },
    ];

    const messages = convertEvents(events, "idle");

    expect((messages[0].content as any[])[0].text).toBe("Rate limited — continuing on extra usage");
  });

  it("ignores allowed rate limit events", () => {
    const events: RelayEvent[] = [
      {
        id: "rate-3",
        event: { type: "turn.rate_limit", status: "allowed" },
        timestamp: "2026-04-08T10:00:00.000Z",
      },
    ];

    const messages = convertEvents(events, "idle");
    expect(messages).toHaveLength(0);
  });

  it("shows 'reset time unknown' when resetAt is absent and not overage", () => {
    const events: RelayEvent[] = [
      {
        id: "rate-4",
        event: { type: "turn.rate_limit", status: "rejected" },
        timestamp: "2026-04-08T10:00:00.000Z",
      },
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    expect((messages[0].content as any[])[0].text).toBe("Rate limited — reset time unknown");
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("convertEvents — edge cases", () => {
  it("returns empty array for empty input", () => {
    expect(convertEvents([], "idle")).toEqual([]);
  });

  it("returns empty for events with no blocks", () => {
    const messages = convertEvents([createAssistantEvent("evt-1", [])], "idle");
    expect(messages).toHaveLength(0);
  });

  it("preserves event IDs and timestamps", () => {
    const ts = "2026-04-08T15:30:45.123Z";
    const events: RelayEvent[] = [{ id: "custom-id", event: { type: "message.user", text: "Test" }, timestamp: ts }];

    const messages = convertEvents(events, "idle");

    expect(messages[0].id).toBe("custom-id");
    expect(messages[0].createdAt).toEqual(new Date(ts));
  });
});

describe("amaEventToRelayEvent — canonical AMA EventRecord mapping", () => {
  it("maps canonical turn.started records with user message payloads to user chat messages", () => {
    const relayEvent = amaEventToRelayEvent({
      id: "evt-turn-started",
      sessionId: "session-1",
      sequence: 1,
      createdAt: "2026-04-08T10:00:00.000Z",
      type: "turn.started",
      payload: {
        message: {
          id: "msg-user-1",
          role: "user",
          content: [{ type: "text", text: "Run the smoke test again" }],
        },
      },
    });

    const messages = convertEvents([relayEvent], "idle");

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect((messages[0].content as any[])[0].text).toBe("Run the smoke test again");
  });

  it("maps canonical assistant tool call and tool result records into one rendered tool call", () => {
    const events = [
      amaEventToRelayEvent({
        id: "evt-tool-call",
        sessionId: "session-1",
        sequence: 2,
        createdAt: "2026-04-08T10:00:01.000Z",
        type: "message.completed",
        payload: {
          message: {
            id: "msg-assistant-1",
            role: "assistant",
            content: [{ type: "tool_call", toolCall: { id: "call-1", name: "bash", input: { command: "echo ok" } } }],
          },
        },
      }),
      amaEventToRelayEvent({
        id: "evt-tool-result",
        sessionId: "session-1",
        sequence: 3,
        createdAt: "2026-04-08T10:00:02.000Z",
        type: "message.completed",
        payload: {
          message: {
            id: "msg-tool-1",
            role: "tool",
            parentToolCallId: "call-1",
            content: [
              {
                type: "tool_result",
                toolCallId: "call-1",
                result: { content: [{ type: "text", text: "ok" }], exitCode: 0 },
              },
            ],
          },
        },
      }),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    const toolCall = (messages[0].content as any[]).find((part) => part.type === "tool-call");
    expect(toolCall).toMatchObject({
      toolCallId: "call-1",
      toolName: "Bash",
      args: { command: "echo ok" },
      result: "ok",
    });
  });

  it("maps latest AMA lowercase bash tool calls to the Bash renderer", () => {
    const events = [
      amaEventToRelayEvent({
        id: "evt-tool-call-bash",
        sessionId: "session-1",
        sequence: 30,
        createdAt: "2026-04-08T10:00:01.000Z",
        type: "message.completed",
        payload: {
          message: {
            id: "msg-assistant-bash",
            role: "assistant",
            content: [{ type: "tool_call", toolCall: { id: "call-bash", name: "bash", input: { command: "pnpm test" } } }],
          },
        },
      }),
    ];

    const messages = convertEvents(events, "idle");

    const toolCall = (messages[0].content as any[]).find((part) => part.type === "tool-call");
    expect(toolCall).toMatchObject({
      toolCallId: "call-bash",
      toolName: "Bash",
      args: { command: "pnpm test" },
    });
  });

  it("rejects canonical assistant messages without a message id", () => {
    expect(() =>
      amaEventToRelayEvent({
        id: "event-without-message-id",
        sessionId: "session-1",
        sequence: 31,
        createdAt: "2026-04-08T10:00:01.000Z",
        type: "message.completed",
        payload: {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "no message id" }],
          },
        },
      }),
    ).toThrow("Invalid AMA EventRecord: message.id is required");
  });

  it("rejects canonical tool calls without object input", () => {
    expect(() =>
      amaEventToRelayEvent({
        id: "evt-tool-call-invalid",
        sessionId: "session-1",
        sequence: 32,
        createdAt: "2026-04-08T10:00:01.000Z",
        type: "message.completed",
        payload: {
          message: {
            id: "msg-assistant-invalid-tool",
            role: "assistant",
            content: [{ type: "tool_call", toolCall: { id: "call-invalid", name: "bash", input: "not-object" } }],
          },
        },
      }),
    ).toThrow("Invalid AMA EventRecord: tool_call requires toolCall.id, toolCall.name, and object toolCall.input");
  });

  it("treats canonical message.updated payloads as snapshots instead of appending duplicate text", () => {
    const events = [
      amaEventToRelayEvent({
        id: "evt-update-1",
        sessionId: "session-1",
        sequence: 4,
        createdAt: "2026-04-08T10:00:03.000Z",
        type: "message.updated",
        payload: { message: { id: "msg-stream-1", role: "assistant", content: [{ type: "text", text: "hel" }] } },
      }),
      amaEventToRelayEvent({
        id: "evt-update-2",
        sessionId: "session-1",
        sequence: 5,
        createdAt: "2026-04-08T10:00:04.000Z",
        type: "message.updated",
        payload: { message: { id: "msg-stream-1", role: "assistant", content: [{ type: "text", text: "hello" }] } },
      }),
      amaEventToRelayEvent({
        id: "evt-completed",
        sessionId: "session-1",
        sequence: 6,
        createdAt: "2026-04-08T10:00:05.000Z",
        type: "message.completed",
        payload: { message: { id: "msg-stream-1", role: "assistant", content: [{ type: "text", text: "hello" }] } },
      }),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    expect((messages[0].content as any[])[0].text).toBe("hello");
  });

  it("treats canonical turn.completed as a lifecycle event without adding a duplicate summary", () => {
    const events = [
      amaEventToRelayEvent({
        id: "evt-message",
        sessionId: "session-1",
        sequence: 7,
        createdAt: "2026-04-08T10:00:06.000Z",
        type: "message.completed",
        payload: { message: { id: "msg-final-1", role: "assistant", content: [{ type: "text", text: "finished" }] } },
      }),
      amaEventToRelayEvent({
        id: "evt-turn-completed",
        sessionId: "session-1",
        sequence: 8,
        createdAt: "2026-04-08T10:00:07.000Z",
        type: "turn.completed",
        payload: { status: "completed", reason: "stop" },
      }),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    expect((messages[0].content as any[])[0].text).toBe("finished");
  });

  it("rejects old AMA event wrapper records", () => {
    expect(() =>
      amaEventToRelayEvent({
        id: "evt-old-wrapper",
        sessionId: "session-1",
        sequence: 9,
        createdAt: "2026-04-08T10:00:08.000Z",
        event: {
          type: "message.completed",
          payload: { message: { id: "msg-old-wrapper", role: "assistant", content: [{ type: "text", text: "old" }] } },
        },
      }),
    ).toThrow("Invalid AMA SessionEvent: type and payload are required");
  });

  it("normalizes AMA sandbox tool inputs to AK tool UI shapes", () => {
    const events = [
      amaEventToRelayEvent({
        id: "evt-read-tool",
        sessionId: "session-1",
        sequence: 10,
        createdAt: "2026-04-08T10:00:09.000Z",
        type: "message.completed",
        payload: {
          message: {
            id: "msg-read-tool",
            role: "assistant",
            content: [{ type: "tool_call", toolCall: { id: "call-read", name: "read", input: { path: "src/app.ts", offset: 1, limit: 20 } } }],
          },
        },
      }),
      amaEventToRelayEvent({
        id: "evt-edit-tool",
        sessionId: "session-1",
        sequence: 11,
        createdAt: "2026-04-08T10:00:10.000Z",
        type: "message.completed",
        payload: {
          message: {
            id: "msg-edit-tool",
            role: "assistant",
            content: [
              {
                type: "tool_call",
                toolCall: { id: "call-edit", name: "edit", input: { path: "src/app.ts", edits: [{ oldText: "old", newText: "new" }] } },
              },
            ],
          },
        },
      }),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toEqual([
      expect.objectContaining({
        toolCallId: "call-read",
        toolName: "Read",
        args: { filePath: "src/app.ts", offset: 1, limit: 20 },
      }),
    ]);
    expect(messages[1].content).toEqual([
      expect.objectContaining({
        toolCallId: "call-edit",
        toolName: "Edit",
        args: { filePath: "src/app.ts", oldString: "old", newString: "new" },
      }),
    ]);
  });

  it("renders canonical AMA agent tool calls with parentToolCallId child events inside the Agent card", () => {
    const events = [
      amaEventToRelayEvent({
        id: "evt-agent-call",
        sessionId: "session-1",
        sequence: 40,
        createdAt: "2026-04-08T10:00:01.000Z",
        type: "message.completed",
        payload: {
          message: {
            id: "msg-agent-call",
            role: "assistant",
            content: [
              {
                type: "tool_call",
                toolCall: {
                  id: "call-agent",
                  name: "agent",
                  input: { prompt: "Check this change", description: "Review pull request", subagentName: "reviewer" },
                },
              },
            ],
          },
        },
      }),
      amaEventToRelayEvent({
        id: "evt-child-text",
        sessionId: "session-1",
        sequence: 41,
        createdAt: "2026-04-08T10:00:02.000Z",
        type: "message.completed",
        payload: {
          message: {
            id: "msg-child-text",
            role: "assistant",
            parentToolCallId: "call-agent",
            content: [{ type: "text", text: "Inspecting files." }],
          },
        },
      }),
      amaEventToRelayEvent({
        id: "evt-child-tool-call",
        sessionId: "session-1",
        sequence: 42,
        createdAt: "2026-04-08T10:00:03.000Z",
        type: "message.completed",
        payload: {
          message: {
            id: "msg-child-tool-call",
            role: "assistant",
            parentToolCallId: "call-agent",
            content: [{ type: "tool_call", toolCall: { id: "call-inner", name: "bash", input: { command: "pnpm test" } } }],
          },
        },
      }),
      amaEventToRelayEvent({
        id: "evt-child-tool-result",
        sessionId: "session-1",
        sequence: 43,
        createdAt: "2026-04-08T10:00:04.000Z",
        type: "message.completed",
        payload: {
          message: {
            id: "msg-child-tool-result",
            role: "tool",
            parentToolCallId: "call-inner",
            content: [{ type: "tool_result", toolCallId: "call-inner", result: { content: [{ type: "text", text: "tests passed" }] } }],
          },
        },
      }),
      amaEventToRelayEvent({
        id: "evt-agent-result",
        sessionId: "session-1",
        sequence: 44,
        createdAt: "2026-04-08T10:00:05.000Z",
        type: "message.completed",
        payload: {
          message: {
            id: "msg-agent-result",
            role: "tool",
            parentToolCallId: "call-agent",
            content: [{ type: "tool_result", toolCallId: "call-agent", result: { content: [{ type: "text", text: "Review passed." }] } }],
          },
        },
      }),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    const toolCall = (messages[0].content as any[]).find((part) => part.type === "tool-call");
    expect(toolCall).toMatchObject({
      toolCallId: "call-agent",
      toolName: "Agent",
      args: { prompt: "Check this change", description: "Review pull request", subagentType: "reviewer" },
      result: {
        text: "Review passed.",
        children: [
          { kind: "text", text: "Inspecting files." },
          { kind: "tool_use", id: "call-inner", name: "Bash", input: { command: "pnpm test" } },
          { kind: "tool_result", tool_use_id: "call-inner", output: "tests passed", error: false },
        ],
      },
    });
  });
});

// ── Streaming event types ───────────────────────────────────────────────────

const T = "2026-04-08T10:00:00.000Z";

function re(id: string, event: any): RelayEvent {
  return { id, event, timestamp: T };
}

describe("convertEvents — streaming turn lifecycle", () => {
  it("turn_start + content_block_start creates running message with tool loading", () => {
    const events = [re("e1", { type: "turn.start" }), re("e2", { type: "block.start", block: { type: "tool_use", id: "t1", name: "bash" } })];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].status).toEqual({ type: "running" });
    const tc = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(tc.toolCallId).toBe("t1");
    expect(tc.toolName).toBe("bash");
    expect(tc.result).toBeUndefined();
  });

  it("content_block_done fills in tool result", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.start", block: { type: "tool_use", id: "t1", name: "bash" } }),
      re("e3", { type: "block.done", block: { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } } }),
      re("e4", { type: "block.done", block: { type: "tool_result", tool_use_id: "t1", output: "file.txt" } }),
      re("e5", { type: "turn.end" }),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    expect(messages[0].status).toEqual({ type: "complete", reason: "unknown" });
    const tc = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(tc.args).toEqual({ command: "ls" });
    expect(tc.result).toBe("file.txt");
  });

  it("thinking block starts with empty text, gets filled on done", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.start", block: { type: "thinking", text: "" } }),
      re("e3", { type: "block.done", block: { type: "thinking", text: "Let me think..." } }),
      re("e4", { type: "block.start", block: { type: "text", text: "" } }),
      re("e5", { type: "block.done", block: { type: "text", text: "Here's my answer." } }),
      re("e6", { type: "turn.end" }),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    const parts = messages[0].content as any[];
    expect(parts[0]).toEqual({ type: "reasoning", text: "Let me think..." });
    expect(parts[1]).toEqual({ type: "text", text: "Here's my answer." });
  });

  it("turn_end flushes, next turn_start creates new message", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.start", block: { type: "text", text: "" } }),
      re("e3", { type: "block.done", block: { type: "text", text: "First turn" } }),
      re("e4", { type: "turn.end" }),
      re("e5", { type: "turn.start" }),
      re("e6", { type: "block.start", block: { type: "text", text: "" } }),
      re("e7", { type: "block.done", block: { type: "text", text: "Second turn" } }),
      re("e8", { type: "turn.end" }),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(2);
    expect((messages[0].content as any[])[0].text).toBe("First turn");
    expect((messages[1].content as any[])[0].text).toBe("Second turn");
  });

  it("unflushed streaming turn gets running status", () => {
    const events = [re("e1", { type: "turn.start" }), re("e2", { type: "block.start", block: { type: "tool_use", id: "t1", name: "read" } })];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    expect(messages[0].status).toEqual({ type: "running" });
  });

  it("mixes streaming and legacy events correctly", () => {
    const events = [
      // History (legacy)
      re("h1", { type: "message", blocks: [{ type: "text", text: "From history" }] }),
      re("h2", { type: "message.user", text: "User question" }),
      // Live (streaming)
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.start", block: { type: "text", text: "" } }),
      re("e3", { type: "block.done", block: { type: "text", text: "Live response" } }),
      re("e4", { type: "turn.end" }),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("assistant");
    expect(messages[1].role).toBe("user");
    expect(messages[2].role).toBe("assistant");
    expect((messages[2].content as any[])[0].text).toBe("Live response");
  });
});

// ── Subtask routing — block.done with parent_id ────────────────────────────

describe("convertEvents — subtask routing via block.done", () => {
  it("routes subtask thinking block into Task tool's result.children, not main parts", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      // Main agent emits a Task tool_use
      re("e2", { type: "block.done", block: { type: "tool_use", id: "toolu_task1", name: "Agent", input: { description: "do something" } } }),
      // Subagent emits a thinking block with parent_id
      re("e3", { type: "block.done", block: { type: "thinking", text: "subagent thinking", parent_id: "toolu_task1" } }),
    ];

    const messages = convertEvents(events, "idle");

    // Main parts should have only the Task tool-call, no thinking part from subagent
    expect(messages).toHaveLength(1);
    const parts = messages[0].content as any[];
    const tc = parts.find((p: any) => p.type === "tool-call");
    expect(tc).toBeDefined();
    expect(tc.toolName).toBe("Agent");
    // No standalone reasoning part in main parts
    expect(parts.filter((p: any) => p.type === "reasoning")).toHaveLength(0);
    // Thinking block routed into children
    const result = tc.result as any;
    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toEqual({ kind: "thinking", text: "subagent thinking" });
  });

  it("routes subtask tool_use block into Task tool's result.children", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.done", block: { type: "tool_use", id: "toolu_task1", name: "Agent", input: {} } }),
      re("e3", {
        type: "block.done",
        block: { type: "tool_use", id: "inner_tool1", name: "bash", input: { command: "ls" }, parent_id: "toolu_task1" },
      }),
    ];

    const messages = convertEvents(events, "idle");

    const tc = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(tc.result.children).toHaveLength(1);
    expect(tc.result.children[0]).toEqual({ kind: "tool_use", id: "inner_tool1", name: "bash", input: { command: "ls" } });
  });

  it("routes subtask text block into Task tool's result.children", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.done", block: { type: "tool_use", id: "toolu_task1", name: "Agent", input: {} } }),
      re("e3", { type: "block.done", block: { type: "text", text: "subtask output", parent_id: "toolu_task1" } }),
    ];

    const messages = convertEvents(events, "idle");

    const tc = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(tc.result.children).toHaveLength(1);
    expect(tc.result.children[0]).toEqual({ kind: "text", text: "subtask output" });
  });

  it("routes subtask tool_result block into Task tool's result.children", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.done", block: { type: "tool_use", id: "toolu_task1", name: "Agent", input: {} } }),
      re("e3", {
        type: "block.done",
        block: { type: "tool_result", tool_use_id: "inner_tool1", output: "result text", error: false, parent_id: "toolu_task1" },
      }),
    ];

    const messages = convertEvents(events, "idle");

    const tc = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(tc.result.children[0]).toEqual({ kind: "tool_result", tool_use_id: "inner_tool1", output: "result text", error: false });
  });

  it("accumulates multiple subtask children in order", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.done", block: { type: "tool_use", id: "toolu_task1", name: "Agent", input: {} } }),
      re("e3", { type: "block.done", block: { type: "thinking", text: "thinking first", parent_id: "toolu_task1" } }),
      re("e4", { type: "block.done", block: { type: "tool_use", id: "t2", name: "read", input: {}, parent_id: "toolu_task1" } }),
      re("e5", { type: "block.done", block: { type: "text", text: "final text", parent_id: "toolu_task1" } }),
    ];

    const messages = convertEvents(events, "idle");

    const tc = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(tc.result.children).toHaveLength(3);
    expect(tc.result.children[0].kind).toBe("thinking");
    expect(tc.result.children[1].kind).toBe("tool_use");
    expect(tc.result.children[2].kind).toBe("text");
  });

  it("outer tool_result for Task populates result.text without overwriting children", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.done", block: { type: "tool_use", id: "toolu_task1", name: "Agent", input: {} } }),
      re("e3", { type: "block.done", block: { type: "text", text: "child text", parent_id: "toolu_task1" } }),
      // Outer tool_result closes the Task tool call on the main turn (no parent_id)
      re("e4", { type: "block.done", block: { type: "tool_result", tool_use_id: "toolu_task1", output: "Task summary markdown" } }),
    ];

    const messages = convertEvents(events, "idle");

    const tc = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(tc.result.text).toBe("Task summary markdown");
    // children must survive the outer tool_result update
    expect(tc.result.children).toHaveLength(1);
    expect(tc.result.children[0]).toEqual({ kind: "text", text: "child text" });
  });

  it("unknown subtask block type with parent_id is silently dropped (default branch)", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.done", block: { type: "tool_use", id: "toolu_task1", name: "Agent", input: {} } }),
      // An unknown block type with parent_id — should be dropped, not leak into main stream
      re("e3", { type: "block.done", block: { type: "image", url: "http://example.com/img.png", parent_id: "toolu_task1" } }),
    ];

    const messages = convertEvents(events, "idle");

    // Only the Task tool-call in main parts, nothing from the unknown subtask block
    const parts = messages[0].content as any[];
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("tool-call");
    // Children are empty (image type has no handler in routeSubtaskBlock known branches — hits default)
    const tc = parts[0] as any;
    expect(tc.result?.children ?? []).toHaveLength(0);
  });

  it("drops orphan subtask blocks silently — parent_id refers to unknown tool_use_id", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.done", block: { type: "text", text: "main text" } }),
      // Orphan — no matching tool_use in toolCallMap
      re("e3", { type: "block.done", block: { type: "text", text: "orphan subtask", parent_id: "unknown_id" } }),
    ];

    const messages = convertEvents(events, "idle");

    // Orphan must not appear in main parts
    const parts = messages[0].content as any[];
    const textParts = parts.filter((p: any) => p.type === "text");
    expect(textParts).toHaveLength(1);
    expect(textParts[0].text).toBe("main text");
  });
});

// ── mapBlock default branch (unknown block type) ──────────────────────────

describe("convertEvents — unknown block type in message event is ignored", () => {
  it("unknown block type produces no content part", () => {
    const events = [
      re("e1", {
        type: "message",
        blocks: [
          { type: "image", url: "http://example.com/img.png" },
          { type: "text", text: "after image" },
        ],
      }),
    ];

    const messages = convertEvents(events, "idle");

    // Only the text part should appear; image (unknown) is dropped via mapBlock returning null
    expect(messages).toHaveLength(1);
    const parts = messages[0].content as any[];
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toBe("after image");
  });
});

// ── updateOrAppend backward-search break ──────────────────────────────────

describe("convertEvents — updateOrAppend backward search breaks on type mismatch", () => {
  it("appends new text part when last parts are of a different type (no stale empty match)", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      // A tool_use block — adds a tool-call part
      re("e2", { type: "block.start", block: { type: "tool_use", id: "t1", name: "bash" } }),
      // A block.done for text — backwards search hits tool-call (different type) and breaks, then appends
      re("e3", { type: "block.done", block: { type: "text", text: "appended text" } }),
    ];

    const messages = convertEvents(events, "idle");

    const parts = messages[0].content as any[];
    const textPart = parts.find((p: any) => p.type === "text");
    expect(textPart).toBeDefined();
    expect(textPart.text).toBe("appended text");
  });
});

// ── Subtask routing via block.start ────────────────────────────────────────

describe("convertEvents — subtask routing via block.start", () => {
  it("subtask block.start with parent_id is not added to main parts", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.done", block: { type: "tool_use", id: "toolu_task1", name: "Agent", input: {} } }),
      re("e3", { type: "block.start", block: { type: "thinking", text: "", parent_id: "toolu_task1" } }),
    ];

    const messages = convertEvents(events, "idle");

    const parts = messages[0].content as any[];
    expect(parts.filter((p: any) => p.type === "reasoning")).toHaveLength(0);
  });
});

// ── Subtask lifecycle events ───────────────────────────────────────────────

describe("convertEvents — subtask lifecycle events", () => {
  it("subtask.start sets meta.status to running and records description", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.done", block: { type: "tool_use", id: "toolu_task1", name: "Agent", input: {} } }),
      re("e3", { type: "subtask.start", tool_use_id: "toolu_task1", description: "Run linter", kind: "worker" }),
    ];

    const messages = convertEvents(events, "idle");

    const tc = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(tc.result.meta.status).toBe("running");
    expect(tc.result.meta.description).toBe("Run linter");
  });

  it("subtask.progress records tokens, duration_ms, and last_tool", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.done", block: { type: "tool_use", id: "toolu_task1", name: "Agent", input: {} } }),
      re("e3", { type: "subtask.progress", tool_use_id: "toolu_task1", last_tool: "bash", tokens: 500, duration_ms: 1200 }),
    ];

    const messages = convertEvents(events, "idle");

    const tc = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(tc.result.meta.status).toBe("running");
    expect(tc.result.meta.last_tool).toBe("bash");
    expect(tc.result.meta.tokens).toBe(500);
    expect(tc.result.meta.duration_ms).toBe(1200);
  });

  it("subtask.end with status completed updates meta.status", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.done", block: { type: "tool_use", id: "toolu_task1", name: "Agent", input: {} } }),
      re("e3", { type: "subtask.end", tool_use_id: "toolu_task1", status: "completed", summary: "All done", tokens: 800, duration_ms: 5000 }),
    ];

    const messages = convertEvents(events, "idle");

    const tc = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(tc.result.meta.status).toBe("completed");
    expect(tc.result.meta.tokens).toBe(800);
    expect(tc.result.meta.duration_ms).toBe(5000);
  });

  it("subtask.end with status completed does not seed result.text from summary (tool_result arrives separately)", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.done", block: { type: "tool_use", id: "toolu_task1", name: "Agent", input: {} } }),
      re("e3", { type: "subtask.end", tool_use_id: "toolu_task1", status: "completed", summary: "Summary from subagent" }),
    ];

    const messages = convertEvents(events, "idle");

    const tc = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(tc.result.text).toBeUndefined();
  });

  it("subtask.end with status failed seeds result.text from summary", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.done", block: { type: "tool_use", id: "toolu_task1", name: "Agent", input: {} } }),
      re("e3", { type: "subtask.end", tool_use_id: "toolu_task1", status: "failed", summary: "Failure summary" }),
    ];

    const messages = convertEvents(events, "idle");

    const tc = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(tc.result.text).toBe("Failure summary");
  });

  it("subtask.end with status stopped seeds result.text from summary", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.done", block: { type: "tool_use", id: "toolu_task1", name: "Agent", input: {} } }),
      re("e3", { type: "subtask.end", tool_use_id: "toolu_task1", status: "stopped", summary: "Stopped summary" }),
    ];

    const messages = convertEvents(events, "idle");

    const tc = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(tc.result.text).toBe("Stopped summary");
  });

  it("subtask.end with status completed followed by block.done tool_result sets result.text from tool_result output", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.done", block: { type: "tool_use", id: "toolu_task1", name: "Agent", input: {} } }),
      re("e3", { type: "subtask.end", tool_use_id: "toolu_task1", status: "completed", summary: "Summary ignored" }),
      re("e4", { type: "block.done", block: { type: "tool_result", tool_use_id: "toolu_task1", output: "Final output from tool_result" } }),
    ];

    const messages = convertEvents(events, "idle");

    const tc = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(tc.result.text).toBe("Final output from tool_result");
  });

  it("subtask.end does not overwrite result.text when already set by outer tool_result", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.done", block: { type: "tool_use", id: "toolu_task1", name: "Agent", input: {} } }),
      // Outer tool_result sets text first
      re("e3", { type: "block.done", block: { type: "tool_result", tool_use_id: "toolu_task1", output: "Outer text wins" } }),
      re("e4", { type: "subtask.end", tool_use_id: "toolu_task1", status: "completed", summary: "Should not overwrite" }),
    ];

    const messages = convertEvents(events, "idle");

    const tc = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(tc.result.text).toBe("Outer text wins");
  });

  it("subtask lifecycle events for unknown tool_use_id are silently ignored", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.done", block: { type: "text", text: "main" } }),
      re("e3", { type: "subtask.start", tool_use_id: "unknown_id", description: "ghost task" }),
    ];

    const messages = convertEvents(events, "idle");

    // No crash, main message intact
    expect(messages).toHaveLength(1);
    const parts = messages[0].content as any[];
    expect(parts[0]).toEqual({ type: "text", text: "main" });
  });

  it("subtask.end with status failed sets meta.status to failed", () => {
    const events = [
      re("e1", { type: "turn.start" }),
      re("e2", { type: "block.done", block: { type: "tool_use", id: "toolu_task1", name: "Agent", input: {} } }),
      re("e3", { type: "subtask.end", tool_use_id: "toolu_task1", status: "failed" }),
    ];

    const messages = convertEvents(events, "idle");

    const tc = (messages[0].content as any[]).find((p: any) => p.type === "tool-call");
    expect(tc.result.meta.status).toBe("failed");
  });
});

// ── Subtask routing via legacy message event ──────────────────────────────

describe("convertEvents — legacy message event with mixed blocks", () => {
  it("routes subtask block to children, main block to parts", () => {
    const events = [
      // First establish the Task tool_use via a previous event
      re("e1", { type: "message", blocks: [{ type: "tool_use", id: "toolu_task1", name: "Agent", input: {} }] }),
      // A message event with both a main-agent text block and a subtask text block
      re("e2", {
        type: "message",
        blocks: [
          { type: "text", text: "main agent text" },
          { type: "text", text: "subtask text", parent_id: "toolu_task1" },
        ],
      }),
    ];

    const messages = convertEvents(events, "idle");

    // Should produce a single accumulated assistant message
    expect(messages).toHaveLength(1);
    const parts = messages[0].content as any[];

    // Main text goes to parts
    const textParts = parts.filter((p: any) => p.type === "text");
    expect(textParts).toHaveLength(1);
    expect(textParts[0].text).toBe("main agent text");

    // Subtask text goes to Task tool's children
    const tc = parts.find((p: any) => p.type === "tool-call");
    expect(tc.result.children).toHaveLength(1);
    expect(tc.result.children[0]).toEqual({ kind: "text", text: "subtask text" });
  });
});
