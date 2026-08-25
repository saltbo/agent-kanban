import type { Skill } from "@agent-kanban/shared";
import { HTTPException } from "hono/http-exception";
import { type D1, newId } from "./db";

const SKILL_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;

export function assertValidSkillName(name: string): void {
  if (!SKILL_NAME_RE.test(name) || name.length > 64) {
    throw new HTTPException(400, {
      message: `Invalid skill name "${name}": use letters, digits, dots, underscores and dashes (max 64 chars)`,
    });
  }
}

export async function createSkill(db: D1, ownerId: string, input: { name: string; description?: string; body?: string }): Promise<Skill> {
  if (typeof input.name !== "string" || !input.name.trim()) {
    throw new HTTPException(400, { message: "name is required" });
  }
  const name = input.name.trim();
  assertValidSkillName(name);
  const id = newId();
  const now = new Date().toISOString();
  try {
    await db
      .prepare("INSERT INTO skills (id, owner_id, name, description, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, ownerId, name, input.description ?? "", input.body ?? "", now, now)
      .run();
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      throw new HTTPException(409, { message: `Skill "${name}" already exists` });
    }
    throw err;
  }
  return { id, owner_id: ownerId, name, description: input.description ?? "", body: input.body ?? "", created_at: now, updated_at: now };
}

export async function listSkills(db: D1, ownerId: string): Promise<Skill[]> {
  const result = await db.prepare("SELECT * FROM skills WHERE owner_id = ? ORDER BY name ASC").bind(ownerId).all<Skill>();
  return result.results;
}

export async function getSkill(db: D1, id: string, ownerId: string): Promise<Skill | null> {
  return await db.prepare("SELECT * FROM skills WHERE id = ? AND owner_id = ?").bind(id, ownerId).first<Skill>();
}

export async function getSkillByName(db: D1, name: string, ownerId: string): Promise<Skill | null> {
  return await db.prepare("SELECT * FROM skills WHERE name = ? AND owner_id = ?").bind(name, ownerId).first<Skill>();
}

export async function updateSkill(
  db: D1,
  id: string,
  ownerId: string,
  input: { name?: string; description?: string; body?: string },
): Promise<Skill | null> {
  const existing = await getSkill(db, id, ownerId);
  if (!existing) return null;
  if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim())) {
    throw new HTTPException(400, { message: "name must be a non-empty string" });
  }
  const name = input.name !== undefined ? input.name.trim() : existing.name;
  assertValidSkillName(name);
  const now = new Date().toISOString();
  try {
    await db
      .prepare("UPDATE skills SET name = ?, description = ?, body = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
      .bind(name, input.description ?? existing.description, input.body ?? existing.body, now, id, ownerId)
      .run();
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      throw new HTTPException(409, { message: `Skill "${name}" already exists` });
    }
    throw err;
  }
  return { ...existing, name, description: input.description ?? existing.description, body: input.body ?? existing.body, updated_at: now };
}

export async function deleteSkill(db: D1, id: string, ownerId: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM skills WHERE id = ? AND owner_id = ?").bind(id, ownerId).run();
  return result.meta.changes > 0;
}
