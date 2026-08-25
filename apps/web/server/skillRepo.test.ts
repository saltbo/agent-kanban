// @vitest-environment node

import type { Skill } from "@agent-kanban/shared";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { assertValidSkillName, createSkill, deleteSkill, getSkill, getSkillByName, listSkills, updateSkill } from "./skillRepo";

interface SkillRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  body: string;
  created_at: string;
  updated_at: string;
}

class SkillsDb {
  rows = new Map<string, SkillRow>();
  statements: Array<{ sql: string; values: unknown[] }> = [];

  private assertNameUnique(ownerId: string, name: string, exceptId?: string): void {
    for (const row of this.rows.values()) {
      if (row.owner_id === ownerId && row.name === name && row.id !== exceptId) {
        throw new Error("UNIQUE constraint failed: skills.owner_id, skills.name");
      }
    }
  }

  prepare(sql: string) {
    let values: unknown[] = [];
    return {
      bind: (...bound: unknown[]) => {
        values = bound;
        this.statements.push({ sql, values: bound });
        return {
          run: async () => {
            if (sql.startsWith("INSERT INTO skills")) {
              const [id, ownerId, name, description, body, createdAt, updatedAt] = values.map(String);
              this.assertNameUnique(ownerId, name);
              this.rows.set(id, { id, owner_id: ownerId, name, description, body, created_at: createdAt, updated_at: updatedAt });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.startsWith("UPDATE skills")) {
              const [name, description, body, updatedAt, id, ownerId] = values.map(String);
              const existing = this.rows.get(id);
              if (!existing || existing.owner_id !== ownerId) return { success: true, meta: { changes: 0 } };
              this.assertNameUnique(existing.owner_id, name, id);
              this.rows.set(id, { ...existing, name, description, body, updated_at: updatedAt });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.startsWith("DELETE FROM skills")) {
              const [id, ownerId] = values.map(String);
              const existing = this.rows.get(id);
              if (existing && existing.owner_id === ownerId) {
                this.rows.delete(id);
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 0 } };
            }
            throw new Error(`Unexpected write: ${sql}`);
          },
          first: async <T>() => {
            if (sql.includes("WHERE id = ? AND owner_id = ?")) {
              const [id, ownerId] = values.map(String);
              const row = this.rows.get(id);
              return ((row && row.owner_id === ownerId ? row : null) as T) ?? null;
            }
            if (sql.includes("WHERE name = ? AND owner_id = ?")) {
              const [name, ownerId] = values.map(String);
              for (const row of this.rows.values()) {
                if (row.owner_id === ownerId && row.name === name) return row as T;
              }
              return null;
            }
            throw new Error(`Unexpected SELECT: ${sql}`);
          },
          all: async <T>() => {
            if (sql.includes("WHERE owner_id = ? ORDER BY name ASC")) {
              const ownerId = String(values[0]);
              const results = [...this.rows.values()].filter((row) => row.owner_id === ownerId).sort((a, b) => a.name.localeCompare(b.name));
              return { results: results as T[] };
            }
            throw new Error(`Unexpected SELECT: ${sql}`);
          },
        };
      },
    };
  }
}

const db = () => new SkillsDb() as unknown as Parameters<typeof createSkill>[0];

async function expectHttpError(promise: Promise<unknown>, status: number): Promise<void> {
  try {
    await promise;
    expect.unreachable("expected HTTPException");
  } catch (err) {
    expect(err).toBeInstanceOf(HTTPException);
    expect((err as HTTPException).status).toBe(status);
  }
}

describe("assertValidSkillName", () => {
  it("accepts letters, digits, dots, underscores and dashes", () => {
    expect(() => assertValidSkillName("ak-verify")).not.toThrow();
    expect(() => assertValidSkillName("my.skill_2")).not.toThrow();
    expect(() => assertValidSkillName("a")).not.toThrow();
  });

  it.each(["bad name", "-leading", "trailing-", ".dot", "x".repeat(65), ""])("rejects %s with 400", (name) => {
    try {
      assertValidSkillName(name);
      expect.unreachable("expected HTTPException");
    } catch (err) {
      expect(err).toBeInstanceOf(HTTPException);
      expect((err as HTTPException).status).toBe(400);
    }
  });
});

describe("skillRepo", () => {
  it("creates and reads back a skill by id and name", async () => {
    const database = db();
    const created = await createSkill(database, "owner-1", { name: "ak-verify", description: "Verify things", body: "# Verify\n" });
    expect(created.owner_id).toBe("owner-1");
    expect(created.name).toBe("ak-verify");

    const byId = await getSkill(database, created.id, "owner-1");
    expect(byId).toMatchObject({ id: created.id, name: "ak-verify", description: "Verify things", body: "# Verify\n" });

    const byName = await getSkillByName(database, "ak-verify", "owner-1");
    expect(byName?.id).toBe(created.id);
  });

  it("scopes reads by owner", async () => {
    const database = db();
    const created = await createSkill(database, "owner-1", { name: "ak-verify" });
    await expect(getSkill(database, created.id, "owner-2")).resolves.toBeNull();
    await expect(getSkillByName(database, "ak-verify", "owner-2")).resolves.toBeNull();
    await expect(listSkills(database, "owner-2")).resolves.toEqual([]);
  });

  it("lists skills ordered by name", async () => {
    const database = db();
    await createSkill(database, "owner-1", { name: "zeta" });
    await createSkill(database, "owner-1", { name: "alpha" });
    await createSkill(database, "owner-1", { name: "mid" });
    await createSkill(database, "owner-2", { name: "aaa" });

    const names = (await listSkills(database, "owner-1")).map((skill: Skill) => skill.name);
    expect(names).toEqual(["alpha", "mid", "zeta"]);
  });

  it("rejects a duplicate name for the same owner with 409", async () => {
    const database = db();
    await createSkill(database, "owner-1", { name: "ak-verify" });
    await expectHttpError(createSkill(database, "owner-1", { name: "ak-verify" }), 409);
    // Different owner may reuse the name.
    await expect(createSkill(database, "owner-2", { name: "ak-verify" })).resolves.toMatchObject({ owner_id: "owner-2" });
  });

  it("rejects invalid names on create with 400", async () => {
    await expectHttpError(createSkill(db(), "owner-1", { name: "bad name" }), 400);
    await expectHttpError(createSkill(db(), "owner-1", { name: "-leading" }), 400);
    await expectHttpError(createSkill(db(), "owner-1", { name: "x".repeat(65) }), 400);
  });

  it("rejects a non-string name on create with 400 instead of a TypeError", async () => {
    await expectHttpError(createSkill(db(), "owner-1", { name: 42 as unknown as string }), 400);
    await expectHttpError(createSkill(db(), "owner-1", { name: null as unknown as string }), 400);
  });

  it("rejects a whitespace-only name on create with 400", async () => {
    await expectHttpError(createSkill(db(), "owner-1", { name: "   " }), 400);
    await expectHttpError(createSkill(db(), "owner-1", { name: "\n\t " }), 400);
  });

  it("updates partial fields and bumps updated_at", async () => {
    const database = db();
    const created = await createSkill(database, "owner-1", { name: "ak-verify", description: "old", body: "old body" });

    const updated = await updateSkill(database, created.id, "owner-1", { description: "new" });
    expect(updated).toMatchObject({ name: "ak-verify", description: "new", body: "old body" });
    expect(updated!.updated_at >= created.updated_at).toBe(true);

    const renamed = await updateSkill(database, created.id, "owner-1", { name: "ak-verify-2", body: "new body" });
    expect(renamed).toMatchObject({ name: "ak-verify-2", description: "new", body: "new body" });
    await expect(getSkillByName(database, "ak-verify-2", "owner-1")).resolves.toMatchObject({ id: created.id });
  });

  it("returns null when updating a missing or foreign-owned skill", async () => {
    const database = db();
    const created = await createSkill(database, "owner-1", { name: "ak-verify" });
    await expect(updateSkill(database, "missing-id", "owner-1", { description: "x" })).resolves.toBeNull();
    await expect(updateSkill(database, created.id, "owner-2", { description: "x" })).resolves.toBeNull();
  });

  it("rejects a rename colliding with an existing name with 409", async () => {
    const database = db();
    await createSkill(database, "owner-1", { name: "taken" });
    const second = await createSkill(database, "owner-1", { name: "free" });
    await expectHttpError(updateSkill(database, second.id, "owner-1", { name: "taken" }), 409);
    // Original row unchanged after the failed rename.
    await expect(getSkill(database, second.id, "owner-1")).resolves.toMatchObject({ name: "free" });
  });

  it("rejects invalid names on update with 400", async () => {
    const database = db();
    const created = await createSkill(database, "owner-1", { name: "ak-verify" });
    await expectHttpError(updateSkill(database, created.id, "owner-1", { name: "bad name" }), 400);
  });

  it("rejects a whitespace-only or non-string name on update with 400", async () => {
    const database = db();
    const created = await createSkill(database, "owner-1", { name: "ak-verify" });
    await expectHttpError(updateSkill(database, created.id, "owner-1", { name: "   " }), 400);
    await expectHttpError(updateSkill(database, created.id, "owner-1", { name: 42 as unknown as string }), 400);
    // Original row unchanged after the rejected updates.
    await expect(getSkill(database, created.id, "owner-1")).resolves.toMatchObject({ name: "ak-verify" });
  });

  it("scopes the UPDATE statement by owner_id", async () => {
    const database = new SkillsDb();
    const d1 = database as unknown as Parameters<typeof createSkill>[0];
    const created = await createSkill(d1, "owner-1", { name: "ak-verify" });
    await updateSkill(d1, created.id, "owner-1", { description: "new" });

    const update = database.statements.find((s) => s.sql.startsWith("UPDATE skills"));
    expect(update?.sql).toContain("WHERE id = ? AND owner_id = ?");
    expect(update?.values.at(-2)).toBe(created.id);
    expect(update?.values.at(-1)).toBe("owner-1");
  });

  it("deletes only the owner's own skill", async () => {
    const database = db();
    const created = await createSkill(database, "owner-1", { name: "ak-verify" });

    await expect(deleteSkill(database, created.id, "owner-2")).resolves.toBe(false);
    await expect(getSkill(database, created.id, "owner-1")).resolves.not.toBeNull();

    await expect(deleteSkill(database, created.id, "owner-1")).resolves.toBe(true);
    await expect(getSkill(database, created.id, "owner-1")).resolves.toBeNull();
    await expect(deleteSkill(database, created.id, "owner-1")).resolves.toBe(false);
  });
});
