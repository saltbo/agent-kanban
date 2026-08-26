import { customAlphabet } from "nanoid";
import { ApiProblem } from "./contract";

const idSuffix = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 16);

export function newId(prefix: string): string {
  return `${prefix}_${idSuffix()}`;
}

export async function one<T>(statement: D1PreparedStatement, detail = "Resource not found."): Promise<T> {
  const row = await statement.first<T>();
  if (!row) throw new ApiProblem(404, "not-found", "Not Found", detail);
  return row;
}

export function publicRow<T extends Record<string, unknown>>(row: T, jsonFields: string[] = []): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const publicKey = jsonFields.includes(key) && key.endsWith("_json") ? key.slice(0, -5) : key;
    const camel = publicKey.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    result[camel] = key === "blocked" ? Boolean(value) : jsonFields.includes(key) && typeof value === "string" ? JSON.parse(value) : value;
  }
  return result;
}

export function isConstraintError(error: unknown): boolean {
  const text = String(error);
  return text.includes("UNIQUE constraint") || text.includes("FOREIGN KEY constraint") || text.includes("CHECK constraint");
}

export async function ping(db: D1Database): Promise<void> {
  await db.prepare("SELECT 1").first();
}
