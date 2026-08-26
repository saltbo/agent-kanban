import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AmaSessionChat, ChatPanel } from "./ChatPanel";

// ── Mocks ────────────────────────────────────────────────────────────────────

const sessionWsMock = vi.fn();
const directSessionWsMock = vi.fn();
let lastAmaRuntimeEvents: Record<string, unknown>[] = [];

vi.mock("../lib/api", () => ({
  api: {
    tasks: {
      sessionWs: (...args: unknown[]) => sessionWsMock(...args),
    },
    sessions: {
      sessionWs: (...args: unknown[]) => directSessionWsMock(...args),
    },
  },
}));

vi.mock("./RelayRuntimeProvider", () => ({
  AmaRuntimeProvider: ({ events, children }: { events: Record<string, unknown>[]; children: React.ReactNode }) => {
    lastAmaRuntimeEvents = events;
    return React.createElement("div", { "data-testid": "ama-runtime-provider", "data-event-count": events.length }, children);
  },
  RelayRuntimeProvider: ({ sessionId, children }: { sessionId: string; children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "relay-runtime-provider", "data-session-id": sessionId }, children),
}));

vi.mock("@/components/chat", () => ({
  AgentThread: () => React.createElement("div", { "data-testid": "agent-thread" }),
  ChatToolUIs: () => React.createElement("div", { "data-testid": "chat-tool-uis" }),
}));

// ── WebSocket fake ────────────────────────────────────────────────────────────

// Minimal WebSocket fake for jsdom. Captures the most-recently constructed
// instance so tests can fire messages and inspect sends.
let lastWebSocket: FakeWebSocket | null = null;

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readyState = 1; // OPEN
  sends: string[] = [];

  constructor(url: string) {
    this.url = url;
    lastWebSocket = this;
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string) {
    this.sends.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose();
  }

  // Helper used by tests to deliver a server→client message.
  emit(data: unknown) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(data) });
  }

  // Convenience alias for readability.
  simulateMessage(data: unknown) {
    this.emit(data);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(sequence: number): Record<string, unknown> {
  return { sequence, type: "text", content: `event-${sequence}` };
}

function makeAmaEvent(overrides: Record<string, unknown>): Record<string, unknown> {
  return { type: "text", ...overrides };
}

const TASK_ID = "task-123";
const AGENT_ID = "agent-456";

function renderPanel(props: Partial<React.ComponentProps<typeof ChatPanel>> = {}) {
  return render(
    React.createElement(ChatPanel, {
      taskId: TASK_ID,
      agentId: AGENT_ID,
      taskDone: false,
      ...props,
    }),
  );
}

// Waits for the FakeWebSocket to be constructed (i.e., for the async connect()
// in AmaSessionChat to resolve the sessionWs promise and call `new WebSocket`).
async function waitForWebSocket(): Promise<FakeWebSocket> {
  // Flush microtasks so sessionWs's resolved promise runs.
  await act(async () => {
    await Promise.resolve();
  });
  if (!lastWebSocket) {
    // One more flush for environments where mock resolution takes two ticks.
    await act(async () => {
      await Promise.resolve();
    });
  }
  if (!lastWebSocket) throw new Error("FakeWebSocket was never constructed — sessionWs may not have resolved");
  return lastWebSocket;
}

// Delivers a backfill frame to lastWebSocket so AmaSessionChat transitions to "ready".
async function deliverBackfill(events: Record<string, unknown>[] = [], hasMore = false, nextCursor: number | null = null) {
  const ws = await waitForWebSocket();
  await act(async () => {
    ws.emit({ type: "backfill", events, hasMore, nextCursor });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ChatPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastWebSocket = null;
    lastAmaRuntimeEvents = [];

    // Default: socket url for AMA branch.
    sessionWsMock.mockResolvedValue({ url: "wss://test/socket" });
    directSessionWsMock.mockResolvedValue({ url: "wss://direct-session/socket" });

    // Install the fake WebSocket globally so source code that does
    // `new WebSocket(url)` uses the fake instead of the real browser API.
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  describe("branch 1: agentId is null", () => {
    it("renders the no-agent-assigned message", () => {
      renderPanel({ agentId: null });

      expect(screen.getByText("No agent assigned. Chat is available when an agent is working on this task.")).toBeInTheDocument();
    });

    it("does not call api.tasks.sessionWs", () => {
      renderPanel({ agentId: null });

      expect(sessionWsMock).not.toHaveBeenCalled();
    });
  });

  describe("branch 2: agentId set + amaSessionId present", () => {
    it("renders the AMA runtime provider marker after a backfill frame", async () => {
      renderPanel({ amaSessionId: "session_x" });

      // AmaSessionChat stays in loading until the first backfill frame arrives.
      await deliverBackfill();

      expect(screen.getByTestId("ama-runtime-provider")).toBeInTheDocument();
    });

    it("calls api.tasks.sessionWs with the taskId", async () => {
      renderPanel({ amaSessionId: "session_x" });

      await deliverBackfill();

      expect(sessionWsMock).toHaveBeenCalledWith(TASK_ID);
    });

    it("does not render the relay provider", async () => {
      renderPanel({ amaSessionId: "session_x" });

      await deliverBackfill();

      expect(screen.queryByTestId("relay-runtime-provider")).not.toBeInTheDocument();
    });
  });

  describe("branch 3: agentId set + no amaSessionId + relaySessionId present", () => {
    it("renders the relay runtime provider marker", () => {
      renderPanel({ amaSessionId: null, relaySessionId: "relay_x" });

      expect(screen.getByTestId("relay-runtime-provider")).toBeInTheDocument();
    });

    it("threads the relaySessionId through to RelayRuntimeProvider", () => {
      renderPanel({ amaSessionId: null, relaySessionId: "relay_x" });

      expect(screen.getByTestId("relay-runtime-provider")).toHaveAttribute("data-session-id", "relay_x");
    });

    it("does not call api.tasks.sessionWs", () => {
      renderPanel({ amaSessionId: null, relaySessionId: "relay_x" });

      expect(sessionWsMock).not.toHaveBeenCalled();
    });

    it("does not render the AMA provider", () => {
      renderPanel({ amaSessionId: null, relaySessionId: "relay_x" });

      expect(screen.queryByTestId("ama-runtime-provider")).not.toBeInTheDocument();
    });
  });

  describe("branch 4: agentId set + both session ids absent", () => {
    it("renders the chat-history-not-available message", () => {
      renderPanel({ amaSessionId: null, relaySessionId: null });

      expect(screen.getByText("Chat history is not available for this task.")).toBeInTheDocument();
    });

    it("does not render either runtime provider", () => {
      renderPanel({ amaSessionId: null, relaySessionId: null });

      expect(screen.queryByTestId("ama-runtime-provider")).not.toBeInTheDocument();
      expect(screen.queryByTestId("relay-runtime-provider")).not.toBeInTheDocument();
    });
  });

  describe("AmaSessionChat internal states", () => {
    it("shows loading state before any backfill frame arrives", () => {
      // Hold sessionWs so the WS is never constructed.
      sessionWsMock.mockReturnValue(new Promise(() => {}));

      renderPanel({ amaSessionId: "session_x" });

      expect(screen.getByText("Loading runtime history...")).toBeInTheDocument();
    });

    it("shows error state when api.tasks.sessionWs rejects", async () => {
      sessionWsMock.mockRejectedValue(new Error("network error"));

      renderPanel({ amaSessionId: "session_x" });

      expect(await screen.findByText("Session history is not available for this task.")).toBeInTheDocument();
    });

    it("shows error state when the AMA socket returns an error frame", async () => {
      renderPanel({ amaSessionId: "session_x" });

      const ws = await waitForWebSocket();
      await act(async () => {
        ws.emit({ type: "error", message: "Invalid session socket message" });
      });

      expect(screen.getByText("Session history is not available for this task.")).toBeInTheDocument();
    });

    it("shows error state when the AMA runner is unavailable", async () => {
      renderPanel({ amaSessionId: "session_x" });

      const ws = await waitForWebSocket();
      await act(async () => {
        ws.emit({ type: "runner_unavailable", message: "runner offline" });
      });

      expect(screen.getByText("Session history is not available for this task.")).toBeInTheDocument();
    });

    it("renders the AMA provider when taskDone=true after a backfill frame", async () => {
      renderPanel({ amaSessionId: "session_x", taskDone: true });

      await deliverBackfill();

      expect(screen.getByTestId("ama-runtime-provider")).toBeInTheDocument();
    });

    it("calls api.tasks.sessionWs for a not-done AMA task", async () => {
      renderPanel({ amaSessionId: "session_x", taskDone: false });

      await deliverBackfill();

      expect(sessionWsMock).toHaveBeenCalledWith(TASK_ID);
    });

    it("calls api.tasks.sessionWs for a done AMA task (history view)", async () => {
      renderPanel({ amaSessionId: "session_x", taskDone: true });

      await deliverBackfill();

      expect(sessionWsMock).toHaveBeenCalledWith(TASK_ID);
    });

    // ── Backfill rendering ────────────────────────────────────────────────────

    it("renders the AMA provider after a backfill frame with events", async () => {
      renderPanel({ amaSessionId: "session_x" });

      await deliverBackfill([makeEvent(1), makeEvent(2)]);

      expect(screen.getByTestId("ama-runtime-provider")).toBeInTheDocument();
    });

    it("requests the next page when backfill hasMore=true and nextCursor is a number", async () => {
      renderPanel({ amaSessionId: "session_x" });

      // Wait for WS to be constructed then deliver a paged backfill.
      await act(async () => {
        // Allow sessionWs promise to resolve and WS to be created.
        await Promise.resolve();
      });

      await deliverBackfill([makeEvent(1), makeEvent(2)], true, 2);

      // The component should have sent a backfill request for the next page.
      expect(lastWebSocket!.sends.length).toBeGreaterThanOrEqual(2);
      const sentFrame = JSON.parse(lastWebSocket!.sends[1]);
      expect(sentFrame).toMatchObject({ type: "backfill", requestId: "backfill-2", limit: 200, cursor: 2 });
      expect(sentFrame).not.toHaveProperty("id");
      expect(sentFrame).not.toHaveProperty("order");
    });

    it("sends only the initial backfill request when hasMore=false", async () => {
      renderPanel({ amaSessionId: "session_x" });

      await deliverBackfill([makeEvent(1)], false, null);

      expect(lastWebSocket!.sends.length).toBe(1);
      const sentFrame = JSON.parse(lastWebSocket!.sends[0]);
      expect(sentFrame).toMatchObject({ type: "backfill", requestId: "backfill-1", limit: 200 });
      expect(sentFrame).not.toHaveProperty("id");
      expect(sentFrame).not.toHaveProperty("order");
    });

    it("sends only the initial backfill request when nextCursor is not a number", async () => {
      renderPanel({ amaSessionId: "session_x" });

      const ws = await waitForWebSocket();
      await act(async () => {
        ws.emit({ type: "backfill", events: [makeEvent(1)], hasMore: true, nextCursor: null });
      });

      expect(ws.sends.length).toBe(1);
    });

    // ── Live event appends ────────────────────────────────────────────────────

    it("appends a live event record delivered after the initial backfill", async () => {
      renderPanel({ amaSessionId: "session_x" });

      await deliverBackfill([makeEvent(1)]);

      await act(async () => {
        lastWebSocket!.emit({ type: "event", record: makeEvent(10) });
      });

      expect(screen.getByTestId("ama-runtime-provider")).toHaveAttribute("data-event-count", "2");
      expect(lastAmaRuntimeEvents.map((event) => event.sequence)).toEqual([1, 10]);
    });

    it("transitions to ready on a live event record even without a prior backfill", async () => {
      renderPanel({ amaSessionId: "session_x" });

      const ws = await waitForWebSocket();
      await act(async () => {
        ws.emit({ type: "event", record: makeEvent(1) });
      });

      expect(screen.getByTestId("ama-runtime-provider")).toBeInTheDocument();
      expect(lastAmaRuntimeEvents.map((event) => event.sequence)).toEqual([1]);
    });

    it("preserves distinct AMA events with the same numeric sequence when ids differ", async () => {
      renderPanel({ amaSessionId: "session_x" });

      await deliverBackfill([
        makeAmaEvent({ id: "evt_same_seq_a", sequence: 7, createdAt: "2026-07-03T10:00:00.000Z", content: "first" }),
        makeAmaEvent({ id: "evt_same_seq_b", sequence: 7, createdAt: "2026-07-03T10:00:01.000Z", content: "second" }),
      ]);

      expect(screen.getByTestId("ama-runtime-provider")).toHaveAttribute("data-event-count", "2");
      expect(lastAmaRuntimeEvents.map((event) => event.id)).toEqual(["evt_same_seq_a", "evt_same_seq_b"]);
    });

    it("deduplicates AMA events with the same id across backfill and live frames", async () => {
      renderPanel({ amaSessionId: "session_x" });

      await deliverBackfill([makeAmaEvent({ id: "evt_duplicate", sequence: 1, createdAt: "2026-07-03T10:00:00.000Z", content: "from-backfill" })]);

      await act(async () => {
        lastWebSocket!.emit({
          type: "event",
          record: makeAmaEvent({ id: "evt_duplicate", sequence: 2, createdAt: "2026-07-03T10:00:01.000Z", content: "from-live" }),
        });
      });

      expect(screen.getByTestId("ama-runtime-provider")).toHaveAttribute("data-event-count", "1");
      expect(lastAmaRuntimeEvents).toMatchObject([{ id: "evt_duplicate", content: "from-backfill" }]);
    });

    it("orders AMA events by createdAt or timestamp before sequence", async () => {
      renderPanel({ amaSessionId: "session_x" });

      await deliverBackfill([
        makeAmaEvent({ id: "evt_later_low_seq", sequence: 1, createdAt: "2026-07-03T10:00:03.000Z" }),
        makeAmaEvent({ id: "evt_earlier_high_seq", sequence: 99, timestamp: "2026-07-03T10:00:01.000Z" }),
      ]);

      await act(async () => {
        lastWebSocket!.emit({
          type: "event",
          record: makeAmaEvent({ id: "evt_middle_seq", sequence: 50, createdAt: "2026-07-03T10:00:02.000Z" }),
        });
      });

      expect(lastAmaRuntimeEvents.map((event) => event.id)).toEqual(["evt_earlier_high_seq", "evt_middle_seq", "evt_later_low_seq"]);
    });

    it("deduplicates id-less AMA events by payload message id", async () => {
      renderPanel({ amaSessionId: "session_x" });

      await deliverBackfill([
        makeAmaEvent({
          sequence: 1,
          createdAt: "2026-07-03T10:00:00.000Z",
          payload: { message: { id: "msg_duplicate", content: "from-backfill" } },
        }),
      ]);

      await act(async () => {
        lastWebSocket!.emit({
          type: "event",
          record: makeAmaEvent({
            sequence: 2,
            createdAt: "2026-07-03T10:00:01.000Z",
            payload: { message: { id: "msg_duplicate", content: "from-live" } },
          }),
        });
      });

      expect(screen.getByTestId("ama-runtime-provider")).toHaveAttribute("data-event-count", "1");
      expect(lastAmaRuntimeEvents).toMatchObject([{ payload: { message: { id: "msg_duplicate", content: "from-backfill" } } }]);
    });

    // ── WebSocket construction ────────────────────────────────────────────────

    it("constructs a WebSocket with the url returned by sessionWs", async () => {
      sessionWsMock.mockResolvedValue({ url: "wss://example.com/socket" });

      renderPanel({ amaSessionId: "session_x", taskDone: false });

      // Allow sessionWs to resolve and WS to be constructed.
      await act(async () => {
        await Promise.resolve();
      });

      expect(lastWebSocket).not.toBeNull();
      expect(lastWebSocket!.url).toBe("wss://example.com/socket");
    });

    it("does not open a WebSocket when sessionWs rejects", async () => {
      sessionWsMock.mockRejectedValue(new Error("auth failed"));

      renderPanel({ amaSessionId: "session_x" });

      expect(await screen.findByText("Session history is not available for this task.")).toBeInTheDocument();
      expect(lastWebSocket).toBeNull();
    });

    // ── Done task path ────────────────────────────────────────────────────────

    it("opens a WebSocket for a done task to show history", async () => {
      renderPanel({ amaSessionId: "session_x", taskDone: true });

      await act(async () => {
        await Promise.resolve();
      });

      expect(lastWebSocket).not.toBeNull();
    });

    it("renders the AMA provider for a done task after receiving the backfill", async () => {
      renderPanel({ amaSessionId: "session_x", taskDone: true });

      await deliverBackfill([makeEvent(1), makeEvent(2)]);

      expect(screen.getByTestId("ama-runtime-provider")).toBeInTheDocument();
    });

    it("does not trigger reconnect for a done task when socket closes", async () => {
      renderPanel({ amaSessionId: "session_x", taskDone: true });

      await deliverBackfill();

      const firstSocket = lastWebSocket;

      // Close the socket; for a done task there should be no reconnect.
      await act(async () => {
        firstSocket!.close();
      });

      // No new WebSocket constructed.
      expect(lastWebSocket).toBe(firstSocket);
    });

    // ── Ignored malformed frames ──────────────────────────────────────────────

    it("ignores a frame with an unrecognised type without crashing", async () => {
      renderPanel({ amaSessionId: "session_x" });

      // Stay in loading — a bad frame shouldn't crash or transition to error.
      const ws = await waitForWebSocket();
      await act(async () => {
        ws.emit({ type: "unknown", payload: "garbage" });
      });

      expect(screen.getByText("Loading runtime history...")).toBeInTheDocument();
    });

    it("can open an AMA websocket directly by session id", async () => {
      render(React.createElement(AmaSessionChat, { sessionId: "session_direct", taskDone: true }));

      await deliverBackfill();

      expect(directSessionWsMock).toHaveBeenCalledWith("session_direct");
      expect(sessionWsMock).not.toHaveBeenCalled();
      expect(lastWebSocket!.url).toBe("wss://direct-session/socket");
    });
  });
});
