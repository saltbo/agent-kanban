import type { Message, SenderType } from "@agent-kanban/shared";
import { type D1, MAX_TASK_PARTITION_ROWS, newLongId } from "./db";

export async function createMessage(db: D1, taskId: string, senderType: SenderType, senderId: string, content: string): Promise<Message> {
  const id = newLongId();
  const now = new Date().toISOString();
  await db
    .prepare("INSERT INTO messages (id, task_id, sender_type, sender_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, taskId, senderType, senderId, content, now)
    .run();

  return { id, task_id: taskId, sender_type: senderType, sender_id: senderId, content, created_at: now };
}

// When `since` is provided, returns up to `limit` rows after the cursor in
// ASC order (incremental catch-up). Without `since`, returns the most recent
// `limit` rows — fetched DESC then reversed so callers always see ASC order.
// A hard LIMIT protects against task_id partitions with runaway row counts.
//
// KNOWN LIMITATION: `since` uses `created_at > ?`, which skips rows sharing
// the cursor's millisecond. `newLongId()` is random (not monotonic) so the id
// can't serve as a tiebreaker today. Tracked for follow-up — fix requires
// either a monotonic sequence column or cursor-pair semantics.
export async function listMessages(db: D1, taskId: string, since?: string, limit: number = MAX_TASK_PARTITION_ROWS): Promise<Message[]> {
  if (since) {
    const result = await db
      .prepare("SELECT * FROM messages WHERE task_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT ?")
      .bind(taskId, since, limit)
      .all<Message>();
    return result.results;
  }
  const result = await db.prepare("SELECT * FROM messages WHERE task_id = ? ORDER BY created_at DESC LIMIT ?").bind(taskId, limit).all<Message>();
  return result.results.reverse();
}
