import { type D1, newId } from "@server/db";
import type { PageWindow } from "@server/domain/pagination";
import { ApplicationError } from "@server/usecases/applicationError";
import type { CreateRepositoryInput, Repository } from "@shared";

/**
 * Normalize git URL to canonical HTTPS form without .git suffix or trailing slash.
 * Accepts: https://host/owner/repo, http://host/owner/repo, git@host:owner/repo.
 * Rejects everything else (file://, local paths, single-segment paths, unknown schemes)
 * with 400 — agents cannot invent URLs, users cannot paste local paths, and the daemon
 * must never see an un-cloneable URL.
 */
export function normalizeGitUrl(url: string): string {
  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2]}`;
  if (/^https?:\/\/[^/]+\/[^/]+\/.+/.test(url)) {
    return url.replace(/(?:\.git|\/)+$/, "");
  }
  throw new ApplicationError(
    "invalid-request",
    `Invalid repository URL "${url}": only https://host/owner/repo, http://host/owner/repo, or git@host:owner/repo are accepted`,
  );
}

/** Extract owner/repo from a canonicalized URL. Invariant: the URL has already passed normalizeGitUrl. */
function extractFullName(canonicalUrl: string): string {
  const match = canonicalUrl.match(/^https?:\/\/[^/]+\/(.+)$/);
  if (!match) {
    throw new ApplicationError(
      "invariant-failed",
      `Repository URL "${canonicalUrl}" has no owner/repo — data invariant broken (bypassed normalizeGitUrl)`,
    );
  }
  return match[1];
}

function withFullName<T extends { url: string }>(repo: T): T & { full_name: string } {
  return { ...repo, full_name: extractFullName(repo.url) };
}

export async function createRepository(db: D1, ownerId: string, input: CreateRepositoryInput): Promise<Repository> {
  const id = newId();
  const now = new Date().toISOString();
  const url = normalizeGitUrl(input.url);
  const repository = withFullName({ id, owner_id: ownerId, name: input.name, url, created_at: now });

  const insertion = db
    .prepare("INSERT INTO repositories (id, owner_id, name, url, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, ownerId, input.name, url, now);
  await insertion.run();

  return repository;
}

export async function findOrCreateRepository(db: D1, ownerId: string, input: CreateRepositoryInput): Promise<Repository> {
  const url = normalizeGitUrl(input.url);
  try {
    return await createRepository(db, ownerId, input);
  } catch (err) {
    const isUniqueViolation = err instanceof Error && err.message.includes("UNIQUE constraint failed");
    if (!isUniqueViolation) throw err;
  }
  const existing = await db.prepare("SELECT * FROM repositories WHERE owner_id = ? AND url = ?").bind(ownerId, url).first<Repository>();
  if (existing) return withFullName(existing);
  throw new Error("Failed to create or find repository");
}

export async function listRepositories(db: D1, ownerId: string, filters?: { url?: string }): Promise<Repository[]> {
  let query = `
    SELECT r.*, COUNT(t.id) as task_count
    FROM repositories r
    LEFT JOIN tasks t ON t.repository_id = r.id
    WHERE r.owner_id = ?`;
  const binds: string[] = [ownerId];

  if (filters?.url) {
    query += " AND r.url = ?";
    binds.push(normalizeGitUrl(filters.url));
  }

  query += " GROUP BY r.id ORDER BY r.created_at DESC";
  const result = await db
    .prepare(query)
    .bind(...binds)
    .all<Repository>();
  return result.results.map(withFullName);
}

export async function listRepositoryPage(
  db: D1,
  ownerId: string,
  window: PageWindow,
  filters?: { url?: string; boardId?: string },
): Promise<Repository[]> {
  let query = `
    SELECT r.*, COUNT(t.id) as task_count
    FROM repositories r
    LEFT JOIN tasks t ON t.repository_id = r.id
    WHERE r.owner_id = ? AND r.created_at <= ?`;
  const binds: unknown[] = [ownerId, window.snapshot];
  if (filters?.url) {
    query += " AND r.url = ?";
    binds.push(normalizeGitUrl(filters.url));
  }
  if (filters?.boardId) {
    query += " AND EXISTS (SELECT 1 FROM board_repositories br WHERE br.repository_id = r.id AND br.board_id = ?)";
    binds.push(filters.boardId);
  }
  if (window.afterCreatedAt && window.afterId) {
    query += " AND (r.created_at < ? OR (r.created_at = ? AND r.id < ?))";
    binds.push(window.afterCreatedAt, window.afterCreatedAt, window.afterId);
  }
  query += " GROUP BY r.id ORDER BY r.created_at DESC, r.id DESC LIMIT ?";
  binds.push(window.pageSize + 1);
  const result = await db
    .prepare(query)
    .bind(...binds)
    .all<Repository>();
  return result.results.map(withFullName);
}

export async function getRepository(db: D1, id: string, ownerId: string): Promise<Repository | null> {
  const row = await db.prepare("SELECT * FROM repositories WHERE id = ? AND owner_id = ?").bind(id, ownerId).first<Repository>();
  return row ? withFullName(row) : null;
}

export async function deleteRepository(db: D1, id: string, ownerId: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM repositories WHERE id = ? AND owner_id = ?").bind(id, ownerId).run();
  return result.meta.changes > 0;
}

export function githubRepoRef(url: string) {
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!match) return null;
  return { type: "github_repository", owner: match[1], repo: match[2] };
}
