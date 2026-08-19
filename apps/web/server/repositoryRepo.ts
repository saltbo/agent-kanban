import type { CreateRepositoryInput, Repository } from "@agent-kanban/shared";
import { HTTPException } from "hono/http-exception";
import { type D1, newId } from "./db";

/** Fork extension: absolute POSIX paths register as local repositories. */
export function isLocalRepoPath(url: string): boolean {
  return url.startsWith("/");
}

export function repoSourceType(url: string): "remote" | "local" {
  return isLocalRepoPath(url) ? "local" : "remote";
}

/**
 * Normalize git URL to canonical HTTPS form without .git suffix or trailing slash.
 * Accepts: https://host/owner/repo, http://host/owner/repo, git@host:owner/repo.
 * Fork extension: also accepts absolute local paths (e.g. /home/user/project),
 * which the daemon worktrees in place instead of cloning. Rejects everything else
 * (file://, ~-paths, relative paths, single-segment paths, unknown schemes) with
 * 400 — agents cannot invent URLs and the daemon must never see an unusable ref.
 */
export function normalizeGitUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (isLocalRepoPath(trimmed)) {
    if (trimmed.includes("\0")) {
      throw new HTTPException(400, { message: `Invalid local repository path "${url}"` });
    }
    // Canonicalize segment-by-segment: collapse "." and duplicates so
    // /home/u/repo, /home/u/./repo and /home/u//repo share one identity
    // (unique(owner_id,url) and the daemon's per-checkout mutex key on this
    // string). Only a literal ".." segment is rejected — "foo..bar" is fine.
    const segments = trimmed.split("/").filter((s) => s !== "" && s !== ".");
    if (segments.includes("..")) {
      throw new HTTPException(400, { message: `Invalid local repository path "${url}"` });
    }
    return `/${segments.join("/")}`;
  }
  const sshMatch = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2]}`;
  if (/^https?:\/\/[^/]+\/[^/]+\/.+/.test(trimmed)) {
    return trimmed.replace(/(?:\.git|\/)+$/, "");
  }
  throw new HTTPException(400, {
    message: `Invalid repository URL "${url}": only https://host/owner/repo, git@host:owner/repo, or an absolute local path (e.g. /home/you/project) are accepted`,
  });
}

/** Extract owner/repo from a canonicalized URL. Invariant: the URL has already passed normalizeGitUrl. */
function extractFullName(canonicalUrl: string): string {
  // Local repositories have no owner/repo form — the path itself is the identity.
  if (isLocalRepoPath(canonicalUrl)) return canonicalUrl;
  const match = canonicalUrl.match(/^https?:\/\/[^/]+\/(.+)$/);
  if (!match) {
    throw new HTTPException(500, {
      message: `Repository URL "${canonicalUrl}" has no owner/repo — data invariant broken (bypassed normalizeGitUrl)`,
    });
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
  const sourceType = repoSourceType(url);

  await db
    .prepare("INSERT INTO repositories (id, owner_id, name, url, created_at, source_type) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, ownerId, input.name, url, now, sourceType)
    .run();

  return withFullName({ id, owner_id: ownerId, name: input.name, url, created_at: now, source_type: sourceType });
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

export async function getRepository(db: D1, id: string, ownerId: string): Promise<Repository | null> {
  const row = await db.prepare("SELECT * FROM repositories WHERE id = ? AND owner_id = ?").bind(id, ownerId).first<Repository>();
  return row ? withFullName(row) : null;
}

export async function deleteRepository(db: D1, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM repositories WHERE id = ?").bind(id).run();
  return result.meta.changes > 0;
}

export function githubRepoRef(url: string) {
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!match) return null;
  return { type: "github_repository", owner: match[1], repo: match[2] };
}
