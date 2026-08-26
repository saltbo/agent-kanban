import type { D1 } from "./db";
import { TASK_RUNTIME_SOURCE_ANNOTATION, type TaskRuntimeSource } from "./runtimeBinding";

export interface PendingTaskRuntimeBinding {
  id: string;
  ownerId: string;
  assignedTo: string;
  runtime: string;
  model: string | null;
  current: TaskRuntimeSource | null;
  hasAmaBinding: boolean;
}

export async function listPendingTaskRuntimeBindings(db: D1): Promise<PendingTaskRuntimeBinding[]> {
  const rows = await db
    .prepare(`
      SELECT
        t.id,
        b.owner_id,
        t.assigned_to,
        a.runtime,
        a.model,
        json_extract(t.metadata, '$.annotations."${TASK_RUNTIME_SOURCE_ANNOTATION}"') AS current_source,
        CASE WHEN
          (
            json_type(t.metadata, '$.annotations."ama.sessionId"') = 'text'
            AND length(json_extract(t.metadata, '$.annotations."ama.sessionId"')) > 0
          )
          OR (
            json_type(t.metadata, '$.annotations."agentSessionId"') = 'text'
            AND length(json_extract(t.metadata, '$.annotations."agentSessionId"')) > 0
          )
        THEN 1 ELSE 0 END AS has_ama_binding
      FROM tasks t
      JOIN boards b ON t.board_id = b.id
      JOIN agents a ON a.id = t.assigned_to AND a.owner_id = b.owner_id
      WHERE t.status = 'todo' AND t.assigned_to IS NOT NULL
        AND json_extract(t.metadata, '$.annotations."ama.dispatch.result"') IS NULL
    `)
    .all<{
      id: string;
      owner_id: string;
      assigned_to: string;
      runtime: string;
      model: string | null;
      current_source: string | null;
      has_ama_binding: number;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    ownerId: row.owner_id,
    assignedTo: row.assigned_to,
    runtime: row.runtime,
    model: row.model,
    current: row.current_source === "ama" || row.current_source === "legacy" ? row.current_source : null,
    hasAmaBinding: row.has_ama_binding === 1,
  }));
}

export async function compareAndSetTaskRuntimeSource(
  db: D1,
  taskId: string,
  assignedTo: string,
  current: TaskRuntimeSource | null,
  next: TaskRuntimeSource,
): Promise<boolean> {
  const sourceGuard = current
    ? `json_extract(metadata, '$.annotations."${TASK_RUNTIME_SOURCE_ANNOTATION}"') = ?`
    : `json_extract(metadata, '$.annotations."${TASK_RUNTIME_SOURCE_ANNOTATION}"') IS NULL`;
  const binds = current ? [next, taskId, assignedTo, current] : [next, taskId, assignedTo];
  const result = await db
    .prepare(`
      UPDATE tasks SET metadata = json_set(
        json_set(COALESCE(metadata, '{}'), '$.annotations', json(COALESCE(json_extract(metadata, '$.annotations'), '{}'))),
        '$.annotations."${TASK_RUNTIME_SOURCE_ANNOTATION}"', ?
      )
      WHERE id = ?
        AND status = 'todo'
        AND assigned_to = ?
        AND json_extract(metadata, '$.annotations."ama.dispatch.result"') IS NULL
        AND (
          json_extract(metadata, '$.annotations."ama.sessionId"') IS NULL
          OR (
            json_type(metadata, '$.annotations."ama.sessionId"') = 'text'
            AND length(json_extract(metadata, '$.annotations."ama.sessionId"')) = 0
          )
        )
        AND (
          json_extract(metadata, '$.annotations."agentSessionId"') IS NULL
          OR (
            json_type(metadata, '$.annotations."agentSessionId"') = 'text'
            AND length(json_extract(metadata, '$.annotations."agentSessionId"')) = 0
          )
        )
        AND ${sourceGuard}
    `)
    .bind(...binds)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function persistInferredAmaTaskRuntimeSource(db: D1, taskId: string, assignedTo: string): Promise<boolean> {
  const result = await db
    .prepare(`
      UPDATE tasks SET metadata = json_set(
        json_set(COALESCE(metadata, '{}'), '$.annotations', json(COALESCE(json_extract(metadata, '$.annotations'), '{}'))),
        '$.annotations."${TASK_RUNTIME_SOURCE_ANNOTATION}"', 'ama'
      )
      WHERE id = ?
        AND status = 'todo'
        AND assigned_to = ?
        AND json_extract(metadata, '$.annotations."${TASK_RUNTIME_SOURCE_ANNOTATION}"') IS NULL
        AND (
          (
            json_type(metadata, '$.annotations."ama.sessionId"') = 'text'
            AND length(json_extract(metadata, '$.annotations."ama.sessionId"')) > 0
          )
          OR (
            json_type(metadata, '$.annotations."agentSessionId"') = 'text'
            AND length(json_extract(metadata, '$.annotations."agentSessionId"')) > 0
          )
        )
    `)
    .bind(taskId, assignedTo)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}
