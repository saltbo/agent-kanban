import type { Repository } from "@agent-kanban/shared";
import type { D1 } from "./db";

type BoardRepository = Repository & { full_name: string };

function withFullName<T extends { url: string }>(repo: T): T & { full_name: string } {
  const match = repo.url.match(/^https?:\/\/[^/]+\/(.+)$/);
  return { ...repo, full_name: match?.[1] ?? repo.url };
}

export async function recordBoardRepository(db: D1, boardId: string, repositoryId: string): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO board_repositories (board_id, repository_id) VALUES (?, ?)").bind(boardId, repositoryId).run();
}

export async function listBoardRepositories(db: D1, ownerId: string, boardId: string): Promise<BoardRepository[]> {
  const result = await db
    .prepare(
      `
      SELECT r.*
      FROM board_repositories br
      JOIN boards b ON b.id = br.board_id AND b.owner_id = ?
      JOIN repositories r ON r.id = br.repository_id AND r.owner_id = b.owner_id
      WHERE br.board_id = ?
      ORDER BY r.created_at DESC
    `,
    )
    .bind(ownerId, boardId)
    .all<Repository>();
  return result.results.map(withFullName);
}
