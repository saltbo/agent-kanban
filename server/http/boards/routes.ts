import {
  createBoard,
  createBoardLabel,
  deleteBoard,
  deleteBoardLabel,
  getBoard,
  getBoardByName,
  listBoardPage,
  listBoards,
  updateBoard,
  updateBoardLabel,
} from "@server/adapters/d1/boardRepo";
import { createBoardSSEResponse } from "@server/adapters/stream/boardSSE";
import type { Env } from "@server/env";
import { pageResponse, readPageWindow } from "@server/http/resource-server/pagination";
import { boardResource } from "@server/http/resource-server/representation";
import {
  assertOptionalResourceString,
  assertRequiredResourceString,
  assertResourceWriteFields,
  isResourcePrincipal,
  readJsonBody,
  resourceIdempotencyFor,
  setCreatedResourceHeaders,
} from "@server/http/resource-server/request";
import { type BoardLabel, isBoardType } from "@shared";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerBoardRoutes(api: Hono<{ Bindings: Env }>): void {
  api.post("/api/boards", async (c) => {
    const body = await readJsonBody<{ name: string; description?: string; type: string }>(c);
    if (body instanceof Response) return body;
    if (isResourcePrincipal(c)) {
      assertResourceWriteFields(body, new Set(["name", "description", "type"]), "Board");
      assertRequiredResourceString(body, "name", "Board");
      assertOptionalResourceString(body, "description", "Board");
    }
    if (!body.name) throw new HTTPException(400, { message: "name is required" });
    if (!isBoardType(body.type)) throw new HTTPException(400, { message: "type must be 'dev' or 'ops'" });
    const board = await createBoard(
      c.env.DB,
      c.get("ownerId"),
      body.name,
      body.type,
      body.description,
      resourceIdempotencyFor(
        c,
        "boards",
        (resource) => resource.updated_at,
        (resource) => boardResource(resource, c.req.url),
      ),
    );
    if (isResourcePrincipal(c)) {
      setCreatedResourceHeaders(c, "boards", board.id, board.updated_at);
      return c.json(boardResource(board, c.req.url), 201);
    }
    return c.json(board, 201);
  });

  api.get("/api/boards", async (c) => {
    const ownerId = c.get("ownerId");
    const name = c.req.query("name");
    if (isResourcePrincipal(c)) {
      const window = await readPageWindow(c);
      if (window instanceof Response) return window;
      return pageResponse(c, await listBoardPage(c.env.DB, ownerId, window, name), window, boardResource);
    }
    if (name) {
      const board = await getBoardByName(c.env.DB, ownerId, name);
      if (!board) throw new HTTPException(404, { message: "Board not found" });
      return c.json(board);
    }
    return c.json(await listBoards(c.env.DB, ownerId));
  });

  api.get("/api/boards/:id", async (c) => {
    const board = await getBoard(c.env.DB, c.req.param("id"), c.get("ownerId"));
    if (!board) throw new HTTPException(404, { message: "Board not found" });
    if (isResourcePrincipal(c)) {
      c.header("ETag", `"${board.updated_at}"`);
      return c.json(boardResource(board, c.req.url));
    }
    return c.json(board);
  });

  api.patch("/api/boards/:id", async (c) => {
    const body = await c.req.json<{ name?: string; description?: string; visibility?: "private" | "public"; labels?: BoardLabel[] }>();
    const board = await updateBoard(c.env.DB, c.req.param("id"), c.get("ownerId"), body);
    if (!board) throw new HTTPException(404, { message: "Board not found" });
    return c.json(board);
  });

  api.delete("/api/boards/:id", async (c) => {
    if (!(await deleteBoard(c.env.DB, c.req.param("id"), c.get("ownerId")))) {
      throw new HTTPException(404, { message: "Board not found" });
    }
    return c.json({ ok: true });
  });

  api.post("/api/boards/:id/labels", async (c) => {
    const body = await c.req.json<{ name: string; color: string; description?: string }>();
    const board = await createBoardLabel(c.env.DB, c.req.param("id"), c.get("ownerId"), {
      name: body.name,
      color: body.color,
      description: body.description || "",
    });
    if (!board) throw new HTTPException(404, { message: "Board not found" });
    return c.json(board, 201);
  });

  api.patch("/api/boards/:id/labels/:name", async (c) => {
    const body = await c.req.json<{ name?: string; color?: string; description?: string }>();
    const board = await updateBoardLabel(c.env.DB, c.req.param("id"), c.get("ownerId"), c.req.param("name"), body);
    if (!board) throw new HTTPException(404, { message: "Board not found" });
    return c.json(board);
  });

  api.delete("/api/boards/:id/labels/:name", async (c) => {
    const board = await deleteBoardLabel(c.env.DB, c.req.param("id"), c.get("ownerId"), c.req.param("name"));
    if (!board) throw new HTTPException(404, { message: "Board not found" });
    return c.json(board);
  });

  api.get("/api/boards/:id/stream", (c) => createBoardSSEResponse(c.env, c.req.param("id"), c.get("ownerId")));
}
