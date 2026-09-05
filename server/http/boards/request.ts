import { assertOptionalResourceString, assertRequiredResourceString, assertResourceWriteFields } from "@server/http/resource-server/request";
import type { BoardLabel } from "@shared";
import { HTTPException } from "hono/http-exception";

export interface BoardUpdate {
  name?: string;
  description?: string | null;
  visibility?: "private" | "public";
  labels?: BoardLabel[];
}

export function assertBoardUpdate(body: unknown): asserts body is BoardUpdate {
  assertResourceWriteFields(body, new Set(["name", "description", "visibility", "labels"]), "Board");
  if (body.name !== undefined) assertName(body, "Board");
  if (body.description !== null) assertOptionalResourceString(body, "description", "Board");
  if (body.visibility !== undefined && body.visibility !== "private" && body.visibility !== "public") {
    throw new HTTPException(422, { message: "Board.visibility must be private or public" });
  }
  if (body.labels !== undefined) {
    if (!Array.isArray(body.labels)) throw new HTTPException(422, { message: "Board.labels must be an array" });
    for (const label of body.labels) {
      assertBoardLabel(label);
    }
  }
}

export function assertBoardLabel(body: unknown, partial = false): asserts body is BoardLabel {
  assertResourceWriteFields(body, new Set(["name", "color", "description"]), "Board Label");
  if (!partial || body.name !== undefined) assertName(body, "Board Label");
  if (!partial || body.color !== undefined) assertRequiredResourceString(body, "color", "Board Label");
  assertOptionalResourceString(body, "description", "Board Label");
}

function assertName(body: Record<string, unknown>, resource: string): void {
  assertRequiredResourceString(body, "name", resource);
  if (!(body.name as string).trim()) throw new HTTPException(422, { message: `${resource}.name must not be blank` });
}
