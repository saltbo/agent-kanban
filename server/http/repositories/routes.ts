import { getBoard } from "@server/adapters/d1/boardRepo";
import { createRepository, deleteRepository, getRepository, listRepositoryPage, normalizeGitUrl } from "@server/adapters/d1/repositoryRepo";
import { repoAppStatus, repoAppStatusBatch } from "@server/adapters/github/githubInstallations";
import { authorizeScope } from "@server/auth/middleware";
import type { Env } from "@server/env";
import { pageResponse, readPageWindow } from "@server/http/resource-server/pagination";
import { repositoryResource } from "@server/http/resource-server/representation";
import {
  assertRequiredResourceString,
  assertResourceWriteFields,
  readJsonBody,
  setCreatedResourceHeaders,
} from "@server/http/resource-server/request";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerRepositoryRoutes(api: Hono<{ Bindings: Env }>): void {
  api.post("/api/repositories", authorizeScope("repository:write"), async (c) => {
    const body = await readJsonBody<{ name: string; url: string }>(c);
    if (body instanceof Response) return body;
    assertResourceWriteFields(body, new Set(["name", "url"]), "Repository");
    assertRequiredResourceString(body, "name", "Repository");
    assertRequiredResourceString(body, "url", "Repository");
    if (!body.name || !body.url) throw new HTTPException(400, { message: "name and url are required" });
    const ownerId = c.get("ownerId");
    const fullName = new URL(normalizeGitUrl(body.url)).pathname.replace(/^\//, "");
    const appStatus = await repoAppStatus(c.env.DB, ownerId, fullName);
    const repository = await createRepository(c.env.DB, ownerId, body);
    setCreatedResourceHeaders(c, "repositories", repository.id, repository.id);
    return c.json(repositoryResource({ ...repository, app_status: appStatus }, c.req.url), 201);
  });

  api.get("/api/repositories", authorizeScope("repository:read"), async (c) => {
    const ownerId = c.get("ownerId");
    const query = c.req.query();
    const boardId = query.boardId;
    if (boardId && !(await getBoard(c.env.DB, boardId, ownerId))) {
      throw new HTTPException(404, { message: "Board not found" });
    }
    const window = await readPageWindow(c);
    if (window instanceof Response) return window;
    const repositories = await listRepositoryPage(c.env.DB, ownerId, window, { url: query.url, boardId });
    const statuses = await repositoryStatuses(c.env.DB, ownerId, repositories);
    return pageResponse(
      c,
      repositories.map((repository) => ({ ...repository, app_status: statuses.get(repository.full_name) })),
      window,
      repositoryResource,
    );
  });

  api.get("/api/repositories/:id", authorizeScope("repository:read"), async (c) => {
    const ownerId = c.get("ownerId");
    const repository = await getRepository(c.env.DB, c.req.param("id")!, ownerId);
    if (!repository) throw new HTTPException(404, { message: "Repository not found" });
    const represented = { ...repository, app_status: await repoAppStatus(c.env.DB, ownerId, repository.full_name) };
    c.header("ETag", `"${repository.id}"`);
    return c.json(repositoryResource(represented, c.req.url));
  });

  api.delete("/api/repositories/:id", authorizeScope("repository:write"), async (c) => {
    const ownerId = c.get("ownerId");
    const repository = await getRepository(c.env.DB, c.req.param("id")!, ownerId);
    if (!repository) throw new HTTPException(404, { message: "Repository not found" });
    await deleteRepository(c.env.DB, repository.id, ownerId);
    return c.json({ ok: true });
  });
}

function repositoryStatuses(db: D1Database, ownerId: string, repositories: Array<{ full_name: string }>) {
  return repoAppStatusBatch(
    db,
    ownerId,
    repositories.map((repository) => repository.full_name),
  );
}
