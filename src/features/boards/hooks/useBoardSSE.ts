import type { BoardAction } from "@shared";
import { useEffect, useRef, useState } from "react";

const MAX_EVENTS = 50;

export function useBoardSSE(boardId: string | undefined) {
  const [events, setEvents] = useState<BoardAction[]>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!boardId) return;

    function connect() {
      esRef.current?.close();

      const es = new EventSource(`/api/boards/${boardId}/stream`, { withCredentials: true });
      esRef.current = es;

      es.onopen = () => {
        setConnected(true);
      };

      es.addEventListener("board_note", (e: MessageEvent) => {
        const note: BoardAction = JSON.parse(e.data);
        setEvents((prev) => {
          if (prev.some((existing) => existing.id === note.id)) return prev;
          const next = [...prev, note];
          return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
        });
      });

      es.onerror = () => {
        es.close();
        esRef.current = null;
        setConnected(false);
        reconnectTimer.current = setTimeout(connect, 2000);
      };
    }

    connect();

    return () => {
      esRef.current?.close();
      esRef.current = null;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [boardId]);

  return { events, connected };
}
