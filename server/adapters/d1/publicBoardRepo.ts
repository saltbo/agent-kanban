export interface PublicBoardShareSummary {
  name: string;
  description: string | null;
  counts: {
    total: number;
    todo: number;
    inProgress: number;
    inReview: number;
    done: number;
  };
}

export async function getPublicBoardShareSummary(db: D1Database, slug: string): Promise<PublicBoardShareSummary | null> {
  const board = await db
    .prepare("SELECT name, description FROM boards WHERE share_slug = ? AND visibility = 'public'")
    .bind(slug)
    .first<{ name: string; description: string | null }>();
  if (!board) return null;

  const counts = await db
    .prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as todo,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'in_review' THEN 1 ELSE 0 END) as in_review,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done
      FROM tasks t
      JOIN boards b ON t.board_id = b.id
      WHERE b.share_slug = ?
    `)
    .bind(slug)
    .first<{ total: number; todo: number; in_progress: number; in_review: number; done: number }>();

  return {
    ...board,
    counts: {
      total: counts?.total ?? 0,
      todo: counts?.todo ?? 0,
      inProgress: counts?.in_progress ?? 0,
      inReview: counts?.in_review ?? 0,
      done: counts?.done ?? 0,
    },
  };
}
