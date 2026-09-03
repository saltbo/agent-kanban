import { useEffect, useState } from "react";
import { AgentThread, ChatToolUIs } from "@/features/tasks/components/chat";
import { api } from "@/lib/api";
import { SessionRuntimeProvider } from "./RelayRuntimeProvider";

const LIVE_POLL_MS = 2000;

type RuntimeEvent = Record<string, unknown>;

function sequenceOf(event: RuntimeEvent): number {
  const seq = Number(event.sequence);
  return Number.isFinite(seq) ? seq : 0;
}

function timestampOf(event: RuntimeEvent): string {
  const value = typeof event.createdAt === "string" ? event.createdAt : typeof event.timestamp === "string" ? event.timestamp : "";
  return Number.isFinite(Date.parse(value)) ? value : "";
}

function messageIdOf(event: RuntimeEvent): string | null {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const message = (payload as Record<string, unknown>).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const id = (message as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function eventKey(event: RuntimeEvent): string {
  if (typeof event.id === "string" && event.id.length > 0) return `id:${event.id}`;
  const messageId = messageIdOf(event);
  if (messageId) return `message:${messageId}`;
  return `fallback:${sequenceOf(event)}:${timestampOf(event)}:${String(event.type ?? "")}`;
}

function compareEvents(a: RuntimeEvent, b: RuntimeEvent): number {
  const aTime = timestampOf(a);
  const bTime = timestampOf(b);
  if (aTime && bTime && aTime !== bTime) return aTime.localeCompare(bTime);
  const sequence = sequenceOf(a) - sequenceOf(b);
  if (sequence !== 0) return sequence;
  return eventKey(a).localeCompare(eventKey(b));
}

function mergeUnique(base: RuntimeEvent[], incoming: RuntimeEvent[]): RuntimeEvent[] {
  const seen = new Set(base.map(eventKey));
  const added = incoming.filter((event) => {
    const key = eventKey(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (added.length === 0) return base;
  // Backfill pages and live events can interleave; keep the thread in event time order.
  return [...base, ...added].sort(compareEvents);
}

interface ChatPanelProps {
  taskId: string;
  agentId: string | null;
  taskDone: boolean;
  /** The runtime session this task is bound to. */
  runtimeSessionId?: string | null;
}

export function ChatPanel({ taskId, agentId, taskDone, runtimeSessionId }: ChatPanelProps) {
  if (!agentId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-content-tertiary">No agent assigned. Chat is available when an agent is working on this task.</p>
      </div>
    );
  }

  if (runtimeSessionId) {
    return <RuntimeSessionChat taskId={taskId} taskDone={taskDone} unavailableMessage="Session history is not available for this task." />;
  }

  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <p className="text-sm text-content-tertiary text-center">Chat history is not available for this task.</p>
    </div>
  );
}

// The runtime path: the task's events live in the upstream control plane (the Session DO
// for cloud-loop runtimes, the runner store for self-hosted CLI runtimes), read
// back through AK's server as a paginated snapshot and live-tailed.
export function RuntimeSessionChat({
  taskId,
  sessionId,
  taskDone,
  unavailableMessage = "Session history is not available.",
}: {
  taskId?: string;
  sessionId?: string;
  taskDone: boolean;
  unavailableMessage?: string;
}) {
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");

  // Events come over AK's authenticated WebSocket boundary. AK validates the
  // browser Session Cookie and proxies upstream with its machine authority;
  // history backfill and live events remain on the same socket.
  useEffect(() => {
    let active = true;
    let ws: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let backfillSeq = 0;
    setPhase("loading");
    setEvents([]);

    function sendBackfill(socket: WebSocket, cursor?: number) {
      const requestId = `backfill-${++backfillSeq}`;
      socket.send(JSON.stringify({ type: "backfill", requestId, limit: 200, ...(cursor !== undefined ? { cursor } : {}) }));
    }

    const connect = async () => {
      try {
        const { url } = await api.tasks.sessionWs(taskId!);
        if (!active) return;
        ws = new WebSocket(url);
        ws.onopen = () => {
          // Request history explicitly; stopped sessions may not push a backfill
          // frame until the client asks for one.
          if (ws) sendBackfill(ws);
        };
        ws.onmessage = (event) => {
          try {
            const frame = JSON.parse(typeof event.data === "string" ? event.data : "");
            if (frame?.type === "backfill" && Array.isArray(frame.events)) {
              setEvents((prev) => mergeUnique(prev, frame.events as RuntimeEvent[]));
              setPhase("ready");
              // Pull older pages over the same socket until the history is whole.
              if (frame.hasMore && typeof frame.nextCursor === "number" && ws?.readyState === WebSocket.OPEN) {
                sendBackfill(ws, frame.nextCursor);
              }
            } else if (frame?.type === "event") {
              if (!frame.record) return;
              setEvents((prev) => mergeUnique(prev, [frame.record as RuntimeEvent]));
              setPhase("ready");
            } else if (frame?.type === "error" || frame?.type === "runner_unavailable") {
              setPhase("error");
            }
          } catch {
            // ignore a malformed frame
          }
        };
        ws.onclose = () => {
          ws = null;
          // A finished task has no more live events; reconnect only while running.
          if (active && !taskDone) reconnect = setTimeout(connect, LIVE_POLL_MS);
        };
      } catch {
        if (active) {
          setPhase((prev) => (prev === "loading" ? "error" : prev));
          reconnect = setTimeout(connect, LIVE_POLL_MS);
        }
      }
    };
    void connect();
    return () => {
      active = false;
      if (reconnect) clearTimeout(reconnect);
      ws?.close();
    };
  }, [taskId, taskDone]);

  if (phase === "loading") {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <p className="text-sm text-content-tertiary text-center">Loading runtime history...</p>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <p className="text-sm text-content-tertiary text-center">{unavailableMessage}</p>
      </div>
    );
  }

  return (
    <SessionRuntimeProvider events={events} taskDone={taskDone}>
      <ChatToolUIs />
      <AgentThread taskDone={taskDone} />
    </SessionRuntimeProvider>
  );
}
