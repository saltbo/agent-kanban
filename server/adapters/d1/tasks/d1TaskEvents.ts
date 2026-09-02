import type { D1 } from "@server/db";
import type { TaskEventRepository, TaskEventSnapshot } from "@server/usecases/tasks/waitForTaskEvents";
import type { Task } from "@shared";
import { mapTaskRow } from "./taskRow";

type TaskEventRow = Task & { event_offset: number };

export function d1TaskEventRepository(db: D1): TaskEventRepository {
  return {
    async readSnapshot(ownerId: string, taskIds: string[]): Promise<TaskEventSnapshot | null> {
      const result = await db
        .prepare(`
          WITH requested(id) AS (
            SELECT CAST(value AS TEXT) FROM json_each(?)
          )
          SELECT t.*, COALESCE((
            SELECT MAX(event.sequence)
            FROM task_event_offsets event
            WHERE event.task_id IN (SELECT id FROM requested)
          ), 0) AS event_offset
          FROM tasks t
          JOIN boards b ON b.id = t.board_id
          WHERE b.owner_id = ? AND t.id IN (SELECT id FROM requested)
        `)
        .bind(JSON.stringify(taskIds), ownerId)
        .all<TaskEventRow>();

      if (result.results.length !== taskIds.length) return null;
      const byId = new Map(
        result.results.map((row) => {
          const { event_offset: _eventOffset, ...task } = row;
          return [row.id, task as Task] as const;
        }),
      );
      const tasks = taskIds.map((taskId) => mapTaskRow(byId.get(taskId)!));
      return { tasks, offset: result.results[0]?.event_offset ?? 0 };
    },
  };
}
