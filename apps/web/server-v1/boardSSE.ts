import type { BoardAction } from "@agent-kanban/shared";
import { createLogger } from "./logger";
import { getBoardActions, getBoardActionsByBoardId } from "./taskRepo";
import type { Env } from "./types";

const INITIAL_LOOKBACK_MS = 5 * 60 * 1000;

interface BoardSSEEvent {
  id: string;
  data: string;
  created_at: string;
}

const logger = createLogger("boardSSE");

export async function createBoardSSEResponse(env: Env, boardId: string, ownerId: string): Promise<Response> {
  const db = env.DB;
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const write = (event: BoardSSEEvent) => {
    let msg = `id: ${event.id}\n`;
    msg += `event: board_note\n`;
    msg += `data: ${event.data}\n\n`;
    return writer.write(encoder.encode(msg));
  };

  const toEvent = (note: BoardAction): BoardSSEEvent => ({
    id: note.id,
    data: JSON.stringify(note),
    created_at: note.created_at,
  });

  const run = async () => {
    let lastSeen = new Date(Date.now() - INITIAL_LOOKBACK_MS).toISOString();

    const initial = await getBoardActions(db, boardId, ownerId, lastSeen);
    for (const note of initial) {
      await write(toEvent(note));
    }
    if (initial.length > 0) {
      lastSeen = initial[initial.length - 1].created_at;
    }

    // Poll every 2s for up to 25s (CF Workers 30s limit)
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));

      const notes = await getBoardActions(db, boardId, ownerId, lastSeen);
      for (const note of notes) {
        await write(toEvent(note));
      }
      if (notes.length > 0) {
        lastSeen = notes[notes.length - 1].created_at;
      }
    }

    await writer.close();
  };

  run().catch((err) => {
    logger.error(`board SSE error boardId=${boardId}: ${err.message}`);
    writer.close().catch(() => {});
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export async function createPublicBoardSSEResponse(env: Env, boardId: string): Promise<Response> {
  const db = env.DB;
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const write = (event: BoardSSEEvent) => {
    let msg = `id: ${event.id}\n`;
    msg += `event: board_note\n`;
    msg += `data: ${event.data}\n\n`;
    return writer.write(encoder.encode(msg));
  };

  const toEvent = (note: BoardAction): BoardSSEEvent => ({
    id: note.id,
    data: JSON.stringify(note),
    created_at: note.created_at,
  });

  const run = async () => {
    let lastSeen = new Date(Date.now() - INITIAL_LOOKBACK_MS).toISOString();

    const initial = await getBoardActionsByBoardId(db, boardId, lastSeen);
    for (const note of initial) {
      await write(toEvent(note));
    }
    if (initial.length > 0) {
      lastSeen = initial[initial.length - 1].created_at;
    }

    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));

      const notes = await getBoardActionsByBoardId(db, boardId, lastSeen);
      for (const note of notes) {
        await write(toEvent(note));
      }
      if (notes.length > 0) {
        lastSeen = notes[notes.length - 1].created_at;
      }
    }

    await writer.close();
  };

  run().catch((err) => {
    logger.error(`public board SSE error boardId=${boardId}: ${err.message}`);
    writer.close().catch(() => {});
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
