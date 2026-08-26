import type { BoardAction } from "@agent-kanban/shared";
import { useEffect, useRef, useState } from "react";

const MAX_EVENTS = 50;

export function usePublicBoardSSE(slug: string | undefined) {
  const [events, setEvents] = useState<BoardAction[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!slug) return;

    function connect() {
      esRef.current?.close();

      const es = new EventSource(`/api/share/${slug}/stream`);
      esRef.current = es;

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
        reconnectTimer.current = setTimeout(connect, 2000);
      };
    }

    connect();

    return () => {
      esRef.current?.close();
      esRef.current = null;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [slug]);

  return { events };
}
