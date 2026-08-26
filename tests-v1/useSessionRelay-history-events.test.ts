/**
 * Unit tests for the session:history message handling in useSessionRelay.
 *
 * The hook was updated to read `msg.events` instead of `msg.messages`.
 * These tests verify that:
 *   - events from `msg.events` are applied to hook state
 *   - `msg.messages` (old field name) is ignored
 *   - non-array / missing events field is handled safely
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../apps/web/src/lib/auth-client", () => ({
  getAuthToken: () => "mock-token",
  refreshAuthToken: () => Promise.resolve("fresh-token"),
}));

let mockWebSocketInstance: MockWebSocket | null = null;

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(public url: string) {
    mockWebSocketInstance = this;
  }

  send(_data: string) {}

  close() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose(new CloseEvent("close"));
  }

  simulateOpen() {
    if (this.onopen) this.onopen(new Event("open"));
  }

  simulateMessage(data: unknown) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent("message", { data: JSON.stringify(data) }));
    }
  }
}

const originalWebSocket = global.WebSocket;

beforeEach(() => {
  mockWebSocketInstance = null;
  global.WebSocket = MockWebSocket as any;
  Object.defineProperty(window, "location", {
    value: { origin: "http://localhost:3000" },
    writable: true,
  });
});

afterEach(() => {
  global.WebSocket = originalWebSocket;
  mockWebSocketInstance = null;
  vi.clearAllMocks();
});

import { act, renderHook, waitFor } from "@testing-library/react";
import { useSessionRelay } from "../apps/web/src/hooks/useSessionRelay.js";

function getWs(): MockWebSocket {
  if (!mockWebSocketInstance) throw new Error("No WebSocket instance");
  return mockWebSocketInstance;
}

// ---------------------------------------------------------------------------

describe("useSessionRelay — session:history reads msg.events", () => {
  it("populates events state from msg.events array", async () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "sess-1" }));
    await waitFor(() => expect(mockWebSocketInstance).not.toBeNull());

    act(() => {
      getWs().simulateOpen();
    });

    const historyPayload = [
      { id: "hist-1", event: { type: "message", blocks: [{ type: "text", text: "hello" }] }, timestamp: "2025-01-01T00:00:00.000Z" },
    ];

    act(() => {
      getWs().simulateMessage({ type: "session:history", events: historyPayload });
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0].id).toBe("hist-1");
  });

  it("ignores msg.messages — only reads msg.events", async () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "sess-2" }));
    await waitFor(() => expect(mockWebSocketInstance).not.toBeNull());

    act(() => {
      getWs().simulateOpen();
    });

    act(() => {
      getWs().simulateMessage({
        type: "session:history",
        messages: [{ id: "hist-1", event: { type: "message", blocks: [] }, timestamp: "2025-01-01T00:00:00.000Z" }],
      });
    });

    expect(result.current.events).toHaveLength(0);
  });

  it("replaces events with history, keeping only live events prepended", async () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "sess-3" }));
    await waitFor(() => expect(mockWebSocketInstance).not.toBeNull());

    act(() => {
      getWs().simulateOpen();
    });

    // First inject a live event
    act(() => {
      getWs().simulateMessage({
        type: "agent:event",
        event: { type: "message", blocks: [{ type: "text", text: "live" }] },
      });
    });

    expect(result.current.events).toHaveLength(1);
    const liveId = result.current.events[0].id;
    expect(liveId.startsWith("live-")).toBe(true);

    // Then receive history
    const historyPayload = [
      { id: "hist-1", event: { type: "message", blocks: [] }, timestamp: "2025-01-01T00:00:00.000Z" },
      { id: "hist-2", event: { type: "message", blocks: [] }, timestamp: "2025-01-01T00:00:01.000Z" },
    ];

    act(() => {
      getWs().simulateMessage({ type: "session:history", events: historyPayload });
    });

    // History events come first, live event is appended
    expect(result.current.events).toHaveLength(3);
    expect(result.current.events[0].id).toBe("hist-1");
    expect(result.current.events[1].id).toBe("hist-2");
    expect(result.current.events[2].id).toBe(liveId);
  });

  it("results in empty events when msg.events is an empty array", async () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "sess-4" }));
    await waitFor(() => expect(mockWebSocketInstance).not.toBeNull());

    act(() => {
      getWs().simulateOpen();
    });

    act(() => {
      getWs().simulateMessage({ type: "session:history", events: [] });
    });

    expect(result.current.events).toHaveLength(0);
  });

  it("does not crash when session:history has no events field", async () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "sess-5" }));
    await waitFor(() => expect(mockWebSocketInstance).not.toBeNull());

    act(() => {
      getWs().simulateOpen();
    });

    expect(() => {
      act(() => {
        getWs().simulateMessage({ type: "session:history" });
      });
    }).not.toThrow();

    expect(result.current.events).toHaveLength(0);
  });
});
