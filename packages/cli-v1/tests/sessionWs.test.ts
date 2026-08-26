import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { filterSessionEventsBySubagent, findMatchingSessionSubagents, findSessionSubagents, readSessionEvents } from "../src/sessionWs.js";

let sockets: FakeWebSocket[] = [];

class FakeWebSocket {
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: any[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }

  emit(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

class TerminatingFakeWebSocket extends FakeWebSocket {
  terminated = false;
  terminateCalls = 0;

  terminate() {
    this.terminated = true;
    this.terminateCalls += 1;
  }
}

beforeEach(() => {
  sockets = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function event(sequence: number, type = "message.completed", payload: Record<string, unknown> = {}) {
  return { id: `event-${sequence}`, sessionId: "session-1", sequence, createdAt: "2026-07-01T00:00:00.000Z", type, payload };
}

function sessionEvent(id: string, sequence: number, createdAt: string) {
  return {
    id,
    sessionId: "session-1",
    sequence,
    createdAt,
    type: "message.completed",
    payload: {
      message: {
        id: `message-${id}`,
        role: "assistant",
        content: [{ type: "text", text: id }],
      },
    },
  };
}

function idlessSessionEvent(messageId: string, sequence: number, text: string) {
  return {
    sessionId: "session-1",
    sequence,
    createdAt: "2026-07-03T10:00:00.000Z",
    type: "message.completed",
    payload: {
      message: {
        id: messageId,
        role: "assistant",
        content: [{ type: "text", text }],
      },
    },
  };
}

function assistantTextEvent(sequence: number, text: string) {
  return event(sequence, "message.completed", { message: { role: "assistant", content: [{ type: "text", text }] } });
}

function toolCallEvent(sequence: number) {
  return event(sequence, "message.completed", {
    message: { role: "assistant", content: [{ type: "tool_call", toolCall: { id: "call-1", name: "bash", input: { command: "echo ok" } } }] },
  });
}

function agentToolCallEvent(
  sequence: number,
  toolCallId: string,
  name: string,
  nameField: "subagentName" | "subagent_type" | "subagentType" = "subagentName",
) {
  return event(sequence, "message.completed", {
    message: {
      role: "assistant",
      content: [{ type: "tool_call", toolCall: { id: toolCallId, name: "agent", input: { [nameField]: name } } }],
    },
  });
}

function childTextEvent(sequence: number, parentToolCallId: string, text: string) {
  return event(sequence, "message.completed", {
    message: {
      role: "assistant",
      parentToolCallId,
      content: [{ type: "text", text }],
    },
  });
}

function childToolCallEvent(sequence: number, parentToolCallId: string, toolCallId: string) {
  return event(sequence, "message.completed", {
    message: {
      role: "assistant",
      parentToolCallId,
      content: [{ type: "tool_call", toolCall: { id: toolCallId, name: "bash", input: { command: "npm test" } } }],
    },
  });
}

function childToolResultEvent(sequence: number, parentToolCallId: string, toolCallId: string, output: string) {
  return event(sequence, "message.completed", {
    message: {
      role: "tool",
      parentToolCallId,
      content: [{ type: "tool_result", toolCallId, result: { stdout: output } }],
    },
  });
}

it("finds agent tool calls and filters descendant events by subagent name or tool call id", () => {
  const reviewerCall = agentToolCallEvent(1, "call-reviewer", "reviewer");
  const writerCall = agentToolCallEvent(2, "call-writer", "test-writer", "subagent_type");
  const reviewerText = childTextEvent(3, "call-reviewer", "reviewer started");
  const reviewerNestedTool = childToolCallEvent(4, "call-reviewer", "call-nested-tool");
  const reviewerNestedText = childTextEvent(5, "call-nested-tool", "nested tool output");
  const reviewerResult = childToolResultEvent(6, "call-reviewer", "call-reviewer", "review complete");
  const writerText = childTextEvent(7, "call-writer", "writer started");
  const mainText = assistantTextEvent(8, "main session output");
  const events = [reviewerCall, writerCall, reviewerText, reviewerNestedTool, reviewerNestedText, reviewerResult, writerText, mainText];

  expect(findSessionSubagents(events)).toEqual([
    { toolCallId: "call-reviewer", name: "reviewer" },
    { toolCallId: "call-writer", name: "test-writer" },
  ]);
  expect(findMatchingSessionSubagents(events, "reviewer")).toEqual([{ toolCallId: "call-reviewer", name: "reviewer" }]);
  expect(findMatchingSessionSubagents(events, "call-reviewer")).toEqual([{ toolCallId: "call-reviewer", name: "reviewer" }]);
  expect(filterSessionEventsBySubagent(events, "reviewer")).toEqual([reviewerText, reviewerNestedTool, reviewerNestedText, reviewerResult]);
  expect(filterSessionEventsBySubagent(events, "call-reviewer")).toEqual([reviewerText, reviewerNestedTool, reviewerNestedText, reviewerResult]);
});

it("hides subagent child events from the main stream while keeping the agent call and final result", async () => {
  const mainBefore = assistantTextEvent(1, "main before");
  const reviewerCall = agentToolCallEvent(2, "call-reviewer", "reviewer");
  const reviewerText = childTextEvent(3, "call-reviewer", "reviewer started");
  const reviewerNestedTool = childToolCallEvent(4, "call-reviewer", "call-nested-tool");
  const reviewerNestedText = childTextEvent(5, "call-nested-tool", "nested tool output");
  const reviewerResult = childToolResultEvent(6, "call-reviewer", "call-reviewer", "review complete");
  const mainAfter = assistantTextEvent(7, "main after");
  const events = [mainBefore, reviewerCall, reviewerText, reviewerNestedTool, reviewerNestedText, reviewerResult, mainAfter];

  const promise = readSessionEvents("wss://session.test", { mainStream: true });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ type: "backfill", requestId: "backfill-1", limit: 200 }));
  sockets[0].emit({ type: "backfill", events: [...events].reverse(), hasMore: false });

  await expect(promise).resolves.toEqual([mainBefore, reviewerCall, reviewerResult, mainAfter]);
});

it("continues backfilling main stream pages when hidden child events leave too few recent main events", async () => {
  const mainBefore = assistantTextEvent(1, "main before");
  const reviewerCall = agentToolCallEvent(2, "call-reviewer", "reviewer");
  const reviewerText = childTextEvent(3, "call-reviewer", "reviewer started");
  const reviewerNestedTool = childToolCallEvent(4, "call-reviewer", "call-nested-tool");

  const promise = readSessionEvents("wss://session.test", { mainStream: true, recentLimit: 3 });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ type: "backfill", requestId: "backfill-1", limit: 200 }));
  sockets[0].emit({ type: "backfill", events: [reviewerNestedTool, reviewerText], hasMore: true, nextCursor: 2 });

  await vi.waitFor(() => expect(sockets[0]?.sent[1]).toMatchObject({ type: "backfill", requestId: "backfill-2", limit: 200, cursor: 2 }));
  sockets[0].emit({ type: "backfill", events: [reviewerCall, mainBefore], hasMore: false });

  await expect(promise).resolves.toEqual([mainBefore, reviewerCall]);
});

it("continues backfilling main stream pages when recent child events have unresolved ancestry", async () => {
  const mainBefore = assistantTextEvent(1, "main before");
  const reviewerCall = agentToolCallEvent(2, "call-reviewer", "reviewer");
  const reviewerText = childTextEvent(3, "call-reviewer", "reviewer started");
  const reviewerTool = childToolCallEvent(4, "call-reviewer", "call-reviewer-tool");
  const reviewerResult = childToolResultEvent(5, "call-reviewer", "call-reviewer", "review complete");

  const promise = readSessionEvents("wss://session.test", { mainStream: true, recentLimit: 3 });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ type: "backfill", requestId: "backfill-1", limit: 200 }));
  sockets[0].emit({ type: "backfill", events: [reviewerResult, reviewerTool, reviewerText], hasMore: true, nextCursor: 3 });

  await vi.waitFor(() => expect(sockets[0]?.sent[1]).toMatchObject({ type: "backfill", requestId: "backfill-2", limit: 200, cursor: 3 }));
  sockets[0].emit({ type: "backfill", events: [reviewerCall, mainBefore], hasMore: false });

  await expect(promise).resolves.toEqual([mainBefore, reviewerCall, reviewerResult]);
});

it("does not emit unresolved child events from watched main stream backfill pages", async () => {
  const mainBefore = assistantTextEvent(1, "main before");
  const reviewerCall = agentToolCallEvent(2, "call-reviewer", "reviewer");
  const reviewerText = childTextEvent(3, "call-reviewer", "reviewer started");
  const reviewerTool = childToolCallEvent(4, "call-reviewer", "call-reviewer-tool");
  const reviewerResult = childToolResultEvent(5, "call-reviewer", "call-reviewer", "review complete");
  const seen: string[] = [];

  const promise = readSessionEvents("wss://session.test", {
    mainStream: true,
    watch: true,
    recentLimit: 3,
    onEvent: (item) =>
      seen.push(
        item.payload.message.content[0]?.text ?? item.payload.message.content[0]?.toolCall?.id ?? item.payload.message.content[0]?.result?.stdout,
      ),
  });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ type: "backfill", requestId: "backfill-1", limit: 200 }));
  sockets[0].emit({ type: "backfill", events: [reviewerResult, reviewerTool, reviewerText], hasMore: true, nextCursor: 3 });

  await vi.waitFor(() => expect(sockets[0]?.sent[1]).toMatchObject({ type: "backfill", requestId: "backfill-2", limit: 200, cursor: 3 }));
  expect(seen).toEqual([]);

  sockets[0].emit({ type: "backfill", events: [reviewerCall, mainBefore], hasMore: false });
  await vi.waitFor(() => expect(seen).toEqual(["main before", "call-reviewer", "review complete"]));
  expect(seen).not.toContain("reviewer started");
  expect(seen).not.toContain("call-reviewer-tool");

  sockets[0].onclose?.();
  await expect(promise).resolves.toEqual([mainBefore, reviewerCall, reviewerResult]);
});

it("requests recent events over WebSocket by default", async () => {
  const promise = readSessionEvents("wss://session.test");
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ type: "backfill", requestId: "backfill-1", limit: 20 }));
  expect(sockets[0]?.sent[0]).not.toHaveProperty("id");
  sockets[0].emit({ type: "backfill", events: [event(3), event(2)], hasMore: false });
  await expect(promise).resolves.toEqual([expect.objectContaining({ sequence: 2 }), expect.objectContaining({ sequence: 3 })]);
});

it("terminates the WebSocket when available after non-watch backfill finishes", async () => {
  vi.stubGlobal("WebSocket", TerminatingFakeWebSocket);

  const promise = readSessionEvents("wss://session.test");
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ type: "backfill", requestId: "backfill-1", limit: 20 }));
  const socket = sockets[0] as TerminatingFakeWebSocket;

  socket.emit({ type: "backfill", events: [event(1)], hasMore: false });

  await expect(promise).resolves.toEqual([expect.objectContaining({ sequence: 1 })]);
  expect(socket.terminateCalls).toBe(1);
  expect(socket.terminated).toBe(true);
  expect(socket.closed).toBe(false);
});

it("trims recent events locally when the server returns too many", async () => {
  const seen: number[] = [];
  const promise = readSessionEvents("wss://session.test", { recentLimit: 2, onEvent: (item) => seen.push(item.sequence) });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ type: "backfill", requestId: "backfill-1", limit: 2 }));
  expect(sockets[0]?.sent[0]).not.toHaveProperty("id");
  sockets[0].emit({ type: "backfill", events: [event(4), event(3), event(2), event(1)], hasMore: false });
  await expect(promise).resolves.toEqual([expect.objectContaining({ sequence: 3 }), expect.objectContaining({ sequence: 4 })]);
  expect(seen).toEqual([3, 4]);
});

it("follows backfill pages when --all is enabled", async () => {
  const promise = readSessionEvents("wss://session.test", { all: true });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ type: "backfill", requestId: "backfill-1", limit: 200 }));
  expect(sockets[0]?.sent[0]).not.toHaveProperty("id");
  sockets[0].emit({ type: "backfill", events: [event(1)], hasMore: true, nextCursor: 1 });
  await vi.waitFor(() => expect(sockets[0]?.sent[1]).toMatchObject({ type: "backfill", requestId: "backfill-2", limit: 200, cursor: 1 }));
  expect(sockets[0]?.sent[1]).not.toHaveProperty("id");
  sockets[0].emit({ type: "backfill", events: [event(2)], hasMore: false });
  await expect(promise).resolves.toEqual([expect.objectContaining({ sequence: 1 }), expect.objectContaining({ sequence: 2 })]);
  expect(sockets[0].closed).toBe(true);
});

it("deduplicates by stable event id and sorts by creation time then sequence", async () => {
  const seen: string[] = [];
  const promise = readSessionEvents("wss://session.test", {
    all: true,
    watch: true,
    onEvent: (item) => seen.push(item.id),
    backfillTimeoutMs: 10_000,
  });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ type: "backfill", requestId: "backfill-1", limit: 200 }));

  const sameSequenceLater = sessionEvent("same-sequence-later", 7, "2026-07-03T10:00:03.000Z");
  const duplicate = sessionEvent("duplicate", 8, "2026-07-03T10:00:04.000Z");
  const sameSequenceEarlier = sessionEvent("same-sequence-earlier", 7, "2026-07-03T10:00:01.000Z");
  const sameTimeLowerSequence = sessionEvent("same-time-lower-sequence", 2, "2026-07-03T10:00:02.000Z");
  const sameTimeHigherSequence = sessionEvent("same-time-higher-sequence", 5, "2026-07-03T10:00:02.000Z");

  sockets[0].emit({ type: "backfill", events: [sameSequenceLater, duplicate], hasMore: true, nextCursor: 1 });
  await vi.waitFor(() => expect(sockets[0]?.sent[1]).toMatchObject({ type: "backfill", requestId: "backfill-2", limit: 200, cursor: 1 }));
  sockets[0].emit({ type: "backfill", events: [sameSequenceEarlier, duplicate, sameTimeHigherSequence], hasMore: false });
  sockets[0].emit({ type: "event", record: duplicate });
  sockets[0].emit({ type: "event", record: sameTimeLowerSequence });
  sockets[0].onclose?.();

  await expect(promise).resolves.toEqual([
    expect.objectContaining({ id: "same-sequence-earlier", sequence: 7 }),
    expect.objectContaining({ id: "same-time-lower-sequence", sequence: 2 }),
    expect.objectContaining({ id: "same-time-higher-sequence", sequence: 5 }),
    expect.objectContaining({ id: "same-sequence-later", sequence: 7 }),
    expect.objectContaining({ id: "duplicate", sequence: 8 }),
  ]);
  expect(seen).toEqual(["same-sequence-later", "duplicate", "same-sequence-earlier", "same-time-higher-sequence", "same-time-lower-sequence"]);
});

it("deduplicates id-less events by message id without collapsing distinct messages at the same sequence", async () => {
  const promise = readSessionEvents("wss://session.test", { all: true });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ type: "backfill", requestId: "backfill-1", limit: 200 }));

  const first = idlessSessionEvent("message-a", 42, "first message");
  const duplicate = idlessSessionEvent("message-a", 42, "duplicate message");
  const distinctSameSequence = idlessSessionEvent("message-b", 42, "same sequence, different message");

  sockets[0].emit({ type: "backfill", events: [first, duplicate, distinctSameSequence], hasMore: false });

  const result = await promise;
  expect(result).toHaveLength(2);
  expect(result.every((item) => !("id" in item))).toBe(true);
  expect(result.map((item) => item.payload.message.id)).toEqual(["message-a", "message-b"]);
  expect(result.map((item) => item.payload.message.content[0].text)).toEqual(["first message", "same sequence, different message"]);
});

it("does not follow malformed string cursors", async () => {
  const promise = readSessionEvents("wss://session.test", { all: true });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ type: "backfill", requestId: "backfill-1", limit: 200 }));
  expect(sockets[0]?.sent[0]).not.toHaveProperty("id");
  sockets[0].emit({ type: "backfill", events: [event(1)], hasMore: true, nextCursor: "cursor-1" });
  await expect(promise).resolves.toEqual([expect.objectContaining({ sequence: 1 })]);
  expect(sockets[0].sent).toHaveLength(1);
});

it("rejects server error frames immediately", async () => {
  const promise = readSessionEvents("wss://session.test", { backfillTimeoutMs: 10_000 });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toBeDefined());
  sockets[0].emit({ type: "error", message: "Invalid session socket message" });
  await expect(promise).rejects.toThrow("Invalid session socket message");
});

it("rejects runner unavailable frames immediately", async () => {
  const promise = readSessionEvents("wss://session.test", { backfillTimeoutMs: 10_000 });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toBeDefined());
  sockets[0].emit({ type: "runner_unavailable", message: "runner offline" });
  await expect(promise).rejects.toThrow("runner offline");
});

it("filters assistant text events", async () => {
  const promise = readSessionEvents("wss://session.test", { filter: "assistant" });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toBeDefined());
  sockets[0].emit({
    type: "backfill",
    events: [assistantTextEvent(1, "hello"), toolCallEvent(2)],
    hasMore: false,
  });
  await expect(promise).resolves.toEqual([expect.objectContaining({ sequence: 1 })]);
});

it("filters tool events", async () => {
  const promise = readSessionEvents("wss://session.test", { filter: "tool" });
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toBeDefined());
  sockets[0].emit({
    type: "backfill",
    events: [assistantTextEvent(1, "hello"), toolCallEvent(2)],
    hasMore: false,
  });
  await expect(promise).resolves.toEqual([expect.objectContaining({ sequence: 2 })]);
});
