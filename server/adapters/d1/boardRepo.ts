import { mapTaskRow } from "@server/adapters/d1/tasks/taskRow";
import { type D1, newId, parseJsonFields } from "@server/db";
import type { PageWindow } from "@server/domain/pagination";
import type { Board, BoardLabel, BoardType, BoardWithTasks, Task } from "@shared";
import { HTTPException } from "hono/http-exception";
import { customAlphabet } from "nanoid";

const nanoidSlug = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

import {
  completeIdempotency,
  type ResourceIdempotency,
  ResourceIdempotencyReplay,
  resolveIdempotentResponse,
} from "@server/adapters/d1/resourceIdempotency";
import { computeBlocked } from "@server/adapters/d1/taskDeps";

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

function parseBoard<T extends Board | BoardWithTasks>(board: T): T {
  return parseJsonFields(board, ["labels"] as (keyof T)[]);
}

function normalizeLabel(label: BoardLabel): BoardLabel {
  if (!label || typeof label.name !== "string" || typeof label.color !== "string") {
    throw new HTTPException(400, { message: "Label name and color are required" });
  }
  const name = label.name.trim();
  const color = label.color.trim();
  if (!name) throw new HTTPException(400, { message: "Label name is required" });
  if (!HEX_COLOR.test(color)) throw new HTTPException(400, { message: "Label color must be a hex color like #22D3EE" });
  return { name, color, description: label.description?.trim() || "" };
}

function normalizeLabels(labels: BoardLabel[]): BoardLabel[] {
  const seen = new Set<string>();
  return labels.map(normalizeLabel).map((label) => {
    if (seen.has(label.name)) throw new HTTPException(400, { message: `Duplicate label: ${label.name}` });
    seen.add(label.name);
    return label;
  });
}

export async function createBoard(
  db: D1,
  ownerId: string,
  name: string,
  type: BoardType,
  description?: string,
  idempotency?: ResourceIdempotency<Board>,
): Promise<Board> {
  const id = newId();
  const now = new Date().toISOString();
  const board: Board = {
    id,
    owner_id: ownerId,
    name,
    description: description || null,
    type,
    labels: [],
    visibility: "private",
    share_slug: null,
    created_at: now,
    updated_at: now,
  };
  const insertion = db
    .prepare("INSERT INTO boards (id, owner_id, name, description, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, ownerId, name, description || null, type, now, now);
  try {
    if (idempotency) await db.batch([insertion, completeIdempotency(db, idempotency, id, board)]);
    else await insertion.run();
  } catch (error) {
    if (!idempotency) throw error;
    const replay = await resolveIdempotentResponse(db, idempotency);
    if (!replay) throw error;
    throw new ResourceIdempotencyReplay(replay);
  }
  return board;
}

export async function listBoards(db: D1, ownerId: string): Promise<Board[]> {
  const result = await db.prepare("SELECT * FROM boards WHERE owner_id = ? ORDER BY created_at DESC").bind(ownerId).all<Board>();
  return result.results.map(parseBoard);
}

export async function listBoardPage(db: D1, ownerId: string, window: PageWindow, name?: string): Promise<Board[]> {
  let query = "SELECT * FROM boards WHERE owner_id = ? AND created_at <= ?";
  const binds: unknown[] = [ownerId, window.snapshot];
  if (name) {
    query += " AND name = ?";
    binds.push(name);
  }
  if (window.afterCreatedAt && window.afterId) {
    query += " AND (created_at < ? OR (created_at = ? AND id < ?))";
    binds.push(window.afterCreatedAt, window.afterCreatedAt, window.afterId);
  }
  query += " ORDER BY created_at DESC, id DESC LIMIT ?";
  binds.push(window.pageSize + 1);
  const result = await db
    .prepare(query)
    .bind(...binds)
    .all<Board>();
  return result.results.map(parseBoard);
}

export async function getBoardByName(db: D1, ownerId: string, name: string): Promise<Board | null> {
  const board = await db.prepare("SELECT * FROM boards WHERE owner_id = ? AND name = ?").bind(ownerId, name).first<Board>();
  return board ? parseBoard(board) : null;
}

export async function getBoard(db: D1, boardId: string, ownerId: string): Promise<BoardWithTasks | null> {
  const board = await db.prepare("SELECT * FROM boards WHERE id = ? AND owner_id = ?").bind(boardId, ownerId).first<Board>();
  if (!board) return null;

  const tasks = await db
    .prepare(`
    SELECT t.*, r.name as repository_name FROM tasks t
    LEFT JOIN repositories r ON t.repository_id = r.id
    WHERE t.board_id = ?
    ORDER BY
      CASE t.status WHEN 'todo' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'in_review' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
      CASE WHEN t.status = 'todo' THEN t.position END ASC,
      CASE WHEN t.status != 'todo' THEN t.updated_at END DESC
  `)
    .bind(boardId)
    .all<Task>();

  const taskIds = tasks.results.map((t: Task) => t.id);
  if (taskIds.length > 0) {
    const blockedSet = await computeBlocked(db, taskIds);
    for (const task of tasks.results) {
      task.blocked = blockedSet.has(task.id);
    }
  }

  return parseBoard({ ...board, tasks: tasks.results.map(mapTaskRow) });
}

export async function getDefaultBoard(db: D1, ownerId: string): Promise<Board | null> {
  const board = await db.prepare("SELECT * FROM boards WHERE owner_id = ? ORDER BY created_at ASC LIMIT 1").bind(ownerId).first<Board>();
  return board ? parseBoard(board) : null;
}

export async function updateBoard(
  db: D1,
  boardId: string,
  ownerId: string,
  updates: { name?: string; description?: string; visibility?: "private" | "public"; labels?: BoardLabel[] },
): Promise<Board | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) {
    sets.push("name = ?");
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    sets.push("description = ?");
    values.push(updates.description || null);
  }
  if (updates.visibility !== undefined) {
    sets.push("visibility = ?");
    values.push(updates.visibility);
    if (updates.visibility === "public") {
      const existing = await db
        .prepare("SELECT share_slug FROM boards WHERE id = ? AND owner_id = ?")
        .bind(boardId, ownerId)
        .first<{ share_slug: string | null }>();
      if (existing && !existing.share_slug) {
        sets.push("share_slug = ?");
        values.push(nanoidSlug());
      }
    }
  }
  if (updates.labels !== undefined) {
    sets.push("labels = ?");
    values.push(JSON.stringify(normalizeLabels(updates.labels)));
  }
  if (sets.length === 0) {
    const board = await db.prepare("SELECT * FROM boards WHERE id = ? AND owner_id = ?").bind(boardId, ownerId).first<Board>();
    return board ? parseBoard(board) : null;
  }

  sets.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(boardId);
  values.push(ownerId);

  await db
    .prepare(`UPDATE boards SET ${sets.join(", ")} WHERE id = ? AND owner_id = ?`)
    .bind(...values)
    .run();
  const board = await db.prepare("SELECT * FROM boards WHERE id = ? AND owner_id = ?").bind(boardId, ownerId).first<Board>();
  return board ? parseBoard(board) : null;
}

export async function createBoardLabel(db: D1, boardId: string, ownerId: string, input: BoardLabel): Promise<Board | null> {
  const board = await db.prepare("SELECT * FROM boards WHERE id = ? AND owner_id = ?").bind(boardId, ownerId).first<Board>();
  if (!board) return null;
  const labels = parseBoard(board).labels;
  const label = normalizeLabel(input);
  if (labels.some((existing) => existing.name === label.name)) throw new HTTPException(409, { message: `Label already exists: ${label.name}` });
  return updateBoard(db, boardId, ownerId, { labels: [...labels, label] });
}

export async function updateBoardLabel(db: D1, boardId: string, ownerId: string, name: string, input: Partial<BoardLabel>): Promise<Board | null> {
  const board = await db.prepare("SELECT * FROM boards WHERE id = ? AND owner_id = ?").bind(boardId, ownerId).first<Board>();
  if (!board) return null;
  const labels = parseBoard(board).labels;
  const current = labels.find((label) => label.name === name);
  if (!current) throw new HTTPException(404, { message: `Label not found: ${name}` });
  const next = normalizeLabel({
    name: input.name ?? current.name,
    color: input.color ?? current.color,
    description: input.description ?? current.description,
  });
  if (next.name !== name && labels.some((label) => label.name === next.name)) {
    throw new HTTPException(409, { message: `Label already exists: ${next.name}` });
  }

  const updatedLabels = labels.map((label) => (label.name === name ? next : label));
  await updateBoard(db, boardId, ownerId, { labels: updatedLabels });

  if (next.name !== name) {
    const tasks = await db
      .prepare("SELECT id, labels FROM tasks WHERE board_id = ? AND labels IS NOT NULL")
      .bind(boardId)
      .all<{ id: string; labels: string }>();
    const statements = tasks.results
      .map((task) => ({ id: task.id, labels: JSON.parse(task.labels) as string[] }))
      .filter((task) => task.labels.includes(name))
      .map((task) =>
        db
          .prepare("UPDATE tasks SET labels = ?, updated_at = ? WHERE id = ?")
          .bind(JSON.stringify(task.labels.map((label) => (label === name ? next.name : label))), new Date().toISOString(), task.id),
      );
    if (statements.length > 0) await db.batch(statements);
  }

  const nextBoard = await db.prepare("SELECT * FROM boards WHERE id = ? AND owner_id = ?").bind(boardId, ownerId).first<Board>();
  return nextBoard ? parseBoard(nextBoard) : null;
}

export async function deleteBoardLabel(db: D1, boardId: string, ownerId: string, name: string): Promise<Board | null> {
  const board = await db.prepare("SELECT * FROM boards WHERE id = ? AND owner_id = ?").bind(boardId, ownerId).first<Board>();
  if (!board) return null;
  const labels = parseBoard(board).labels;
  if (!labels.some((label) => label.name === name)) throw new HTTPException(404, { message: `Label not found: ${name}` });

  const tasks = await db
    .prepare("SELECT id, labels FROM tasks WHERE board_id = ? AND labels IS NOT NULL")
    .bind(boardId)
    .all<{ id: string; labels: string }>();
  const now = new Date().toISOString();
  const statements = tasks.results
    .map((task) => {
      const current = JSON.parse(task.labels) as string[];
      return { id: task.id, current, next: current.filter((label) => label !== name) };
    })
    .filter((task) => task.current.length !== task.next.length)
    .map((task) => db.prepare("UPDATE tasks SET labels = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(task.next), now, task.id));
  if (statements.length > 0) await db.batch(statements);

  return updateBoard(db, boardId, ownerId, { labels: labels.filter((label) => label.name !== name) });
}

export async function getBoardBySlug(db: D1, slug: string): Promise<BoardWithTasks | null> {
  const board = await db.prepare("SELECT * FROM boards WHERE share_slug = ? AND visibility = 'public'").bind(slug).first<Board>();
  if (!board) return null;

  const tasks = await db
    .prepare(`
    SELECT t.*, r.name as repository_name FROM tasks t
    LEFT JOIN repositories r ON t.repository_id = r.id
    WHERE t.board_id = ?
    ORDER BY
      CASE t.status WHEN 'todo' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'in_review' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
      CASE WHEN t.status = 'todo' THEN t.position END ASC,
      CASE WHEN t.status != 'todo' THEN t.updated_at END DESC
  `)
    .bind(board.id)
    .all<Task>();

  return parseBoard({ ...board, tasks: tasks.results.map(mapTaskRow) });
}

export async function countPublicBoardDoneTasks(db: D1, slug: string): Promise<number | null> {
  const row = await db
    .prepare(`
      SELECT COUNT(t.id) AS count
      FROM boards b
      LEFT JOIN tasks t ON t.board_id = b.id AND t.status = 'done'
      WHERE b.share_slug = ? AND b.visibility = 'public'
      GROUP BY b.id
    `)
    .bind(slug)
    .first<{ count: number }>();
  return row?.count ?? null;
}

export async function deleteBoard(db: D1, boardId: string, ownerId: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM boards WHERE id = ? AND owner_id = ?").bind(boardId, ownerId).run();
  return result.meta.changes > 0;
}
