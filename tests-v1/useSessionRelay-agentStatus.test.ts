/**
 * Unit tests for AgentStatus handling in useSessionRelay.ts.
 *
 * Tests the new agentStatus state tracking and WebSocket message handling
 * for agent:status events, including status transitions and daemon disconnect
 * behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock auth client first, before any imports
vi.mock("../apps/web/src/lib/auth-client", () => ({
  getAuthToken: () => "mock-token",
  refreshAuthToken: () => Promise.resolve("fresh-token"),
}));

// Global WebSocket instance for testing
let mockWebSocketInstance: MockWebSocket | null = null;

// Create a mock WebSocket that captures the instance
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(public url: string) {
    // Store the instance globally so tests can access it
    mockWebSocketInstance = this;
  }

  send(_data: string) {}

  close() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent("close"));
    }
  }

  simulateMessage(data: any) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent("message", { data: JSON.stringify(data) }));
    }
  }

  simulateOpen() {
    if (this.onopen) {
      this.onopen(new Event("open"));
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

import { act, renderHook } from "@testing-library/react";
import { type AgentStatus, useSessionRelay } from "../apps/web/src/hooks/useSessionRelay.js";

// Helper to get the current WebSocket instance
function getMockWebSocket(): MockWebSocket {
  if (!mockWebSocketInstance) {
    throw new Error("No WebSocket instance available");
  }
  return mockWebSocketInstance;
}

// ── AgentStatus type tests ────────────────────────────────────────────────────

describe("useSessionRelay — AgentStatus type", () => {
  it("exports AgentStatus type with correct literal values", () => {
    const validStatuses: AgentStatus[] = ["idle", "working", "done", "rate_limited"];

    validStatuses.forEach((status) => {
      expect(typeof status).toBe("string");
    });

    expect(validStatuses).toContain("idle");
    expect(validStatuses).toContain("working");
    expect(validStatuses).toContain("done");
    expect(validStatuses).toContain("rate_limited");
  });
});

// ── AgentStatus state management ──────────────────────────────────────────────

describe("useSessionRelay — agentStatus state management", () => {
  it("initializes agentStatus as idle", () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "test-session" }));

    expect(result.current.agentStatus).toBe("idle");
  });

  it("includes agentStatus in return value", () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "test-session" }));

    expect(result.current).toHaveProperty("agentStatus");
    expect(typeof result.current.agentStatus).toBe("string");
  });

  it("returns agentStatus in hook interface", () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "test-session" }));

    // Check that agentStatus is part of the returned interface
    expect(result.current).toEqual(
      expect.objectContaining({
        events: expect.any(Array),
        sendMessage: expect.any(Function),
        daemonConnected: expect.any(Boolean),
        wsConnected: expect.any(Boolean),
        agentStatus: expect.stringMatching(/^(idle|working|done|rate_limited)$/),
      }),
    );
  });
});

// ── Status value validation ───────────────────────────────────────────────────

describe("useSessionRelay — status value validation", () => {
  it("accepts working status", () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "test-session" }));

    // Simulate connection
    act(() => {
      getMockWebSocket().simulateOpen();
    });

    act(() => {
      getMockWebSocket().simulateMessage({ type: "agent:status", status: "working" });
    });

    expect(result.current.agentStatus).toBe("working");
  });

  it("accepts done status", () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "test-session" }));

    act(() => {
      getMockWebSocket().simulateOpen();
    });

    act(() => {
      getMockWebSocket().simulateMessage({ type: "agent:status", status: "done" });
    });

    expect(result.current.agentStatus).toBe("done");
  });

  it("accepts rate_limited status", () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "test-session" }));

    act(() => {
      getMockWebSocket().simulateOpen();
    });

    act(() => {
      getMockWebSocket().simulateMessage({ type: "agent:status", status: "rate_limited" });
    });

    expect(result.current.agentStatus).toBe("rate_limited");
  });

  it("ignores invalid status values", () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "test-session" }));

    act(() => {
      getMockWebSocket().simulateOpen();
    });

    act(() => {
      getMockWebSocket().simulateMessage({ type: "agent:status", status: "invalid" });
    });

    expect(result.current.agentStatus).toBe("idle");
  });

  it("ignores non-string status values", () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "test-session" }));

    act(() => {
      getMockWebSocket().simulateOpen();
    });

    act(() => {
      getMockWebSocket().simulateMessage({ type: "agent:status", status: 123 });
    });

    expect(result.current.agentStatus).toBe("idle");
  });
});

// ── Daemon disconnect behavior ────────────────────────────────────────────────

describe("useSessionRelay — daemon disconnect resets agentStatus", () => {
  it("resets agentStatus to idle on daemon disconnect", () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "test-session" }));

    act(() => {
      getMockWebSocket().simulateOpen();
    });

    // Set to working first
    act(() => {
      getMockWebSocket().simulateMessage({ type: "agent:status", status: "working" });
    });

    expect(result.current.agentStatus).toBe("working");

    // Disconnect daemon
    act(() => {
      getMockWebSocket().simulateMessage({ type: "daemon:disconnected" });
    });

    expect(result.current.agentStatus).toBe("idle");
  });

  it("resets from any status on daemon disconnect", () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "test-session" }));

    act(() => {
      getMockWebSocket().simulateOpen();
    });

    // Try different starting statuses
    const statuses: AgentStatus[] = ["working", "done", "rate_limited"];

    for (const status of statuses) {
      act(() => {
        getMockWebSocket().simulateMessage({ type: "agent:status", status });
      });

      expect(result.current.agentStatus).toBe(status);

      act(() => {
        getMockWebSocket().simulateMessage({ type: "daemon:disconnected" });
      });

      expect(result.current.agentStatus).toBe("idle");
    }
  });
});

// ── Message handling integration ──────────────────────────────────────────────

describe("useSessionRelay — message handling integration", () => {
  it("handles agent:status alongside other message types", () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "test-session" }));

    act(() => {
      getMockWebSocket().simulateOpen();
    });

    // Handle daemon connected
    act(() => {
      getMockWebSocket().simulateMessage({ type: "daemon:connected" });
    });

    expect(result.current.daemonConnected).toBe(true);

    // Handle agent status
    act(() => {
      getMockWebSocket().simulateMessage({ type: "agent:status", status: "working" });
    });

    expect(result.current.agentStatus).toBe("working");
    expect(result.current.daemonConnected).toBe(true); // Should not be affected
  });

  it("processes agent:status messages independently of events", () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "test-session" }));

    act(() => {
      getMockWebSocket().simulateOpen();
    });

    // Add some events first
    act(() => {
      getMockWebSocket().simulateMessage({
        type: "agent:event",
        event: { type: "user", text: "Hello" },
      });
    });

    expect(result.current.events).toHaveLength(1);

    // Agent status should not affect events
    act(() => {
      getMockWebSocket().simulateMessage({ type: "agent:status", status: "working" });
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.agentStatus).toBe("working");
  });

  it("ignores malformed agent:status messages", () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "test-session" }));

    act(() => {
      getMockWebSocket().simulateOpen();
    });

    // Missing status field
    act(() => {
      getMockWebSocket().simulateMessage({ type: "agent:status" });
    });

    expect(result.current.agentStatus).toBe("idle");

    // Null status
    act(() => {
      getMockWebSocket().simulateMessage({ type: "agent:status", status: null });
    });

    expect(result.current.agentStatus).toBe("idle");

    // Empty string
    act(() => {
      getMockWebSocket().simulateMessage({ type: "agent:status", status: "" });
    });

    expect(result.current.agentStatus).toBe("idle");
  });
});

// ── Status transitions ────────────────────────────────────────────────────────

describe("useSessionRelay — status transitions", () => {
  it("allows all valid status transitions", () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "test-session" }));

    act(() => {
      getMockWebSocket().simulateOpen();
    });

    // Test all transitions
    const transitions = ["working", "rate_limited", "done", "working", "rate_limited"] as const;

    for (const status of transitions) {
      act(() => {
        getMockWebSocket().simulateMessage({ type: "agent:status", status });
      });

      expect(result.current.agentStatus).toBe(status);
    }
  });

  it("maintains status until explicitly changed", () => {
    const { result } = renderHook(() => useSessionRelay({ sessionId: "test-session" }));

    act(() => {
      getMockWebSocket().simulateOpen();
    });

    // Set to working
    act(() => {
      getMockWebSocket().simulateMessage({ type: "agent:status", status: "working" });
    });

    expect(result.current.agentStatus).toBe("working");

    // agent:event does not change status
    act(() => {
      getMockWebSocket().simulateMessage({
        type: "agent:event",
        event: { type: "user", text: "Test" },
      });
    });

    // Status should remain unchanged after non-status messages
    expect(result.current.agentStatus).toBe("working");

    // daemon:connected resets status to idle (daemon may have restarted)
    act(() => {
      getMockWebSocket().simulateMessage({ type: "daemon:connected" });
    });

    expect(result.current.agentStatus).toBe("idle");
  });
});
