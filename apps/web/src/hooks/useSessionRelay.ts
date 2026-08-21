import type { AgentEvent } from "@agent-kanban/shared";
import { useCallback, useEffect, useRef, useState } from "react";

export type { AgentEvent };

export interface RelayEvent {
  id: string;
  event: AgentEvent;
  timestamp: string;
}

interface UseSessionRelayOptions {
  sessionId: string | null;
  enabled?: boolean;
}

export type AgentStatus = "idle" | "working" | "done" | "rate_limited";

export function useSessionRelay({ sessionId, enabled = true }: UseSessionRelayOptions) {
  const [events, setEvents] = useState<RelayEvent[]>([]);
  const [daemonConnected, setDaemonConnected] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("idle");
  const wsRef = useRef<WebSocket | null>(null);
  const idCounter = useRef(0);
  const historyLoaded = useRef(false);
  const historyRetryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const historyRetries = useRef(0);

  useEffect(() => {
    if (!enabled || !sessionId) return;

    let closed = false;
    historyLoaded.current = false;
    historyRetries.current = 0;

    function requestHistory(ws: WebSocket) {
      if (historyLoaded.current || closed) return;
      ws.send(JSON.stringify({ type: "request:history" }));

      clearTimeout(historyRetryTimer.current);
      historyRetryTimer.current = setTimeout(() => {
        if (historyLoaded.current || closed) return;
        historyRetries.current++;
        if (historyRetries.current <= 2 && ws.readyState === WebSocket.OPEN) {
          requestHistory(ws);
        }
      }, 5000);
    }

    let ws: WebSocket | null = null;

    function connect() {
      if (closed) return;
      const wsUrl = `${location.origin.replace(/^http/, "ws")}/api/tunnel/ws?role=browser&sessionId=${sessionId}`;
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (closed || !ws) return;
        setWsConnected(true);
        requestHistory(ws);
      };

      ws.onmessage = (rawEvent) => {
        if (closed) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(rawEvent.data);
        } catch {
          return;
        }

        switch (msg.type) {
          case "session:history": {
            historyLoaded.current = true;
            clearTimeout(historyRetryTimer.current);
            const history = msg.events as RelayEvent[] | undefined;
            if (Array.isArray(history)) {
              setEvents((prev) => {
                const liveEvents = prev.filter((e) => e.id.startsWith("live-"));
                return [...history, ...liveEvents];
              });
            }
            break;
          }
          case "agent:event": {
            const id = `live-${++idCounter.current}`;
            setEvents((prev) => [...prev, { id, event: msg.event as AgentEvent, timestamp: new Date().toISOString() }]);
            break;
          }
          case "agent:status": {
            const status = msg.status as string;
            if (status === "working" || status === "done" || status === "rate_limited") {
              setAgentStatus(status);
            }
            break;
          }
          case "daemon:connected":
            setDaemonConnected(true);
            setAgentStatus("idle");
            // Re-request history if it was never loaded (e.g. the initial
            // request was forwarded to a stale daemon socket that never replied).
            if (!historyLoaded.current && ws?.readyState === WebSocket.OPEN) {
              historyRetries.current = 0;
              requestHistory(ws);
            }
            break;
          case "daemon:disconnected":
            setDaemonConnected(false);
            setAgentStatus("idle");
            break;
        }
      };

      ws.onclose = () => {
        if (closed) return;
        setWsConnected(false);
        setDaemonConnected(false);
      };
    }

    connect();

    return () => {
      closed = true;
      clearTimeout(historyRetryTimer.current);
      ws?.close();
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [sessionId, enabled]);

  const sendMessage = useCallback((content: string, senderId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "human:message", content, senderId }));
  }, []);

  return { events, sendMessage, daemonConnected, wsConnected, agentStatus };
}
