import { countPublicBoardDoneTasks, getBoardBySlug } from "@server/adapters/d1/boardRepo";
import { getPublicBoardShareSummary } from "@server/adapters/d1/publicBoardRepo";
import { createPublicBoardSSEResponse } from "@server/adapters/stream/boardSSE";
import type { Env } from "@server/env";
import { escapeHtml, renderMetricBadge } from "@server/http/public/rendering";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerPublicRoutes(api: Hono<{ Bindings: Env }>): void {
  api.get("/api/share/:slug", getSharedBoard);
  api.get("/api/share/:slug/badge.svg", getSharedBoardBadge);
  api.get("/api/share/:slug/stream", streamSharedBoard);
  api.get("/api/sitemap.xml", getSitemap);
  api.get("/share/*", renderSharedBoardPage);
}

type PublicContext = Context<{ Bindings: Env }>;

async function getSharedBoard(c: PublicContext): Promise<Response> {
  const board = await getBoardBySlug(c.env.DB, shareSlug(c));
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  return c.json({
    ...board,
    tasks: board.tasks.map((task) => ({
      id: task.id,
      seq: task.seq,
      title: task.title,
      status: task.status,
      labels: task.labels,
      repository_name: task.repository_name,
      assignee_name: task.assignee_name,
      scheduled_at: task.scheduled_at,
      created_at: task.created_at,
      updated_at: task.updated_at,
    })),
  });
}

async function getSharedBoardBadge(c: PublicContext): Promise<Response> {
  const requestedType = c.req.query("type");
  if (requestedType !== undefined && requestedType !== "tasks") {
    throw new HTTPException(400, { message: 'Only the "tasks" badge is supported' });
  }
  const doneTasks = await countPublicBoardDoneTasks(c.env.DB, shareSlug(c));
  if (doneTasks === null) throw new HTTPException(404, { message: "Board not found" });
  return new Response(renderMetricBadge("AK", `${doneTasks} tasks`), {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=300" },
  });
}

function getSitemap(): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://agent-kanban.dev/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
</urlset>`;
  return new Response(xml, { headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" } });
}

async function streamSharedBoard(c: PublicContext): Promise<Response> {
  const board = await getBoardBySlug(c.env.DB, shareSlug(c));
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  return createPublicBoardSSEResponse(c.env, board.id);
}

async function renderSharedBoardPage(c: PublicContext): Promise<Response> {
  const slug = c.req.path.replace(/^\/share\/?/, "").replace(/\/$/, "");
  const asset = await c.env.ASSETS.fetch(new URL("/", c.req.url));
  const html = await asset.text();
  if (!slug) return htmlResponse(html);

  const board = await getPublicBoardShareSummary(c.env.DB, slug);
  if (!board) return htmlResponse(html);

  const title = `${escapeHtml(board.name)} — Agent Kanban`;
  const description = escapeHtml(
    board.description ||
      `${board.counts.total} tasks: ${board.counts.done} done, ${board.counts.inProgress} active, ${board.counts.inReview} review, ${board.counts.todo} todo`,
  );
  const url = `https://agent-kanban.dev/share/${slug}`;
  const metaTags = [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:site_name" content="Agent Kanban" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
  ].join("\n    ");
  return htmlResponse(html.replace(/<title>.*?<\/title>/, metaTags));
}

function htmlResponse(html: string): Response {
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function shareSlug(c: PublicContext): string {
  const slug = c.req.param("slug");
  if (!slug) throw new HTTPException(400, { message: "Share slug is required" });
  return slug;
}
