import { describe, expect, it } from "vitest";

import { amaEventToRelayEvent, convertEvents, type RelayEvent } from "@/features/tasks/components/RelayRuntimeProvider";

const timestamp = "2026-04-08T10:00:00.000Z";

function relay(id: string, event: RelayEvent["event"]): RelayEvent {
  return { id, event, timestamp };
}

function canonical(id: string, sequence: number, type: string, payload: Record<string, unknown>): RelayEvent {
  return amaEventToRelayEvent({
    id,
    sessionId: "session-1",
    sequence,
    createdAt: timestamp,
    type,
    payload,
  });
}

describe("Agency Session event projection", () => {
  it("maps canonical AMA EventRecord user and assistant messages", () => {
    const events = [
      canonical("turn-1", 1, "turn.started", {
        message: {
          id: "message-user-1",
          role: "user",
          content: [{ type: "text", text: "Run the checks" }],
        },
      }),
      canonical("message-1", 2, "message.completed", {
        message: {
          id: "message-assistant-1",
          role: "assistant",
          content: [{ type: "text", text: "Checks passed" }],
        },
      }),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(2);
    expect(messages.map(({ role }) => role)).toEqual(["user", "assistant"]);
    expect(messages[0].content).toEqual([{ type: "text", text: "Run the checks" }]);
    expect(messages[1].content).toEqual([{ type: "text", text: "Checks passed" }]);
  });

  it("attaches a canonical AMA tool result to its assistant tool call", () => {
    const events = [
      canonical("tool-call", 1, "message.completed", {
        message: {
          id: "message-tool-call",
          role: "assistant",
          content: [
            {
              type: "tool_call",
              toolCall: {
                id: "call-1",
                name: "bash",
                input: { command: "pnpm test" },
              },
            },
          ],
        },
      }),
      canonical("tool-result", 2, "message.completed", {
        message: {
          id: "message-tool-result",
          role: "tool",
          parentToolCallId: "call-1",
          content: [
            {
              type: "tool_result",
              toolCallId: "call-1",
              result: { content: [{ type: "text", text: "all green" }], exitCode: 0 },
            },
          ],
        },
      }),
    ];

    const messages = convertEvents(events, "idle");

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "Bash",
        args: { command: "pnpm test" },
        result: "all green",
      },
    ]);
  });

  it("projects open and completed turns with their exact UI status", () => {
    const open = convertEvents(
      [
        relay("turn-open", { type: "turn.start" }),
        relay("block-open", {
          type: "block.done",
          block: { type: "text", text: "Working" },
        }),
      ],
      "working",
    );
    const completed = convertEvents(
      [
        relay("turn-complete", { type: "turn.start" }),
        relay("block-complete", {
          type: "block.done",
          block: { type: "text", text: "Finished" },
        }),
        relay("turn-end", { type: "turn.end" }),
      ],
      "idle",
    );

    expect(open[0].status).toEqual({ type: "running" });
    expect(completed[0].status).toEqual({ type: "complete", reason: "unknown" });
  });

  it("routes nested subtask output into the outer Agent tool result in event order", () => {
    const events = [
      relay("turn", { type: "turn.start" }),
      relay("agent", {
        type: "block.done",
        block: {
          type: "tool_use",
          id: "outer-agent",
          name: "Agent",
          input: { description: "Review the change" },
        },
      }),
      relay("nested-agent", {
        type: "block.done",
        block: {
          type: "tool_use",
          id: "nested-agent",
          name: "Agent",
          input: { description: "Inspect tests" },
          parent_id: "outer-agent",
        },
      }),
      relay("nested-text", {
        type: "block.done",
        block: { type: "text", text: "Nested result", parent_id: "nested-agent" },
      }),
      relay("nested-tool", {
        type: "block.done",
        block: {
          type: "tool_use",
          id: "nested-bash",
          name: "Bash",
          input: { command: "pnpm test" },
          parent_id: "nested-agent",
        },
      }),
      relay("nested-tool-result", {
        type: "block.done",
        block: {
          type: "tool_result",
          tool_use_id: "nested-bash",
          output: "passed",
          error: false,
          parent_id: "nested-agent",
        },
      }),
      relay("outer-result", {
        type: "block.done",
        block: {
          type: "tool_result",
          tool_use_id: "outer-agent",
          output: "Review complete",
        },
      }),
    ];

    const messages = convertEvents(events, "idle");
    const outer = messages[0].content[0];

    expect(outer).toMatchObject({
      type: "tool-call",
      toolCallId: "outer-agent",
      toolName: "Agent",
      result: {
        text: "Review complete",
        children: [
          {
            kind: "tool_use",
            id: "nested-agent",
            name: "Agent",
            input: { description: "Inspect tests" },
          },
          { kind: "text", text: "Nested result" },
          {
            kind: "tool_use",
            id: "nested-bash",
            name: "Bash",
            input: { command: "pnpm test" },
          },
          {
            kind: "tool_result",
            tool_use_id: "nested-bash",
            output: "passed",
            error: false,
          },
        ],
      },
    });
  });
});
