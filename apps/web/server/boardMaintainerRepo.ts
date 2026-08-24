import { type D1, newLongId } from "./db";

export interface BoardMaintainer {
  id: string;
  owner_id: string;
  board_id: string;
  agent_id: string;
  ama_schedule_id: string;
  ama_http_trigger_id: string | null;
  ama_http_trigger_serialized: boolean;
  ama_http_trigger_serialization_attempted_at: string | null;
  ama_memory_store_id: string | null;
  ama_board_vault_id: string | null;
  prompt: string;
  interval_seconds: number;
  heartbeat_enabled: boolean;
  status: "active" | "paused" | "archived";
  last_run_at: string | null;
  last_ama_session_id: string | null;
  last_error_message: string | null;
  api_key_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateBoardMaintainerInput {
  id?: string;
  boardId: string;
  agentId: string;
  amaScheduleId: string;
  amaHttpTriggerId: string | null;
  amaHttpTriggerSerialized?: boolean;
  amaMemoryStoreId: string | null;
  amaBoardVaultId?: string | null;
  prompt: string;
  intervalSeconds: number;
  heartbeatEnabled: boolean;
  status: "active" | "paused";
  apiKeyId?: string | null;
}

export interface UpdateBoardMaintainerInput {
  prompt?: string;
  intervalSeconds?: number;
  heartbeatEnabled?: boolean;
  status?: "active" | "paused" | "archived";
}

type BoardMaintainerRow = Omit<BoardMaintainer, "heartbeat_enabled" | "ama_http_trigger_serialized"> & {
  heartbeat_enabled: number;
  ama_http_trigger_serialized: number;
};

function mapBoardMaintainer(row: BoardMaintainerRow): BoardMaintainer {
  return {
    ...row,
    heartbeat_enabled: row.heartbeat_enabled === 1,
    ama_http_trigger_serialized: row.ama_http_trigger_serialized === 1,
  };
}

export async function getOwnedBoard(db: D1, ownerId: string, boardId: string) {
  return await db.prepare("SELECT id, name FROM boards WHERE id = ? AND owner_id = ?").bind(boardId, ownerId).first<{ id: string; name: string }>();
}

export async function createBoardMaintainer(db: D1, ownerId: string, input: CreateBoardMaintainerInput): Promise<BoardMaintainer> {
  const id = input.id ?? newLongId();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO board_maintainers (
        id, owner_id, board_id, agent_id, ama_schedule_id, ama_http_trigger_id, ama_http_trigger_serialized, ama_memory_store_id, ama_board_vault_id,
        prompt, interval_seconds, heartbeat_enabled, status, api_key_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      ownerId,
      input.boardId,
      input.agentId,
      input.amaScheduleId,
      input.amaHttpTriggerId,
      input.amaHttpTriggerSerialized ? 1 : 0,
      input.amaMemoryStoreId,
      input.amaBoardVaultId ?? null,
      input.prompt,
      input.intervalSeconds,
      input.heartbeatEnabled ? 1 : 0,
      input.status,
      input.apiKeyId ?? null,
      now,
      now,
    )
    .run();
  const maintainer = await getBoardMaintainer(db, ownerId, input.boardId, id);
  if (!maintainer) throw new Error("Board maintainer was not persisted");
  return maintainer;
}

export async function listBoardMaintainers(db: D1, ownerId: string, boardId: string): Promise<BoardMaintainer[]> {
  const rows = await db
    .prepare("SELECT * FROM board_maintainers WHERE owner_id = ? AND board_id = ? AND status != 'archived' ORDER BY created_at DESC")
    .bind(ownerId, boardId)
    .all<BoardMaintainerRow>();
  return rows.results.map(mapBoardMaintainer);
}

export async function getBoardMaintainer(db: D1, ownerId: string, boardId: string, maintainerId: string): Promise<BoardMaintainer | null> {
  const row = await db
    .prepare("SELECT * FROM board_maintainers WHERE owner_id = ? AND board_id = ? AND id = ?")
    .bind(ownerId, boardId, maintainerId)
    .first<BoardMaintainerRow>();
  return row ? mapBoardMaintainer(row) : null;
}

export async function updateBoardMaintainer(
  db: D1,
  ownerId: string,
  boardId: string,
  maintainerId: string,
  updates: UpdateBoardMaintainerInput,
): Promise<BoardMaintainer | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.prompt !== undefined) {
    sets.push("prompt = ?");
    values.push(updates.prompt);
  }
  if (updates.intervalSeconds !== undefined) {
    sets.push("interval_seconds = ?");
    values.push(updates.intervalSeconds);
  }
  if (updates.heartbeatEnabled !== undefined) {
    sets.push("heartbeat_enabled = ?");
    values.push(updates.heartbeatEnabled ? 1 : 0);
  }
  if (updates.status !== undefined) {
    sets.push("status = ?");
    values.push(updates.status);
  }
  if (sets.length === 0) return await getBoardMaintainer(db, ownerId, boardId, maintainerId);
  sets.push("updated_at = ?");
  values.push(new Date().toISOString(), ownerId, boardId, maintainerId);
  await db
    .prepare(`UPDATE board_maintainers SET ${sets.join(", ")} WHERE owner_id = ? AND board_id = ? AND id = ?`)
    .bind(...values)
    .run();
  return await getBoardMaintainer(db, ownerId, boardId, maintainerId);
}

export async function setBoardMaintainerVaultId(db: D1, ownerId: string, boardId: string, maintainerId: string, vaultId: string): Promise<void> {
  await db
    .prepare("UPDATE board_maintainers SET ama_board_vault_id = ?, updated_at = ? WHERE owner_id = ? AND board_id = ? AND id = ?")
    .bind(vaultId, new Date().toISOString(), ownerId, boardId, maintainerId)
    .run();
}

export async function setBoardMaintainerApiKeyId(db: D1, ownerId: string, boardId: string, maintainerId: string, apiKeyId: string): Promise<void> {
  await db
    .prepare("UPDATE board_maintainers SET api_key_id = ?, updated_at = ? WHERE owner_id = ? AND board_id = ? AND id = ?")
    .bind(apiKeyId, new Date().toISOString(), ownerId, boardId, maintainerId)
    .run();
}

export async function markBoardMaintainerHttpTriggerSerialized(db: D1, ownerId: string, boardId: string, maintainerId: string): Promise<void> {
  await db
    .prepare("UPDATE board_maintainers SET ama_http_trigger_serialized = 1, updated_at = ? WHERE owner_id = ? AND board_id = ? AND id = ?")
    .bind(new Date().toISOString(), ownerId, boardId, maintainerId)
    .run();
}

export async function markBoardMaintainerHttpTriggerSerializationAttempted(
  db: D1,
  ownerId: string,
  boardId: string,
  maintainerId: string,
): Promise<void> {
  await db
    .prepare("UPDATE board_maintainers SET ama_http_trigger_serialization_attempted_at = ? WHERE owner_id = ? AND board_id = ? AND id = ?")
    .bind(new Date().toISOString(), ownerId, boardId, maintainerId)
    .run();
}

export async function listUnserializedBoardMaintainers(db: D1, limit = 25): Promise<BoardMaintainer[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM board_maintainers
       WHERE ama_http_trigger_id IS NOT NULL
         AND ama_http_trigger_serialized = 0
         AND status != 'archived'
       ORDER BY COALESCE(ama_http_trigger_serialization_attempted_at, created_at) ASC, created_at ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<BoardMaintainerRow>();
  return rows.results.map(mapBoardMaintainer);
}

export async function deleteBoardMaintainer(db: D1, ownerId: string, boardId: string, maintainerId: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM board_maintainers WHERE owner_id = ? AND board_id = ? AND id = ?")
    .bind(ownerId, boardId, maintainerId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function isActiveMaintainerForRepository(db: D1, ownerId: string, agentId: string, repositoryId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `
      SELECT 1
      FROM board_maintainers bm
      JOIN boards b ON b.id = bm.board_id AND b.owner_id = bm.owner_id
      JOIN board_repositories br ON br.board_id = bm.board_id AND br.repository_id = ?
      JOIN repositories r ON r.id = br.repository_id AND r.owner_id = bm.owner_id
      WHERE bm.owner_id = ?
        AND bm.agent_id = ?
        AND bm.status = 'active'
      LIMIT 1
    `,
    )
    .bind(repositoryId, ownerId, agentId)
    .first();
  return Boolean(row);
}

export async function isActiveMaintainerForBoard(db: D1, ownerId: string, agentId: string, boardId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `
      SELECT 1
      FROM board_maintainers
      WHERE owner_id = ?
        AND agent_id = ?
        AND board_id = ?
        AND status = 'active'
      LIMIT 1
    `,
    )
    .bind(ownerId, agentId, boardId)
    .first();
  return Boolean(row);
}

export async function listActiveBoardMaintainersForRepository(db: D1, installationId: number, fullName: string): Promise<BoardMaintainer[]> {
  const canonicalFullName = fullName.toLowerCase();
  const result = await db
    .prepare(
      `
      SELECT DISTINCT bm.*
      FROM board_maintainers bm
      JOIN board_repositories br ON br.board_id = bm.board_id
      JOIN repositories r ON r.id = br.repository_id AND r.owner_id = bm.owner_id
      JOIN github_installations gi ON gi.owner_id = bm.owner_id AND gi.installation_id = ? AND gi.suspended_at IS NULL
      LEFT JOIN github_installation_repositories gir
        ON gir.installation_id = gi.installation_id AND gir.full_name = ?
      WHERE bm.status = 'active'
        AND bm.ama_http_trigger_id IS NOT NULL
        AND replace(replace(lower(r.url), 'https://github.com/', ''), 'http://github.com/', '') = ?
        AND (gi.repository_selection = 'all' OR gir.full_name IS NOT NULL)
      ORDER BY bm.created_at DESC
    `,
    )
    .bind(installationId, canonicalFullName, canonicalFullName)
    .all<BoardMaintainerRow>();
  return result.results.map(mapBoardMaintainer);
}
