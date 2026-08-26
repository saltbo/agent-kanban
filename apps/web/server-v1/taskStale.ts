import { STALE_TIMEOUT_MS } from "@agent-kanban/shared";
import type { D1 } from "./db";
import { releaseTaskRuntimeBinding } from "./taskDispatch";
import { getTask, releaseTask } from "./taskRepo";
import type { Env } from "./types";

export async function detectAndReleaseStale(db: D1, boardId: string): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_TIMEOUT_MS).toISOString();

  const staleTasks = await db
    .prepare(`
    SELECT t.id, t.assigned_to FROM tasks t
    WHERE t.board_id = ? AND t.status = 'in_progress' AND t.assigned_to IS NOT NULL
    AND (
      SELECT MAX(tl.created_at) FROM task_actions tl WHERE tl.task_id = t.id
    ) < ?
  `)
    .bind(boardId, cutoff)
    .all<{ id: string; assigned_to: string }>();

  for (const stale of staleTasks.results) {
    await releaseTask(db, stale.id, "machine", "system", "machine", "timed_out");
  }
}

// Sweep every board. Called from the scheduled() cron handler — cheaper than
// running detectAndReleaseStale on every read path, and no worse for UX since
// stale task release is eventually-consistent anyway.
//
// Releases are issued one-at-a-time via releaseTask (multi-statement, can't
// safely batch). Under a long cron outage this degrades to a serialized
// chain, but the stale timeout (24h) means such volumes are rare and the
// cron will make steady progress on subsequent ticks either way.
export async function detectAndReleaseStaleAll(db: D1, env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_TIMEOUT_MS).toISOString();

  const staleTasks = await db
    .prepare(`
    SELECT t.id, b.owner_id FROM tasks t
    JOIN boards b ON t.board_id = b.id
    WHERE t.status = 'in_progress' AND t.assigned_to IS NOT NULL
    AND (
      SELECT MAX(tl.created_at) FROM task_actions tl WHERE tl.task_id = t.id
    ) < ?
  `)
    .bind(cutoff)
    .all<{ id: string; owner_id: string }>();

  for (const stale of staleTasks.results) {
    // Stop the wedged runtime session before releasing, so it doesn't keep
    // burning quota against a task that is no longer running it.
    const task = await getTask(db, stale.id, stale.owner_id);
    if (task) await releaseTaskRuntimeBinding(db, env, stale.owner_id, task, "timeout");
    await releaseTask(db, stale.id, "machine", "system", "machine", "timed_out");
  }
}
