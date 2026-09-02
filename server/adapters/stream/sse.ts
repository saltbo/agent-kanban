import { getTaskActions } from "@server/adapters/d1/taskRepo";
import { MAX_TASK_PARTITION_ROWS } from "@server/db";
import type { Env } from "@server/env";

interface SSEEvent {
  id: string;
  type: "note";
  data: string;
  created_at: string;
}

export async function createSSEResponse(env: Env, taskId: string, lastEventId: string | null): Promise<Response> {
  const db = env.DB;

  // Resolve lastEventId before creating the stream
  let since: string | undefined;
  if (lastEventId) {
    const ref = await db
      .prepare("SELECT created_at FROM task_actions WHERE id = ? AND task_id = ?")
      .bind(lastEventId, taskId)
      .first<{ created_at: string }>();
    if (!ref) {
      return Response.json(
        {
          error: {
            code: "INVALID_LAST_EVENT_ID",
            message: "Unknown event ID, reconnect without Last-Event-ID",
          },
        },
        { status: 400 },
      );
    }
    since = ref.created_at;
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const write = (event: SSEEvent) => {
    let msg = `id: ${event.id}\n`;
    msg += `event: ${event.type}\n`;
    msg += `data: ${event.data}\n\n`;
    return writer.write(encoder.encode(msg));
  };

  // Signal the client that their catch-up window hit the hard row cap and
  // older rows were silently truncated. Client should drop its cursor and
  // reload the task via HTTP. Unknown SSE event types are ignored by older
  // clients, so this is backward-compatible.
  const writeGap = (reason: string) => {
    const msg = `event: gap\ndata: ${JSON.stringify({ reason })}\n\n`;
    return writer.write(encoder.encode(msg));
  };

  const run = async () => {
    // Without `since`, fetch the 50 most recent — repo layer already returns
    // them in ASC order. With `since`, cap catch-up at the partition ceiling
    // so reconnects after long offline periods can't detonate D1 reads.
    const initialLimit = since ? MAX_TASK_PARTITION_ROWS : 50;
    const initialNotes = await getTaskActions(db, taskId, since, initialLimit);

    // When catching up and either feed returned exactly the cap, older rows
    // were truncated. Emit a gap signal before the rows we do have so the
    // client can decide to reload via HTTP instead of silently missing data.
    if (since && initialNotes.length === initialLimit) {
      await writeGap("initial_truncated");
    }

    const noteEvents: SSEEvent[] = initialNotes.map((l) => ({
      id: l.id,
      type: "note" as const,
      data: JSON.stringify(l),
      created_at: l.created_at,
    }));
    const batch = noteEvents;
    for (const event of batch) {
      await write(event);
    }

    let lastSeen = batch.length > 0 ? batch[batch.length - 1].created_at : since || new Date().toISOString();

    // Poll every 2s for up to 25s (CF Workers 30s limit)
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));

      const newNotes = await getTaskActions(db, taskId, lastSeen, MAX_TASK_PARTITION_ROWS);

      // Same ceiling signal during live polling — a 2s window with >500 new
      // rows means the client's cursor is behind reality and the tail is at
      // risk of silent truncation on the next tick. Tell the client to reload.
      if (newNotes.length === MAX_TASK_PARTITION_ROWS) {
        await writeGap("poll_truncated");
      }

      const newNoteEvents = newNotes.map((l) => ({
        id: l.id,
        type: "note" as const,
        data: JSON.stringify(l),
        created_at: l.created_at,
      }));
      const merged = newNoteEvents;

      for (const event of merged) {
        await write(event);
      }

      if (merged.length > 0) {
        lastSeen = merged[merged.length - 1].created_at;
      }
    }

    await writer.close();
  };

  // Run in background — don't await
  run().catch(() => writer.close().catch(() => {}));

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
