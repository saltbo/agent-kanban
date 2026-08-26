import type { CreateSubagentInput, Subagent } from "@agent-kanban/shared";
import { type D1, newLongId, parseJsonFields } from "./db";

const parseSubagent = <T extends Subagent>(row: T) => parseJsonFields(row, ["models", "skills"]);

export async function createSubagent(db: D1, ownerId: string, input: CreateSubagentInput): Promise<Subagent> {
  const now = new Date().toISOString();
  const subagent: Subagent = {
    id: newLongId(),
    owner_id: ownerId,
    name: input.name || input.username,
    username: input.username,
    bio: input.bio ?? null,
    soul: input.soul ?? null,
    role: input.role ?? null,
    models: input.models ?? null,
    skills: input.skills ?? null,
    created_at: now,
    updated_at: now,
  };
  await db
    .prepare(`
      INSERT INTO subagents (id, owner_id, name, username, bio, soul, role, models, skills, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      subagent.id,
      ownerId,
      subagent.name,
      subagent.username,
      subagent.bio,
      subagent.soul,
      subagent.role,
      subagent.models ? JSON.stringify(subagent.models) : null,
      subagent.skills ? JSON.stringify(subagent.skills) : null,
      now,
      now,
    )
    .run();
  return subagent;
}

export async function listSubagents(db: D1, ownerId: string): Promise<Subagent[]> {
  const result = await db
    .prepare(
      "SELECT id, owner_id, name, username, bio, soul, role, models, skills, created_at, updated_at FROM subagents WHERE owner_id = ? ORDER BY created_at DESC",
    )
    .bind(ownerId)
    .all<Subagent>();
  return result.results.map(parseSubagent);
}

export async function getSubagent(db: D1, subagentId: string, ownerId: string): Promise<Subagent | null> {
  const row = await db
    .prepare(
      "SELECT id, owner_id, name, username, bio, soul, role, models, skills, created_at, updated_at FROM subagents WHERE id = ? AND owner_id = ?",
    )
    .bind(subagentId, ownerId)
    .first<Subagent>();
  return row ? parseSubagent(row) : null;
}

export async function updateSubagent(
  db: D1,
  subagentId: string,
  ownerId: string,
  updates: Partial<Pick<Subagent, "name" | "bio" | "soul" | "role" | "models" | "skills">>,
): Promise<Subagent | null> {
  const existing = await getSubagent(db, subagentId, ownerId);
  if (!existing) return null;

  const now = new Date().toISOString();
  const sets: string[] = ["updated_at = ?"];
  const binds: unknown[] = [now];
  const jsonFields = new Set(["models", "skills"]);
  const fields = ["name", "bio", "soul", "role", "models", "skills"] as const;
  for (const field of fields) {
    if (field in updates && updates[field] !== undefined) {
      sets.push(`${field} = ?`);
      const value = updates[field];
      binds.push(jsonFields.has(field) && value != null ? JSON.stringify(value) : value);
    }
  }

  binds.push(subagentId, ownerId);
  await db
    .prepare(`UPDATE subagents SET ${sets.join(", ")} WHERE id = ? AND owner_id = ?`)
    .bind(...binds)
    .run();
  return getSubagent(db, subagentId, ownerId);
}

export async function deleteSubagent(db: D1, subagentId: string, ownerId: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM subagents WHERE id = ? AND owner_id = ?").bind(subagentId, ownerId).run();
  return result.meta.changes > 0;
}
