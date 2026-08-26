// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("../packages/cli/src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// Mock node:child_process so acpExecute/acpGetHistory never spawns real processes
// ---------------------------------------------------------------------------
vi.mock("node:child_process", () => {
  const { PassThrough } = require("node:stream");

  function makeMockProc() {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const proc = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 12345,
      killed: false,
      kill: vi.fn((_sig?: string) => {
        // Simulate the process dying on kill — fire close immediately
        proc.killed = true;
        const cbs = listeners.close ?? [];
        for (const cb of cbs) cb(0, null);
      }),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners[event] = listeners[event] ?? [];
        listeners[event].push(cb);
      }),
      _listeners: listeners,
    };
    return proc;
  }

  return {
    spawn: vi.fn(() => makeMockProc()),
  };
});

// ---------------------------------------------------------------------------
// Mock ndJsonStream — we don't care about stream plumbing in unit tests
// ---------------------------------------------------------------------------
vi.mock("@agentclientprotocol/sdk", async () => {
  // We need real SessionUpdate, RequestPermissionRequest types for type-checking
  // but we replace the runtime classes.

  // Shared mutable handles that tests wire up per-test
  const handles = {
    toClientCb: null as ((agent: unknown) => unknown) | null,
    mockConn: null as MockConn | null,
  };

  class MockConn {
    _toClientCb: (agent: unknown) => unknown;
    _client: unknown = null;

    initialize = vi.fn().mockResolvedValue({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
    newSession = vi.fn().mockResolvedValue({ sessionId: "mock-session-id" });
    loadSession = vi.fn().mockResolvedValue({});
    prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } });
    cancel = vi.fn().mockResolvedValue({});

    constructor(toClientCb: (agent: unknown) => unknown, _stream: unknown) {
      this._toClientCb = toClientCb;
      handles.toClientCb = toClientCb;
      handles.mockConn = this;
    }

    /** Call this to simulate a session_update notification arriving from the agent. */
    simulateSessionUpdate(params: { sessionId: string; update: unknown }) {
      if (this._client === null) {
        // Lazily resolve client on first use
        this._client = this._toClientCb(this);
      }
      return (this._client as any).sessionUpdate(params);
    }
  }

  return {
    ClientSideConnection: MockConn,
    ndJsonStream: vi.fn(() => ({}) as any),
    PROTOCOL_VERSION: 1,
    // expose handles for test access
    __handles: handles,
  };
});

import { ToolName } from "@agent-kanban/shared";
import type { RequestPermissionRequest, SessionUpdate } from "@agentclientprotocol/sdk";
import {
  autoApprove,
  buildTurnEnd,
  createAcpProvider,
  EventQueue,
  type MapState,
  mapSessionUpdate,
  mapToolName,
} from "../packages/cli/src/providers/acp.js";

// Restore all spies after each test so vi.spyOn mocks don't bleed between tests
afterEach(() => {
  vi.restoreAllMocks();
});

function freshState(): MapState {
  return { turnOpen: false, pendingTools: new Map() };
}

function collect(update: SessionUpdate, state: MapState) {
  return [...mapSessionUpdate(update, state)];
}

describe("mapSessionUpdate — turn.start", () => {
  it("emits turn.start once at the start of a turn", () => {
    const state = freshState();
    const first = collect({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } as SessionUpdate, state);
    expect(first[0]).toEqual({ type: "turn.start" });
    const second = collect({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "again" } } as SessionUpdate, state);
    expect(second.find((e) => e.type === "turn.start")).toBeUndefined();
  });
});

describe("mapSessionUpdate — agent_message_chunk", () => {
  it("emits text block.start + block.done with chunk text", () => {
    const state = freshState();
    const events = collect({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello world" } } as SessionUpdate, state);
    expect(events).toEqual([
      { type: "turn.start" },
      { type: "block.start", block: { type: "text", text: "" } },
      { type: "block.done", block: { type: "text", text: "hello world" } },
    ]);
  });

  it("skips empty text chunks", () => {
    const state = freshState();
    const events = collect({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } } as SessionUpdate, state);
    expect(events).toEqual([{ type: "turn.start" }]);
  });

  it("skips non-text content", () => {
    const state = freshState();
    const events = collect(
      { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "…", mimeType: "image/png" } } as SessionUpdate,
      state,
    );
    expect(events).toEqual([{ type: "turn.start" }]);
  });
});

describe("mapSessionUpdate — agent_thought_chunk", () => {
  it("emits thinking block.start + block.done", () => {
    const state = freshState();
    const events = collect({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "pondering" } } as SessionUpdate, state);
    expect(events).toEqual([
      { type: "turn.start" },
      { type: "block.start", block: { type: "thinking", text: "" } },
      { type: "block.done", block: { type: "thinking", text: "pondering" } },
    ]);
  });
});

describe("mapSessionUpdate — tool_call", () => {
  it("opens a tool_use block and tracks it by id", () => {
    const state = freshState();
    const events = collect(
      {
        sessionUpdate: "tool_call",
        toolCallId: "t-1",
        kind: "execute",
        title: "bash cmd",
        rawInput: { command: "ls" },
      } as SessionUpdate,
      state,
    );
    expect(events).toContainEqual({
      type: "block.start",
      block: { type: "tool_use", id: "t-1", name: ToolName.Bash, input: { command: "ls" } },
    });
    expect(state.pendingTools.has("t-1")).toBe(true);
  });

  it("falls back to title when tool kind has no canonical mapping", () => {
    const state = freshState();
    const events = collect(
      { sessionUpdate: "tool_call", toolCallId: "t-2", kind: "other", title: "weird_tool", rawInput: {} } as SessionUpdate,
      state,
    );
    expect(events).toContainEqual({
      type: "block.start",
      block: { type: "tool_use", id: "t-2", name: "weird_tool", input: {} },
    });
  });

  it("maps ACP kinds to canonical tool names", () => {
    for (const [kind, expected] of [
      ["read", ToolName.Read],
      ["edit", ToolName.Edit],
      ["search", ToolName.Grep],
      ["fetch", ToolName.WebFetch],
    ] as const) {
      const state = freshState();
      const events = collect({ sessionUpdate: "tool_call", toolCallId: `t-${kind}`, kind, title: "x", rawInput: {} } as SessionUpdate, state);
      const block = events.find((e) => e.type === "block.start")!.block;
      expect(block.type).toBe("tool_use");
      if (block.type === "tool_use") expect(block.name).toBe(expected);
    }
  });
});

describe("mapSessionUpdate — tool_call_update", () => {
  it("closes tool_use and emits tool_result on completed", () => {
    const state = freshState();
    collect({ sessionUpdate: "tool_call", toolCallId: "t-3", kind: "execute", title: "bash", rawInput: { command: "pwd" } } as SessionUpdate, state);
    const events = collect(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t-3",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "/home/x" } }],
      } as SessionUpdate,
      state,
    );
    const doneBlocks = events.filter((e) => e.type === "block.done");
    expect(doneBlocks).toHaveLength(2);
    expect(doneBlocks[0].block.type).toBe("tool_use");
    expect(doneBlocks[1].block).toEqual({ type: "tool_result", tool_use_id: "t-3", output: "/home/x" });
    expect(state.pendingTools.has("t-3")).toBe(false);
  });

  it("marks tool_result with error=true on failed", () => {
    const state = freshState();
    collect({ sessionUpdate: "tool_call", toolCallId: "t-4", kind: "execute", title: "bash", rawInput: {} } as SessionUpdate, state);
    const events = collect({ sessionUpdate: "tool_call_update", toolCallId: "t-4", status: "failed", content: [] } as SessionUpdate, state);
    const result = events.find((e) => e.type === "block.done" && e.block.type === "tool_result");
    expect(result).toBeDefined();
    if (result && result.type === "block.done" && result.block.type === "tool_result") {
      expect(result.block.error).toBe(true);
    }
  });

  it("ignores in_progress/pending status updates", () => {
    const state = freshState();
    collect({ sessionUpdate: "tool_call", toolCallId: "t-5", kind: "execute", title: "bash", rawInput: {} } as SessionUpdate, state);
    const events = collect({ sessionUpdate: "tool_call_update", toolCallId: "t-5", status: "in_progress" } as SessionUpdate, state);
    expect(events.filter((e) => e.type === "block.done")).toHaveLength(0);
    expect(state.pendingTools.has("t-5")).toBe(true);
  });

  it("uses rawOutput when content is missing", () => {
    const state = freshState();
    collect({ sessionUpdate: "tool_call", toolCallId: "t-6", kind: "read", title: "read", rawInput: {} } as SessionUpdate, state);
    const events = collect(
      { sessionUpdate: "tool_call_update", toolCallId: "t-6", status: "completed", rawOutput: "plain string" } as SessionUpdate,
      state,
    );
    const result = events.find((e) => e.type === "block.done" && e.block.type === "tool_result");
    if (result && result.type === "block.done" && result.block.type === "tool_result") {
      expect(result.block.output).toBe("plain string");
    }
  });

  it("drops orphan updates with no prior tool_call", () => {
    const state = freshState();
    // Prime turn.start so we can assert orphan path produces nothing else.
    collect({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } as SessionUpdate, state);
    const events = collect({ sessionUpdate: "tool_call_update", toolCallId: "unknown", status: "completed", rawOutput: "x" } as SessionUpdate, state);
    expect(events.filter((e) => e.type === "block.done")).toHaveLength(0);
  });

  it("falls back to rawOutput when content has only non-text items", () => {
    const state = freshState();
    collect({ sessionUpdate: "tool_call", toolCallId: "t-7", kind: "edit", title: "edit", rawInput: {} } as SessionUpdate, state);
    const events = collect(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t-7",
        status: "completed",
        content: [{ type: "diff", path: "/a.txt", oldText: "a", newText: "b" }],
        rawOutput: "applied",
      } as SessionUpdate,
      state,
    );
    const result = events.find((e) => e.type === "block.done" && e.block.type === "tool_result");
    if (result && result.type === "block.done" && result.block.type === "tool_result") {
      expect(result.block.output).toBe("applied");
    }
  });
});

describe("mapSessionUpdate — unknown variants", () => {
  it("emits only turn.start for plan/commands/mode updates", () => {
    const state = freshState();
    const events = collect({ sessionUpdate: "plan", entries: [] } as unknown as SessionUpdate, state);
    expect(events).toEqual([{ type: "turn.start" }]);
  });
});

// ---------------------------------------------------------------------------
// Helper to get the mock connection created by the last acpExecute/acpGetHistory call
// ---------------------------------------------------------------------------

async function getMockConn() {
  const sdk = await import("@agentclientprotocol/sdk");
  return (sdk as any).__handles.mockConn as {
    initialize: ReturnType<typeof vi.fn>;
    newSession: ReturnType<typeof vi.fn>;
    loadSession: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    simulateSessionUpdate: (params: { sessionId: string; update: unknown }) => Promise<void>;
  };
}

function makeProvider() {
  return createAcpProvider({
    runtime: "acp-test" as any,
    label: "ACP Test",
    command: "fake-acp-agent",
    args: [],
  });
}

// ---------------------------------------------------------------------------
// Gap 10: EventQueue mechanics
// ---------------------------------------------------------------------------

describe("EventQueue — push then iterate yields events", () => {
  it("yields pushed events in order", async () => {
    const q = new EventQueue();
    q.push({ type: "turn.start" });
    q.push({ type: "turn.end", cost: 0, usage: undefined });
    q.finish();
    const collected: unknown[] = [];
    for await (const e of q.iterate()) collected.push(e);
    expect(collected).toEqual([{ type: "turn.start" }, { type: "turn.end", cost: 0, usage: undefined }]);
  });

  it("iterating empty queue waits until finish() is called", async () => {
    const q = new EventQueue();
    setTimeout(() => {
      q.push({ type: "turn.start" });
      q.finish();
    }, 0);
    const collected: unknown[] = [];
    for await (const e of q.iterate()) collected.push(e);
    expect(collected).toEqual([{ type: "turn.start" }]);
  });

  it("finish(err) causes iterate() to throw after draining buffered events", async () => {
    const q = new EventQueue();
    q.push({ type: "turn.start" });
    q.finish(new Error("boom"));
    const collected: unknown[] = [];
    let caught: unknown;
    try {
      for await (const e of q.iterate()) collected.push(e);
    } catch (err) {
      caught = err;
    }
    // Buffered event is still yielded before the throw
    expect(collected).toEqual([{ type: "turn.start" }]);
    expect((caught as Error).message).toBe("boom");
  });

  it("double finish() is idempotent — does not throw or alter done state", () => {
    const q = new EventQueue();
    q.finish();
    expect(() => q.finish()).not.toThrow();
    expect(q.done).toBe(true);
  });

  it("push after done is silently dropped", async () => {
    const q = new EventQueue();
    q.finish();
    q.push({ type: "turn.start" }); // must not throw
    const collected: unknown[] = [];
    for await (const e of q.iterate()) collected.push(e);
    expect(collected).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Gap 9: buildTurnEnd — pure function
// ---------------------------------------------------------------------------

describe("buildTurnEnd — with usage", () => {
  it("maps inputTokens and outputTokens", () => {
    const result = buildTurnEnd({
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 10, cachedWriteTokens: 5 },
    } as any);
    expect(result.type).toBe("turn.end");
    if (result.type === "turn.end") {
      expect(result.usage?.input_tokens).toBe(100);
      expect(result.usage?.output_tokens).toBe(50);
      expect(result.usage?.cache_read_input_tokens).toBe(10);
      expect(result.usage?.cache_creation_input_tokens).toBe(5);
    }
  });

  it("defaults cache token fields to 0 when absent", () => {
    const result = buildTurnEnd({
      stopReason: "end_turn",
      usage: { inputTokens: 20, outputTokens: 10 },
    } as any);
    if (result.type === "turn.end") {
      expect(result.usage?.cache_read_input_tokens).toBe(0);
      expect(result.usage?.cache_creation_input_tokens).toBe(0);
    }
  });

  it("sets usage to undefined when resp.usage is absent", () => {
    const result = buildTurnEnd({ stopReason: "end_turn" } as any);
    if (result.type === "turn.end") {
      expect(result.usage).toBeUndefined();
    }
  });

  it("always sets cost to 0", () => {
    const result = buildTurnEnd({ stopReason: "end_turn" } as any);
    if (result.type === "turn.end") {
      expect(result.cost).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Gap 8: mapToolName — undefined kind and empty title
// ---------------------------------------------------------------------------

describe("mapToolName — edge cases", () => {
  it("falls back to title when kind is undefined", () => {
    expect(mapToolName(undefined, "my_custom_tool")).toBe("my_custom_tool");
  });

  it("falls back to 'tool' when kind is undefined and title is empty", () => {
    expect(mapToolName(undefined, "")).toBe("tool");
  });

  it("returns canonical name for known kind even when title is set", () => {
    expect(mapToolName("execute" as any, "anything")).toBe(ToolName.Bash);
  });
});

// ---------------------------------------------------------------------------
// Gap 7: autoApprove
// ---------------------------------------------------------------------------

describe("autoApprove — permission approval logic", () => {
  it("prefers allow_once over allow_always", () => {
    const params = {
      options: [
        { kind: "allow_always", optionId: "always-1" },
        { kind: "allow_once", optionId: "once-1" },
      ],
    } as unknown as RequestPermissionRequest;
    const result = autoApprove(params);
    expect(result).toEqual({ outcome: "selected", optionId: "once-1" });
  });

  it("falls back to allow_always when no allow_once exists", () => {
    const params = {
      options: [
        { kind: "deny", optionId: "deny-1" },
        { kind: "allow_always", optionId: "always-1" },
      ],
    } as unknown as RequestPermissionRequest;
    const result = autoApprove(params);
    expect(result).toEqual({ outcome: "selected", optionId: "always-1" });
  });

  it("returns cancelled when neither allow_once nor allow_always exists", () => {
    const params = {
      options: [{ kind: "deny", optionId: "deny-1" }],
    } as unknown as RequestPermissionRequest;
    const result = autoApprove(params);
    expect(result).toEqual({ outcome: "cancelled" });
  });

  it("returns cancelled for empty options array", () => {
    const params = { options: [] } as unknown as RequestPermissionRequest;
    const result = autoApprove(params);
    expect(result).toEqual({ outcome: "cancelled" });
  });
});

// ---------------------------------------------------------------------------
// Gap 1: acpExecute happy path
// ---------------------------------------------------------------------------

describe("acpExecute — happy path", () => {
  it("resolves to an AgentHandle with events, abort, send, getResumeToken", async () => {
    const provider = makeProvider();
    const handle = await provider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "do work" });
    // Drain events so process cleanup doesn't leak
    for await (const _ of handle.events) {
    }
    expect(handle).toHaveProperty("events");
    expect(typeof handle.abort).toBe("function");
    expect(typeof handle.send).toBe("function");
    expect(typeof handle.getResumeToken).toBe("function");
  });

  it("calls initialize then newSession when resume is false", async () => {
    const provider = makeProvider();
    const handle = await provider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx" });
    const conn = await getMockConn();
    // Drain events
    for await (const _ of handle.events) {
    }
    expect(conn.initialize).toHaveBeenCalledOnce();
    expect(conn.newSession).toHaveBeenCalledOnce();
    expect(conn.loadSession).not.toHaveBeenCalled();
  });

  it("events stream includes turn.start when a session_update arrives before prompt resolves", async () => {
    // Set up a deferred prompt BEFORE executing so we control when it resolves
    let resolvePrompt!: (v: unknown) => void;
    const promptDeferred = new Promise<unknown>((res) => {
      resolvePrompt = res;
    });

    const sdk = await import("@agentclientprotocol/sdk");
    (sdk as any).__handles.promptOverride = promptDeferred;

    // Override the mock conn's prompt to use our deferred
    const provider = makeProvider();

    // Patch: after execute() creates the conn, override its prompt before it is called
    // We need to set this up before execute so we hook into the constructor
    // Strategy: override ClientSideConnection for this one call
    let capturedConn: any;
    const _OrigClass = (sdk as any).ClientSideConnection;
    vi.spyOn(sdk as any, "ClientSideConnection").mockImplementationOnce(function (this: any, toClientCb: any, stream: any) {
      capturedConn = {
        _toClientCb: toClientCb,
        _client: null as any,
        initialize: vi.fn().mockResolvedValue({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }),
        newSession: vi.fn().mockResolvedValue({ sessionId: "mock-session-id" }),
        loadSession: vi.fn().mockResolvedValue({}),
        prompt: vi.fn().mockReturnValue(promptDeferred),
        cancel: vi.fn().mockResolvedValue({}),
        simulateSessionUpdate(params: any) {
          if (capturedConn._client === null) {
            capturedConn._client = toClientCb(capturedConn);
          }
          return (capturedConn._client as any).sessionUpdate(params);
        },
      };
      return capturedConn;
    });

    const handle = await provider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx" });

    // Simulate a session_update notification
    await capturedConn.simulateSessionUpdate({
      sessionId: "mock-session-id",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
    });

    // Now resolve prompt
    resolvePrompt({ stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 3 } });

    const events: unknown[] = [];
    for await (const e of handle.events) events.push(e);

    expect(events.some((e: any) => e.type === "turn.start")).toBe(true);
    expect(events.some((e: any) => e.type === "turn.end")).toBe(true);
  });

  it("getResumeToken returns the ACP sessionId after successful execute", async () => {
    const sdk = await import("@agentclientprotocol/sdk");

    vi.spyOn(sdk as any, "ClientSideConnection").mockImplementationOnce(function (this: any, toClientCb: any, _stream: any) {
      return {
        _toClientCb: toClientCb,
        initialize: vi.fn().mockResolvedValue({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }),
        newSession: vi.fn().mockResolvedValue({ sessionId: "acp-sess-xyz" }),
        loadSession: vi.fn().mockResolvedValue({}),
        prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 3 } }),
        cancel: vi.fn().mockResolvedValue({}),
      };
    });

    const provider = makeProvider();
    const handle = await provider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx" });
    // Wait for events to drain so promptDone runs
    for await (const _ of handle.events) {
    }
    expect(handle.getResumeToken?.()).toBe("acp-sess-xyz");
  });
});

// ---------------------------------------------------------------------------
// Gap 2: acpExecute with resume=true
// ---------------------------------------------------------------------------

describe("acpExecute — resume=true", () => {
  it("calls loadSession instead of newSession when resume is true and resumeToken is set", async () => {
    const sdk = await import("@agentclientprotocol/sdk");
    let connInstance: any;
    vi.spyOn(sdk as any, "ClientSideConnection").mockImplementationOnce(function (this: any, toClientCb: any, _stream: any) {
      connInstance = {
        initialize: vi.fn().mockResolvedValue({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }),
        newSession: vi.fn().mockResolvedValue({ sessionId: "s" }),
        loadSession: vi.fn().mockResolvedValue({}),
        prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
        cancel: vi.fn().mockResolvedValue({}),
      };
      return connInstance;
    });

    const provider = makeProvider();
    const handle = await provider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx", resume: true, resumeToken: "prior-session" });
    for await (const _ of handle.events) {
    }
    expect(connInstance.loadSession).toHaveBeenCalledOnce();
    expect(connInstance.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "prior-session" }));
    expect(connInstance.newSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Gap 3: openSession fail-fast when resume=true but no resumeToken
// ---------------------------------------------------------------------------

describe("acpExecute — resume=true without resumeToken throws", () => {
  it("throws 'acp: resume requested but no resumeToken provided'", async () => {
    const provider = makeProvider();
    await expect(provider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx", resume: true })).rejects.toThrow(
      "acp: resume requested but no resumeToken provided",
    );
  });
});

// ---------------------------------------------------------------------------
// Gap 4: abort() race guard — prompt resolves after abort → no turn.end
// ---------------------------------------------------------------------------

describe("acpExecute — abort race guard", () => {
  it("does not push turn.end when abort() is called before prompt resolves", async () => {
    let resolvePrompt!: (v: unknown) => void;
    const promptDeferred = new Promise<unknown>((res) => {
      resolvePrompt = res;
    });

    const sdk = await import("@agentclientprotocol/sdk");
    vi.spyOn(sdk as any, "ClientSideConnection").mockImplementationOnce((_toClientCb: any, _stream: any) => ({
      initialize: vi.fn().mockResolvedValue({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }),
      newSession: vi.fn().mockResolvedValue({ sessionId: "mock-session-id" }),
      loadSession: vi.fn().mockResolvedValue({}),
      prompt: vi.fn().mockReturnValue(promptDeferred),
      cancel: vi.fn().mockResolvedValue({}),
    }));

    const provider = makeProvider();
    const handle = await provider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx" });

    // Abort before prompt resolves
    const abortPromise = handle.abort();

    // Resolve the prompt after abort (race condition)
    resolvePrompt({ stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 3 } });

    await abortPromise;

    const events: unknown[] = [];
    for await (const e of handle.events) events.push(e);

    expect(events.some((e: any) => e.type === "turn.end")).toBe(false);
  });

  it("does not push turn.error when abort() is called before prompt rejects", async () => {
    let _rejectPrompt!: (err: unknown) => void;
    // Attach a noop catch handler immediately to prevent unhandled rejection
    const _promptDeferred = new Promise<unknown>((_res, rej) => {
      _rejectPrompt = rej;
    }).catch(() => {});
    // The above makes promptDeferred always resolve (to undefined) from the test's PoV.
    // But the impl receives the inner promise from conn.prompt, which can reject.
    // We rebuild: give conn.prompt a rejectable promise, and suppress it at test level separately.

    let rejectInner!: (err: unknown) => void;
    const innerPromise = new Promise<unknown>((_res, rej) => {
      rejectInner = rej;
    });
    // Suppress unhandled rejection for the inner promise
    innerPromise.catch(() => {});

    const sdk = await import("@agentclientprotocol/sdk");
    vi.spyOn(sdk as any, "ClientSideConnection").mockImplementationOnce((_toClientCb: any, _stream: any) => ({
      initialize: vi.fn().mockResolvedValue({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }),
      newSession: vi.fn().mockResolvedValue({ sessionId: "mock-session-id" }),
      loadSession: vi.fn().mockResolvedValue({}),
      prompt: vi.fn().mockReturnValue(innerPromise),
      cancel: vi.fn().mockResolvedValue({}),
    }));

    const provider = makeProvider();
    const handle = await provider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx" });

    // Abort before prompt rejects
    const abortPromise = handle.abort();

    // Reject prompt after abort (race condition) — abort()'s promptDone.catch(()=>{}) will swallow it
    rejectInner(new Error("cancelled by agent"));

    await abortPromise;

    const events: unknown[] = [];
    for await (const e of handle.events) events.push(e);

    expect(events.some((e: any) => e.type === "turn.error")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gap 5: getResumeToken() returns undefined after abort
// ---------------------------------------------------------------------------

describe("acpExecute — getResumeToken after abort", () => {
  it("returns undefined after abort() is called", async () => {
    // Use a deferred prompt so we can abort before it resolves
    let resolvePrompt!: (v: unknown) => void;
    const promptDeferred = new Promise<unknown>((res) => {
      resolvePrompt = res;
    });

    const sdk = await import("@agentclientprotocol/sdk");
    vi.spyOn(sdk as any, "ClientSideConnection").mockImplementationOnce((_toClientCb: any, _stream: any) => ({
      initialize: vi.fn().mockResolvedValue({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }),
      newSession: vi.fn().mockResolvedValue({ sessionId: "abort-session" }),
      loadSession: vi.fn().mockResolvedValue({}),
      prompt: vi.fn().mockReturnValue(promptDeferred),
      cancel: vi.fn().mockResolvedValue({}),
    }));

    const provider = makeProvider();
    const handle = await provider.execute({ sessionId: "s1", cwd: "/tmp", env: {}, taskContext: "ctx" });

    const abortPromise = handle.abort();
    // Resolve the deferred so runPromptLoop can return
    resolvePrompt({ stopReason: "end_turn" });
    await abortPromise;

    expect(handle.getResumeToken?.()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gap 6: acpGetHistory
// ---------------------------------------------------------------------------

describe("acpGetHistory — empty resumeToken returns []", () => {
  it("returns empty array immediately when resumeToken is undefined", async () => {
    const provider = makeProvider();
    const history = await provider.getHistory("session-1", undefined);
    expect(history).toEqual([]);
  });

  it("returns empty array when resumeToken is empty string", async () => {
    const provider = makeProvider();
    const history = await provider.getHistory("session-1", "");
    expect(history).toEqual([]);
  });
});

describe("acpGetHistory — normal case returns mapped HistoryEvents", () => {
  it("returns HistoryEvent[] with id, timestamp, and event for each session_update", async () => {
    const provider = makeProvider();

    // We need loadSession to trigger a simulateSessionUpdate call.
    // The easiest way: override loadSession to call simulateSessionUpdate on the conn
    // after the client has been created by ClientSideConnection constructor.
    const sdk = await import("@agentclientprotocol/sdk");
    const MockConn = (sdk as any).ClientSideConnection;

    let connInstance: any;
    const _OriginalMockConn = MockConn;

    // Temporarily override so we can capture the instance and inject a notification
    vi.spyOn(sdk as any, "ClientSideConnection").mockImplementationOnce(function (this: any, toClientCb: any, stream: any) {
      // We use the original constructor logic via a fresh instance
      connInstance = {
        _toClientCb: toClientCb,
        _client: null,
        initialize: vi.fn().mockResolvedValue({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }),
        newSession: vi.fn().mockResolvedValue({ sessionId: "hist-session" }),
        loadSession: vi.fn().mockImplementation(async () => {
          // Simulate history replay: call sessionUpdate before resolving
          if (connInstance._client === null) {
            connInstance._client = toClientCb(connInstance);
          }
          await (connInstance._client as any).sessionUpdate({
            sessionId: "hist-session",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "historical message" } },
          });
          return {};
        }),
        cancel: vi.fn().mockResolvedValue({}),
        prompt: vi.fn().mockResolvedValue({}),
      };
      return connInstance;
    });

    const history = await provider.getHistory("session-1", "hist-session");

    expect(history.length).toBeGreaterThan(0);
    for (const entry of history) {
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.timestamp).toBe("string");
      expect(entry.event).toBeDefined();
    }
  });

  it("returns events that went through mapSessionUpdate (turn.start emitted)", async () => {
    const provider = makeProvider();
    const sdk = await import("@agentclientprotocol/sdk");

    vi.spyOn(sdk as any, "ClientSideConnection").mockImplementationOnce(function (this: any, toClientCb: any, _stream: any) {
      const connInstance = {
        _toClientCb: toClientCb,
        _client: null as any,
        initialize: vi.fn().mockResolvedValue({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }),
        newSession: vi.fn().mockResolvedValue({ sessionId: "s" }),
        loadSession: vi.fn().mockImplementation(async () => {
          if (connInstance._client === null) {
            connInstance._client = toClientCb(connInstance);
          }
          await connInstance._client.sessionUpdate({
            sessionId: "s",
            update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
          });
          return {};
        }),
        cancel: vi.fn().mockResolvedValue({}),
        prompt: vi.fn().mockResolvedValue({}),
      };
      return connInstance;
    });

    const history = await provider.getHistory("s1", "token-abc");
    const types = history.map((h) => h.event.type);
    expect(types).toContain("turn.start");
  });
});

describe("acpGetHistory — loadSession rejection is swallowed", () => {
  it("returns what was collected so far without throwing when loadSession rejects", async () => {
    const provider = makeProvider();
    const sdk = await import("@agentclientprotocol/sdk");

    vi.spyOn(sdk as any, "ClientSideConnection").mockImplementationOnce(function (this: any, toClientCb: any, _stream: any) {
      const connInstance = {
        _toClientCb: toClientCb,
        _client: null as any,
        initialize: vi.fn().mockResolvedValue({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }),
        newSession: vi.fn().mockResolvedValue({ sessionId: "s" }),
        loadSession: vi.fn().mockRejectedValue(new Error("session not found")),
        cancel: vi.fn().mockResolvedValue({}),
        prompt: vi.fn().mockResolvedValue({}),
      };
      return connInstance;
    });

    // Should not throw
    const history = await provider.getHistory("s1", "bad-token");
    expect(Array.isArray(history)).toBe(true);
  });
});
